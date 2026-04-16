import { App, Assistant } from "@slack/bolt"
import type { AnyChunk } from "@slack/types"
import { createOpencode } from "@opencode-ai/sdk"
import { randomUUID } from "node:crypto"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { chdir } from "node:process"

import { DATA_DIR } from "./types"
import type { PromptInput, SlackClient } from "./types"
import type { IncomingAttachment } from "./types"
import { SessionStore } from "./session"
import { startEventLoop } from "./events"

chdir(DATA_DIR)

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

console.log("Bot configuration:")
console.log("- Bot token present:", !!process.env.SLACK_BOT_TOKEN)
console.log("- Signing secret present:", !!process.env.SLACK_SIGNING_SECRET)
console.log("- App token present:", !!process.env.SLACK_APP_TOKEN)

console.log("Starting opencode server...")
const opencode = await createOpencode({
  port: 0,
  config: {
    agent: {
      // Replace OpenCode's built-in system prompt with a blank string so that
      // AGENTS.md is the sole source of system-level instructions.
      build: { prompt: `
When a user requests a chart or visualization, or when a visualization would clearly enhance the answer (e.g. trends over
time, comparisons across categories), include a Vega-Lite v6 specification wrapped in \`<vega-lite>...</vega-lite>\` tags
in your response. The Slack harness will render it to a PNG image and attach it to the thread automatically.

Guidelines:
- Choose appropriate chart types: line charts for time series, bar charts for categories, scatter for correlations
- Embed the query result data directly in the spec's \`data.values\` field (keep to a reasonable number of data points -- pre-aggregate if needed)
- Set \`width\` and \`height\` (e.g. 1200x800) for readable charts
- Use clear axis labels and a descriptive title

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
          ` },
    },
  },
})
console.log("Opencode server ready")

const store = new SessionStore()
const restored = store.restore()
console.log(`Restored ${restored} session(s) from database`)

// Start the global event loop (runs in background)
startEventLoop(opencode, app.client, store)

// ─── Shared prompt logic ──────────────────────────────────────────

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

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"])

function mimeFromFile(file: IncomingAttachment): string {
  if (file.mimetype) return file.mimetype
  const ext = (file.name || "").split(".").pop()?.toLowerCase()
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    csv: "text/csv", txt: "text/plain", json: "application/json",
  }
  return (ext && map[ext]) || "application/octet-stream"
}

type StagedFile = { path: string; name: string; mime: string }

async function stageAttachments(files: IncomingAttachment[] | undefined, client: SlackClient): Promise<StagedFile[]> {
  if (!files?.length) return []

  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.error("Cannot download attachments: SLACK_BOT_TOKEN is not set")
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
      const path = `/tmp/${randomUUID()}-${safeName}`
      const content = Buffer.from(await response.arrayBuffer())
      await writeFile(path, content)
      const mime = mimeFromFile(file)
      console.log(`Staged "${file.name}" -> ${path} (${content.length} bytes, ${mime})`)
      staged.push({ path, name: safeName, mime })
    } catch (error) {
      console.error(`Failed to stage "${file.name}":`, error)
    }
  }

  return staged
}

