import { App, Assistant } from "@slack/bolt"
import type { AnyChunk } from "@slack/types"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { chdir } from "node:process"

import { DATA_DIR } from "./types"
import { STAGING_ROOT, stagingDirFor } from "./paths"
import type { PromptInput, SlackClient } from "./types"
import type { IncomingAttachment } from "./types"
import { SessionStore } from "./session"
import { startEventLoop } from "./events"
import { safeStreamAction, postAssistantResponse } from "./slack"
import { settings, blockedUsers, isBlockedUser } from "./settings"

chdir(DATA_DIR)

const app = new App({
  token: settings.SLACK_BOT_TOKEN,
  signingSecret: settings.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: settings.SLACK_APP_TOKEN,
})

console.log("Bot configuration:")
console.log("- Bot token present:", !!settings.SLACK_BOT_TOKEN)
console.log("- Signing secret present:", !!settings.SLACK_SIGNING_SECRET)
console.log("- App token present:", !!settings.SLACK_APP_TOKEN)
console.log("- Blocked users:", blockedUsers.size === 0 ? "(none)" : [...blockedUsers].join(", "))
console.log("- Reply broadcast:", settings.REPLY_BROADCAST)
console.log("- Restrict to workspace:", settings.RESTRICT_TO_WORKSPACE)

// When RESTRICT_TO_WORKSPACE is enabled, resolve the bot's own workspace team id
// at startup and reject any request from a user in a different workspace.
let workspaceTeamId: string | undefined
if (settings.RESTRICT_TO_WORKSPACE) {
  try {
    const auth = await app.client.auth.test()
    workspaceTeamId = auth.team_id as string
    console.log(`- Workspace team id: ${workspaceTeamId}`)
  } catch (e) {
    console.error("Failed to fetch workspace team id; workspace restriction disabled:", e)
  }
}

function isUnauthorized(userId: string | undefined, userTeamId: string | undefined): boolean {
  if (isBlockedUser(userId)) return true
  return !!workspaceTeamId && !!userTeamId && userTeamId !== workspaceTeamId
}

// The bot talks to the shared OpenCode service over HTTP. `Service.ensure()`
// discovers the background service or starts one (`opencode serve --service`)
// as a separate process, so the TUI (`opencode`) and `opencode api` can attach
// to the same server for debugging.
const systemPrompt = `
You are a chatbot running on slack that answers questions for the user. Your chain-of-thought and tool cools are passed
ephemerally to slack, and the final answer you give is what the user sees.

You must ensure that your final answer contains the full detail of everything you wish to send to the user; including
any charts, files, other information or analysis.

# Creating a visualization

When a user requests a chart or visualization, or when a visualization would clearly enhance the answer (e.g. trends over
time, comparisons across categories), include a Vega-Lite v6 specification wrapped in \`<vega-lite>...</vega-lite>\` tags
in your response. The Slack harness will render it to a PNG image and attach it to the thread automatically.

Guidelines:
- Choose appropriate chart types: line charts for time series, bar charts for categories, scatter for correlations
- Embed the query result data directly in the spec's \`data.values\` field (keep to a reasonable number of data points -- pre-aggregate if needed)
- Set \`width\` and \`height\` (e.g. 1200x800) for readable charts
- Use clear axis labels and a descriptive title
- CRITICAL: Do NOT use \`format\` on temporal axes (type: "temporal"). Vega-Lite uses d3-format (number formatting) for the \`format\` property, which will crash on time-like strings like "00:00" or "HH:MM". For temporal fields, use \`timeUnit\` (e.g. "hoursminutes", "yearmonthdate") to bin the data, and let Vega-Lite format the axis labels automatically. If you need custom time formatting, use \`axis.format\` with a d3-time-format string like \`"%H:%M"\` — NOT a raw time literal.

Example:

<vega-lite>
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "Daily Active Users (Last 7 Days)",
  "width": 1200,
  "height": 800,
  "data": {
    "values": [
      {"date": "2026-04-10", "users": 12000},
      {"date": "2026-04-11", "users": 13500}
    ]
  },
  "mark": "line",
  "encoding": {
    "x": {"field": "date", "type": "temporal", "axis": {"title": "Date"}},
    "y": {"field": "users", "type": "quantitative", "axis": {"title": "Users"}}
  }
}
</vega-lite>

Do NOT generate charts when the data is a single number or a very simple answer that doesn't benefit from visualization.
`

