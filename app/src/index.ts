import { App, Assistant } from "@slack/bolt"
import type { AnyChunk } from "@slack/types"
import { createOpencode } from "@opencode-ai/sdk"
import { chdir } from "node:process"

import { DATA_DIR } from "./types"
import type { PromptInput } from "./types"
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
const opencode = await createOpencode({ port: 0 })
console.log("Opencode server ready")

const store = new SessionStore()
const restored = store.restore()
console.log(`Restored ${restored} session(s) from database`)

// Start the global event loop (runs in background)
startEventLoop(opencode, app.client, store)

// ─── Shared prompt logic ──────────────────────────────────────────

async function runPrompt(input: PromptInput): Promise<void> {
  const { client, channel, threadTs, text, isChannel, recipientTeamId, recipientUserId, setStatus, onError } = input
  if (!text) return

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

  console.log("Sending to opencode:", text)
  const result = await opencode.client.session.prompt({
    path: { id: session.sessionId },
    body: { parts: [{ type: "text", text }] },
  })
  console.log("Opencode completed")

  if (result.error) {
    console.error("Prompt failed:", result.error)
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
    if (!("text" in message) || !("thread_ts" in message) || !message.text || !message.thread_ts) return

    const { channel, thread_ts } = message
    const { userId, teamId } = context

    await setTitle(message.text.slice(0, 60)).catch(() => {})

    await runPrompt({
      client,
      channel,
      threadTs: thread_ts,
      text: message.text,
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
  const { userId, teamId } = context

  console.log(`app_mention in channel ${channel}: "${text}"`)

  if (!text) return

  await runPrompt({
    client,
    channel,
    threadTs: thread_ts,
    text,
    isChannel: true,
    recipientTeamId: teamId as string,
    recipientUserId: userId as string,
    onError: async (errorMessage: string) => {
      await client.chat.postMessage({ channel, thread_ts, text: errorMessage })
    },
  })
})

// ─── Direct messages ──────────────────────────────────────────────

app.event("message", async ({ event, client, context }) => {
  const message = event as any

  if (message.channel_type !== "im") return

  if (message.subtype === "assistant_app_thread") return
  if (message.subtype) return
  if (message.bot_id) return

  const text = typeof message.text === "string" ? message.text.trim() : ""
  if (!text) return

  const channel = message.channel as string
  const threadTs = (message.thread_ts || message.ts) as string
  const { userId, teamId } = context

  console.log(`direct_message in channel ${channel}: "${text}"`)

  await runPrompt({
    client,
    channel,
    threadTs,
    text,
    isChannel: false,
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