async function cleanupAttachments(staged: StagedFile[]): Promise<void> {
  await Promise.all(staged.map(async ({ path }) => {
    try {
      await unlink(path)
    } catch (error) {
      console.error(`Failed to remove attachment ${path}:`, error)
    }
  }))
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

  let existingSession = store.get(sessionKey)
  if (!existingSession) {
    console.log("Creating new opencode session...")
    const createResult = await opencode.client.session.create({
      body: { title: `Slack thread ${threadTs}` },
    })
    if (createResult.error) {
      console.error("Failed to create session:", createResult.error)
      await onError("Sorry, I had trouble creating a session. Please try again.")
      return
    }
    console.log("Created opencode session:", createResult.data.id)
    existingSession = store.createSessionState(createResult.data.id, channel, threadTs, isChannel)
    store.set(sessionKey, existingSession)
    store.persistSession(sessionKey, existingSession)
  }

  const session = existingSession

  const streamer = client.chatStream({
    channel,
    recipient_team_id: recipientTeamId,
    recipient_user_id: recipientUserId,
    thread_ts: threadTs,
    task_display_mode: "plan",
  })

  const workingTaskId = `working-${Date.now()}`
  await streamer.append({
    chunks: [{ type: "task_update", id: workingTaskId, title: "Working on your request", status: "in_progress" }],
  }).catch((e) => {
    console.error("Failed to append initial working task update:", e)
  })

  session.streamer = streamer
  session.seenTaskIds = new Set()
  session.textPartStates = new Map()
  session.textPartToMessageID = new Map()
  session.messagePartOrder = new Map()
  session.messageFinishByID = new Map()
  session.publishedMessageIDs = new Set()
  session.thinkingMessageIDs = new Set()
  session.assistantMessageIDs = new Set()

  store.activeRuns.set(sessionKey, { workingTaskId, textStreamed: false })

  const stagedFiles = await stageAttachments(files, client)
  if (files?.length && stagedFiles.length === 0) {
    console.warn("stageAttachments: all files failed to stage")
  }

  // Split staged files into images (sent as file parts) and others (paths in text)
  const imageFiles = stagedFiles.filter(f => IMAGE_MIMES.has(f.mime))
  const otherFiles = stagedFiles.filter(f => !IMAGE_MIMES.has(f.mime))

  const promptText = text.trim() || "User attached one or more files or tables. Please review the attached data."
  let textForOpencode = promptText
  if (otherFiles.length) {
    textForOpencode += `\n\nAttached files are available at:\n${otherFiles.map(f => `- ${f.path}`).join("\n")}`
  }

  // Build prompt parts: text first, then image file parts, then CSV tables as file parts
  const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [
    { type: "text", text: textForOpencode },
  ]
  for (const img of imageFiles) {
    try {
      const data = await readFile(img.path)
      const dataUri = `data:${img.mime};base64,${data.toString("base64")}`
      parts.push({ type: "file", mime: img.mime, url: dataUri, filename: img.name })
    } catch (error) {
      console.error(`Failed to read image ${img.path} for file part:`, error)
    }
  }
  for (const [i, csv] of tableTexts.entries()) {
    const filename = tableTexts.length > 1 ? `table-${i + 1}.csv` : `table.csv`
    const dataUri = `data:text/plain;base64,${Buffer.from(csv).toString("base64")}`
    parts.push({ type: "file", mime: "text/plain", url: dataUri, filename })
  }

  console.log(`Sending to opencode: ${parts.length} part(s), text=${textForOpencode.length} chars, images=${imageFiles.length}`)
  let result: Awaited<ReturnType<typeof opencode.client.session.prompt>> | null = null
  try {
    result = await opencode.client.session.prompt({
      path: { id: session.sessionId },
      body: { parts },
    })
  } catch (error) {
    console.error("Prompt failed:", error)
  } finally {
    await cleanupAttachments(stagedFiles)
  }
  console.log("Opencode completed")

  const promptError = !result
    ? new Error("Prompt request failed before receiving a response")
    : ("error" in result ? result.error : undefined)
  if (promptError) {
    console.error("Prompt failed:", promptError)
    store.activeRuns.delete(sessionKey)
    await streamer.append({
      chunks: [{ type: "task_update", id: workingTaskId, title: "Working on your request", status: "error" }],
    }).catch((e) => {
      console.error("Failed to append error working task update:", e)
    })
    await streamer.stop({
      chunks: [{ type: "markdown_text", text: "Sorry, something went wrong. Please try again." } as AnyChunk],
    })
    session.streamer = null
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

  console.log(`app_mention in channel ${channel}: "${text}"`)

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

await app.start()
try {
  await app.client.users.setPresence({ presence: "auto" })
  console.log("Bot presence set to auto/online")
} catch (e) {
  console.error("Failed to set bot presence:", e)
}
console.log("Slack bot is running!")