/**
 * The session-scoped part of the system prompt. OpenCode V2 assembles instructions
 * from several sources; API-managed entries are appended after the agent system
 * prompt and AGENTS.md. We register this once per session (at session begin) so
 * the scratch directory is in the system prompt rather than repeated before every
 * message round.
 */
function buildSessionInstructions(scratchDir: string): string {
  let text = `
# Session scratch directory

Your session scratch directory is:

${scratchDir}

Write large command output there (eg piped from a shell command) instead of returning it inline. That directory is the
only location outside the workspace you are allowed to write to; do not attempt to write anywhere else (such as
\`/tmp\` directly).
`

  // Only teach the agent to send files when the feature is enabled.
  if (settings.SEND_FILE_MAX_SIZE > 0) {
    text += `
To send a file back to the user in Slack, write it into your session scratch directory and then include a directive in
your final answer:

<slack-file>
{"path": "<absolute path inside your session scratch directory>", "title": "Optional title", "comment": "Optional message posted with the file"}
</slack-file>

The harness uploads the file to the Slack thread and removes the directive from your answer. Use the exact absolute
path and keep the file inside the session scratch directory; any path outside it is rejected. Use one directive per
file. You do not need to post the file contents inline.
`
  }

  return text
}

console.log("Starting opencode service...")
const endpoint = await Service.ensure({
  // Highest-priority inline config layer: replace OpenCode's built-in system
  // prompt with our own so this and AGENTS.md are the only system instructions.
  env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { build: { system: systemPrompt } } }) },
  onStart: (reason, previousVersion) =>
    console.log(`- starting OpenCode service (${reason}${previousVersion ? `, replacing ${previousVersion}` : ""})`),
})
const opencode = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
console.log(`Opencode service ready at ${endpoint.url}`)

const store = new SessionStore()
const restored = store.restore()
console.log(`Restored ${restored} session(s) from database`)

// Start the global event loop (runs in background)
startEventLoop(opencode, app.client, store)

// ─── Shared prompt logic ──────────────────────────────────────────

/**
 * Per-thread run queue. Each prompt appends a link to its thread's chain and
 * waits for the previous one, so terminal OpenCode events from an older run can
 * never be mistaken for the current one.
 */
const runQueue = new Map<string, Promise<void>>()

function sanitizeFileName(name: string): string {
  const base = basename(name)
  return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment"
}

/** Extract plain text from a Slack rich_text block element (recursively). */
function extractBlockText(block: any): string {
  if (typeof block === "string") return block
  if (block.type === "raw_text" && typeof block.text === "string") return block.text
  if (block.type === "text" && typeof block.text === "string") return block.text
  if (block.elements) return block.elements.map(extractBlockText).join("")
  return ""
}

/**
 * Extract table data from Slack attachments.
 * Slack sends pasted tables as attachments containing `type: "table"` blocks.
 * Each table block has a `rows` array of arrays of rich_text/raw_text cells.
 * Returns the tables formatted as CSV text.
 */
function extractTablesFromAttachments(attachments: any[] | undefined): string[] {
  if (!attachments?.length) return []
  const tables: string[] = []
  for (const att of attachments) {
    if (!att.blocks) continue
    for (const block of att.blocks) {
      if (block.type !== "table" || !Array.isArray(block.rows)) continue
      const csvRows: string[] = []
      for (const row of block.rows) {
        const cells = row.map((cell: any) => {
          const text = extractBlockText(cell).trim()
          // Quote cells that contain commas or quotes
          if (text.includes(",") || text.includes('"')) {
            return `"${text.replace(/"/g, '""')}"`
          }
          return text
        })
        csvRows.push(cells.join(","))
      }
      if (csvRows.length > 0) {
        tables.push(csvRows.join("\n"))
      }
    }
  }
  return tables
}

type StagedFile = { path: string }

/** How long an idle session's staged files are kept before being swept. */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Remove staged uploads older than `STAGING_TTL_MS`, and any session directory
 * left empty. Uploads are not deleted when a run ends because the agent may
 * `read` only part of a file, or re-read it in a later turn, so we cannot know
 * when it is done.
 */
async function sweepStaleStaging(): Promise<void> {
  let sessions
  try {
    sessions = await readdir(STAGING_ROOT, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("Failed to scan attachment staging root:", error)
    }
    return
  }

  const cutoff = Date.now() - STAGING_TTL_MS
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const dir = join(STAGING_ROOT, session.name)

    let files
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      console.error(`Failed to scan staging directory ${dir}:`, error)
      continue
    }

    let remaining = 0
    for (const file of files) {
      const path = join(dir, file.name)
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true })
          console.log(`Removed stale staged upload ${path}`)
        } else {
          remaining++
        }
      } catch (error) {
        console.error(`Failed to sweep staged upload ${path}:`, error)
      }
    }

    if (remaining === 0) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        console.error(`Failed to remove empty staging directory ${dir}:`, error)
      }
    }
  }
}

/**
 * No matter what user permissions there were, allow session's external-directory access to its own staging directory.
 */
function sessionPermissions(sessionId: string) {
  const dir = stagingDirFor(sessionId)
  return [
    { action: "external_directory", resource: dir, effect: "allow" as const },
    { action: "external_directory", resource: `${dir}/**`, effect: "allow" as const },
  ]
}

/** Sessions whose per-session permissions have already been applied this process. */
const permissionsConfigured = new Set<string>()

async function ensureSessionPermissions(sessionId: string): Promise<void> {
  if (permissionsConfigured.has(sessionId)) return
  try {
    await opencode.session.update({ sessionID: sessionId, permissions: sessionPermissions(sessionId) })
    permissionsConfigured.add(sessionId)
  } catch (error) {
    // Non-fatal for the rest of the bot, but note the global config denies
    // external_directory (*), so without this allow entry the agent cannot
    // read or write its own scratch directory.
    console.error(`Failed to restrict external access for session ${sessionId}:`, error)
  }
}

/** Sessions whose per-session system instructions have already been registered this process. */
const instructionsConfigured = new Set<string>()

/**
 * Attach the session's scratch directory to its system prompt through OpenCode's
 * session-scoped instruction entries (the V2 replacement for the old per-prompt
 * `system` field). This is set once per session at session begin; changes apply
 * at the next step boundary and persist for the life of the session, so it is
 * no longer repeated before every message.
 */
async function ensureSessionInstructions(sessionId: string, scratchDir: string): Promise<void> {
  if (instructionsConfigured.has(sessionId)) return
  try {
    await opencode.session.instructions.entry.put({
      sessionID: sessionId,
      key: "slack.session",
      value: buildSessionInstructions(scratchDir),
    })
    instructionsConfigured.add(sessionId)
  } catch (error) {
    // Non-fatal: the agent just won't be told its scratch directory.
    console.error(`Failed to set session instructions for ${sessionId}:`, error)
  }
}

/**
 * Download Slack uploads into the session's staging directory. Files are kept
 * on disk (and swept by TTL) so the agent can read them — fully, partially, or
 * again in a later turn — with the `read` tool.
 */
async function stageAttachments(
  files: IncomingAttachment[] | undefined,
  client: SlackClient,
  dir: string,
): Promise<StagedFile[]> {
  if (!files?.length) return []

  const token = settings.SLACK_BOT_TOKEN
  if (!token) {
    console.error("Cannot download attachments: SLACK_BOT_TOKEN is not set")
    return []
  }

  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    console.error(`Failed to create attachment staging directory ${dir}:`, error)
    return []
  }

  const staged: StagedFile[] = []

  for (const file of files) {
    console.log(`File object for "${file.name}":`, JSON.stringify({
      id: (file as any).id,
      url_private: file.url_private,
      url_private_download: file.url_private_download,
      permalink: (file as any).permalink,
      permalink_public: (file as any).permalink_public,
      mimetype: file.mimetype,
      filetype: file.filetype,
    }))
    if (!file.url_private && !file.url_private_download) continue

    try {
      // Use files.info to get a fresh URL, then download with the Authorization header.
      // Direct fetch of url_private with ?token= query param returns 404 for files-pri URLs,
      // and the Authorization header approach loses auth across redirects.
      // The Bolt client's files.info call is authenticated and returns a fresh url_private.
      let downloadUrl = file.url_private || file.url_private_download!
      if ((file as any).id) {
        try {
          const info = await client.files.info({ file: (file as any).id })
          const fresh = (info.file as any)?.url_private_download || (info.file as any)?.url_private
          if (fresh) downloadUrl = fresh
        } catch (e) {
          console.warn(`files.info failed for "${file.name}", using original URL:`, e)
        }
      }
      console.log(`Downloading "${file.name}" from: ${downloadUrl}`)
      const response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const ct = response.headers.get("content-type") || ""
      console.log(`Response for "${file.name}": HTTP ${response.status}, Content-Type: ${ct}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (ct.includes("text/html")) {
        throw new Error(`Got HTML page instead of file content — check that the bot has the 'files:read' OAuth scope. Content-Type: ${ct}, URL: ${downloadUrl}`)
      }

      const safeName = sanitizeFileName(file.name || `attachment-${staged.length + 1}`)
      const path = join(dir, `${randomUUID()}-${safeName}`)
      const content = Buffer.from(await response.arrayBuffer())
      await writeFile(path, content)
      console.log(`Staged "${file.name}" -> ${path} (${content.length} bytes)`)
      staged.push({ path })
    } catch (error) {
      console.error(`Failed to stage "${file.name}":`, error)
    }
  }

  return staged
}

async function runPrompt(input: PromptInput): Promise<void> {
  const { client, channel, threadTs, text, files, attachments, isChannel, recipientTeamId, recipientUserId, setStatus, onError } = input
  const tableTexts = extractTablesFromAttachments(attachments)
  if (!text && !files?.length && !tableTexts.length) return

  if (setStatus) {
    await setStatus({
      status: "Querying the database...",
      loading_messages: [
        "Querying the database...",
        "Crunching numbers...",
        "Consulting the data...",
        "Assembling results...",
      ],
    }).catch(() => {})
  } else {
    await client.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status: "Querying the database..." }).catch((e) => {
      console.error("Failed to set thread status:", e)
    })
  }

  const sessionKey = `${channel}-${threadTs}`

  // Slack handlers run concurrently and OpenCode terminal events are matched by
  // session, so two prompts in the same thread would clobber each other's
  // streamer/state (the older run's terminal event would finalize the newer
  // run). Chain runs per thread so each prompt waits for the previous one.
  const priorLink = runQueue.get(sessionKey) ?? Promise.resolve()
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const link = priorLink.then(() => done)
  runQueue.set(sessionKey, link)
  // Drop the queue entry once this link settles and no newer prompt is waiting,
  // so the map does not grow with every thread the bot has ever seen.
  void link.finally(() => {
    if (runQueue.get(sessionKey) === link) runQueue.delete(sessionKey)
  })
  await priorLink

  let existingSession = store.get(sessionKey)
  if (!existingSession) {
    console.log("Creating new opencode session...")
    try {
      const created = await opencode.session.create({
        title: `Slack thread ${threadTs}`,
        // Pin every bot session to the data workspace so it does not depend on
        // the service's own cwd (and so the TUI shows it when opened in data/).
        location: { directory: DATA_DIR },
      })
      console.log("Created opencode session:", created.id)
      existingSession = store.createSessionState(created.id, channel, threadTs, isChannel)
      store.set(sessionKey, existingSession)
      store.persistSession(sessionKey, existingSession)
    } catch (error) {
      console.error("Failed to create session:", error)
      await onError("Sorry, I had trouble creating a session. Please try again.")
      resolveDone()
      return
    }
  }

  const session = existingSession

  // Restrict this session to its own scratch directory before it runs.
  await ensureSessionPermissions(session.sessionId)
  const stagedDir = stagingDirFor(session.sessionId)

  // Create the scratch directory even when there are no uploads, so the agent
  // can redirect command output (e.g. clickhouse-client query results) here.
  try {
    await mkdir(stagedDir, { recursive: true })
  } catch (error) {
    console.error(`Failed to create session scratch directory ${stagedDir}:`, error)
  }

  // Tell the session where its scratch directory is, as session-scoped system
  // instructions, so it is part of the system prompt rather than repeated on
  // every message round.
  await ensureSessionInstructions(session.sessionId, stagedDir)

  // Reset per-run state (this also clears any stale lastError). Session-level
  // usage/model are intentionally preserved.
  store.resetRunState(session)

  const streamer = client.chatStream({
    channel,
    recipient_team_id: recipientTeamId,
    recipient_user_id: recipientUserId,
    thread_ts: threadTs,
    task_display_mode: "plan",
  })

  session.streamer = streamer

  const workingTaskId = `working-${Date.now()}`
  await safeStreamAction(client, session, () => session.streamer!.append({
    chunks: [{ type: "task_update", id: workingTaskId, title: "Working on your request", status: "in_progress" }],
  }))

  // Register the run before staging so the next prompt has something to await
  // and finalizeSession can release the slot.
  store.activeRuns.set(sessionKey, { workingTaskId, resolveDone, done })

  const stagedFiles = await stageAttachments(files, client, stagedDir)
  if (files?.length && stagedFiles.length === 0) {
    console.warn("stageAttachments: all files failed to stage")
  }

  const promptText = text.trim() || "User attached one or more files or tables. Please review the attached data."
  let textForOpencode = promptText
  if (stagedFiles.length) {
    textForOpencode += `\n\nAttached files are available at (read them from disk):\n${stagedFiles.map(f => `- ${f.path}`).join("\n")}`
  }

  // V2 prompt: a single text string plus optional file attachments. Pasted
  // tables (inline data, not uploads) are still sent as data URIs; uploaded
  // files are referenced by path above and read by the agent itself.
  const promptFiles: Array<{ uri: string; name?: string }> = []
  for (const [i, csv] of tableTexts.entries()) {
    const filename = tableTexts.length > 1 ? `table-${i + 1}.csv` : "table.csv"
    const dataUri = `data:text/plain;base64,${Buffer.from(csv).toString("base64")}`
    promptFiles.push({ uri: dataUri, name: filename })
  }

  console.log(`Sending to opencode: text=${textForOpencode.length} chars, uploads=${stagedFiles.length}, tables=${tableTexts.length}`)
  let promptError: unknown = null
  try {
    await opencode.session.prompt({
      sessionID: session.sessionId,
      text: textForOpencode,
      files: promptFiles.length > 0 ? promptFiles : undefined,
    })
  } catch (error) {
    console.error("Prompt failed:", error)
    promptError = error
  }
  console.log("Opencode prompt accepted")

  if (promptError) {
    console.error("Prompt failed:", promptError)
    const detail = promptError instanceof Error ? promptError.message.trim() : String(promptError).trim()
    const message = detail
      ? `:warning: Sorry, I couldn't send that request: ${detail}`
      : ":warning: Sorry, something went wrong. Please try again."
    await safeStreamAction(client, session, () => session.streamer!.append({
      chunks: [{ type: "task_update", id: workingTaskId, title: "Working on your request", status: "complete" }],
    }))
    await safeStreamAction(client, session, () => session.streamer!.stop({
      chunks: [{ type: "markdown_text", text: message } as AnyChunk],
    }))
    // Post separately too, so the error is still visible if the stream expired.
    await postAssistantResponse(client, session, message).catch((e) => {
      console.error("Failed to post prompt error to Slack:", e)
    })
    const failedRun = store.activeRuns.get(sessionKey)
    store.activeRuns.delete(sessionKey)
    store.resetRunState(session)
    failedRun?.resolveDone()
    return
  }
}

// ─── Assistant handler ────────────────────────────────────────────

const assistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts, saveThreadContext }) => {
    try {
      await say("Hi! I'm OpenCode, your database analytics assistant. Ask me anything about the data.")
      await saveThreadContext()
      await setSuggestedPrompts({
        title: "Try one of these:",
        prompts: [
          { title: "Active users today", message: "How many active users have we had today?" },
          { title: "Top apps by traffic", message: "What are the top 10 apps by datafree traffic in the last 7 days?" },
          { title: "User demographics", message: "What does our user demographic breakdown look like?" },
        ],
      })
    } catch (e) {
      console.error("threadStarted error:", e)
    }
  },

  threadContextChanged: async ({ saveThreadContext }) => {
    await saveThreadContext()
  },

  userMessage: async ({ client, context, message, say, setTitle, setStatus }) => {
    if (!("text" in message) || !("thread_ts" in message) || !message.thread_ts) return

    const { channel, thread_ts } = message
    const { userId, teamId } = context

    if (isUnauthorized(userId as string, teamId as string)) {
      console.log(`Rejected request from unauthorized user ${userId}`)
      await say({ text: "Sorry, you are not authorized to use this bot." }).catch(() => {})
      return
    }

    const messageText = typeof message.text === "string" ? message.text : ""
    const msgAny = message as any

    if (!messageText.trim() && !msgAny.files?.length && !msgAny.attachments?.length) return
    await setTitle((messageText || "Attachment").slice(0, 60)).catch(() => {})

    await runPrompt({
      client,
      channel,
      threadTs: thread_ts,
      text: messageText,
      files: msgAny.files,
      attachments: msgAny.attachments,
      isChannel: false,
      recipientTeamId: teamId as string,
      recipientUserId: userId as string,
      setStatus,
      onError: async (errorMessage: string) => {
        await say({ text: errorMessage })
      },
    })
  },
})

app.assistant(assistant)

// ─── Channel @mentions ────────────────────────────────────────────

app.event("app_mention", async ({ event, client, context }) => {
  const channel = event.channel
  const thread_ts = (event as any).thread_ts || event.ts
  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim()
  const files = (event as any).files as IncomingAttachment[] | undefined
  const eventAttachments = (event as any).attachments as any[] | undefined
  const { userId, teamId } = context
  const userTeamId = (event as any).user_team ?? teamId

  console.log(`app_mention in channel ${channel}: "${text}"`)

  if (isUnauthorized(userId as string, userTeamId as string)) {
    console.log(`Rejected request from unauthorized user ${userId}`)
    await client.chat.postEphemeral({
      channel,
      user: userId as string,
      text: "Sorry, you are not authorized to use this bot.",
    }).catch(() => {})
    return
  }

  if (!text && !files?.length && !eventAttachments?.length) return

  await runPrompt({
    client,
    channel,
    threadTs: thread_ts,
    text,
    files,
    attachments: eventAttachments,
    isChannel: true,
    recipientTeamId: teamId as string,
    recipientUserId: userId as string,
    onError: async (errorMessage: string) => {
      await client.chat.postMessage({ channel, thread_ts, text: errorMessage })
    },
  })
})

// ─── Direct messages + channel thread replies ─────────────────────

app.event("message", async ({ event, client, context }) => {
  const message = event as any

  if (message.subtype === "assistant_app_thread") return
  if (message.bot_id) return

  // file_share subtype is how Slack delivers DM file uploads — allow it through.
  // All other subtypes (message_changed, message_deleted, etc.) are skipped.
  const isFileShare = message.subtype === "file_share"
  if (message.subtype && !isFileShare) {
    console.log(`message event skipped: subtype="${message.subtype}"`)
    return
  }

  const text = typeof message.text === "string" ? message.text.trim() : ""
  const files = message.files as IncomingAttachment[] | undefined
  const msgAttachments = message.attachments as any[] | undefined
  if (!text && !files?.length && !msgAttachments?.length) return

  const channel = message.channel as string
  const threadTs = (message.thread_ts || message.ts) as string
  const { userId, teamId } = context
  const isDM = message.channel_type === "im"
  const userTeamId = message.user_team ?? teamId

  if (isUnauthorized(userId as string, userTeamId as string)) {
    console.log(`Rejected request from unauthorized user ${userId}`)
    await client.chat.postEphemeral({
      channel,
      user: userId as string,
      text: "Sorry, you are not authorized to use this bot.",
    }).catch(() => {})
    return
  }

  // For channel messages, only respond if the bot already has a session for
  // this thread (i.e. it was previously @mentioned here). This avoids the
  // bot responding to every message in every channel it is a member of.
  if (!isDM && !store.get(`${channel}-${threadTs}`)) return

  await runPrompt({
    client,
    channel,
    threadTs,
    text,
    files,
    attachments: msgAttachments,
    isChannel: !isDM,
    recipientTeamId: teamId as string,
    recipientUserId: userId as string,
    onError: async (errorMessage: string) => {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: errorMessage })
    },
  })
})

// ─── Feedback button handler (Bug 3 fix) ─────────────────────────

app.action("feedback", async ({ ack, body, client }) => {
  await ack()
  if (body.type !== "block_actions") return

  const channelId = body.channel?.id
  const userId = body.user.id
  const messageTs = (body as any).message?.ts
  const feedbackValue = (body.actions[0] as any).value
  if (!channelId || !messageTs) return

  // Bug 3 fix: track feedback per message so clicking multiple times
  // doesn't create multiple ephemeral messages.
  const feedbackKey = `${channelId}-${messageTs}`
  if (store.feedbackGiven.has(feedbackKey)) return
  store.feedbackGiven.add(feedbackKey)

  // Replace the feedback buttons block on the original message with
  // a static context block showing what was selected.
  const originalMessage = (body as any).message
  if (originalMessage?.blocks) {
    const isGood = feedbackValue === "good-feedback"
    const feedbackText = isGood ? "Feedback: Good Response" : "Feedback: Bad Response"

    // Replace the context_actions block with a simple context block
    const updatedBlocks = originalMessage.blocks.map((block: any) => {
      if (block.type === "context_actions") {
        return {
          type: "context",
          elements: [{ type: "plain_text", text: feedbackText, emoji: true }],
        }
      }
      return block
    })

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: originalMessage.text || "Response",
      blocks: updatedBlocks,
    }).catch((e) => {
      console.error("Failed to update message with feedback:", e)
    })
  }

  // Also send a one-time ephemeral confirmation
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    thread_ts: messageTs,
    text: feedbackValue === "good-feedback"
      ? "Glad that was helpful!"
      : "Sorry that wasn't useful. Starting a new thread may help.",
  }).catch(() => {})
})

// ─── Start ────────────────────────────────────────────────────────

// Sweep stale upload directories now and hourly.
void sweepStaleStaging()
setInterval(() => { void sweepStaleStaging() }, 60 * 60 * 1000)

await app.start()
try {
  await app.client.users.setPresence({ presence: "auto" })
  console.log("Bot presence set to auto/online")
} catch (e) {
  console.error("Failed to set bot presence:", e)
}
console.log("Slack bot is running!")
