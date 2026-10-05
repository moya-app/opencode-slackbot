import type { SessionState, SlackClient } from "./types"
import { extractVegaLiteSpecs, renderAndUploadCharts } from "./chart"
import { extractSlackFiles, uploadSlackFiles } from "./files"
import { settings } from "./settings"

// Feedback block appended to every completed response
export const feedbackBlock = {
  type: "context_actions",
  elements: [
    {
      type: "feedback_buttons",
      action_id: "feedback",
      positive_button: {
        text: { type: "plain_text", text: "Good Response" },
        accessibility_label: "Submit positive feedback",
        value: "good-feedback",
      },
      negative_button: {
        text: { type: "plain_text", text: "Bad Response" },
        accessibility_label: "Submit negative feedback",
        value: "bad-feedback",
      },
    },
  ],
}

export function splitTextForSlack(text: string, maxChunkLength: number): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxChunkLength) {
    let cut = remaining.lastIndexOf("\n\n", maxChunkLength)
    if (cut < 200) cut = remaining.lastIndexOf("\n", maxChunkLength)
    if (cut < 100) cut = maxChunkLength
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.trim().length > 0) chunks.push(remaining.trim())
  return chunks
}

export async function postResponseMeta(client: SlackClient, session: SessionState): Promise<void> {
  await client.chat.postMessage({
    channel: session.channel,
    thread_ts: session.thread,
    text: `Session cost: $${session.usage.cost.toFixed(2)}`,
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: `Session cost: $${session.usage.cost.toFixed(2)}, ${session.lastModelID || "unknown"}, Session tokens: ${JSON.stringify(session.usage.tokens)}`,
            emoji: true,
          },
        ],
      },
      feedbackBlock,
    ],
  })
}

export async function postAssistantResponse(client: SlackClient, session: SessionState, text: string): Promise<boolean> {
  // Extract any <vega-lite> chart specs and <slack-file> directives before posting text
  const hasVegaTag = text.includes("<vega-lite>")
  const { cleanedText: chartCleaned, charts } = extractVegaLiteSpecs(text.trim())
  const { cleanedText, files: extractedFiles } = extractSlackFiles(chartCleaned)
  // Always strip directives, but only act on them when the feature is enabled.
  const files = settings.SEND_FILE_MAX_SIZE > 0 ? extractedFiles : []
  if (hasVegaTag) {
    console.log(`postAssistantResponse: found <vega-lite> tag, extracted ${charts.length} chart(s), cleaned text length: ${cleanedText.length}`)
  }
  // A response that is only a file directive still needs to be posted/uploaded.
  const trimmed = cleanedText || (files.length > 0 ? "Here is the file you requested." : "")
  if (!trimmed && charts.length === 0 && files.length === 0) return false

  if (trimmed.length > 12000) {
    try {
      await client.files.uploadV2({
        channel_id: session.channel,
        thread_ts: session.thread,
        title: "OpenCode response",
        filename: `opencode-response-${Date.now()}.md`,
        content: trimmed,
        initial_comment: "Response is large, so I uploaded it as a file.",
      })
      await postResponseMeta(client, session)
      if (charts.length > 0) {
        await renderAndUploadCharts(client, session, charts)
      }
      await uploadSlackFiles(client, session, files)
      return true
    } catch (e) {
      console.error("Failed to upload large response as file, falling back to chunked messages:", e)
    }
  }

  // Split at 12000 chars (markdown block cumulative limit per Slack docs)
  const chunks = splitTextForSlack(trimmed, 11800)
  const blocks: any[] = []
  for (const chunk of chunks) {
    blocks.push({ type: "markdown", text: chunk })
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "plain_text",
        text: `Session cost: $${session.usage.cost.toFixed(2)}, ${session.lastModelID || "unknown"}, Session tokens: ${JSON.stringify(session.usage.tokens)}`,
        emoji: true,
      },
    ],
  })
  blocks.push(feedbackBlock)

  // Bug 2 fix: when responding in a channel (not assistant pane / DM),
  // use reply_broadcast so the final message surfaces in the channel.
  try {
    await client.chat.postMessage({
      channel: session.channel,
      thread_ts: session.thread,
      text: chunks[0] || (files.length > 0 ? "Here is the file you requested." : "See chart below."),
      blocks,
      reply_broadcast: session.isChannel && settings.REPLY_BROADCAST,
    })
  } catch (e) {
    console.error("Failed to post assistant response:", e)
    return false
  }

  // Render and upload any extracted vega-lite charts to the thread
  if (charts.length > 0) {
    await renderAndUploadCharts(client, session, charts)
  }

  // Upload any files the agent asked to send back
  await uploadSlackFiles(client, session, files)

  return true
}

/** Store the authoritative text for one text part (message + ordinal). */
export function setTextPart(session: SessionState, messageID: string, ordinal: number, text: string): void {
  let parts = session.textByMessage.get(messageID)
  if (!parts) {
    parts = new Map()
    session.textByMessage.set(messageID, parts)
  }
  parts.set(ordinal, text)
}

/** Append a streaming delta to a text part. */
export function appendTextPart(session: SessionState, messageID: string, ordinal: number, delta: string): void {
  let parts = session.textByMessage.get(messageID)
  if (!parts) {
    parts = new Map()
    session.textByMessage.set(messageID, parts)
  }
  parts.set(ordinal, (parts.get(ordinal) ?? "") + delta)
}

export function buildMessageText(session: SessionState, messageID: string): string {
  const parts = session.textByMessage.get(messageID)
  if (!parts) return ""
  const ordinals = [...parts.keys()].sort((a, b) => a - b)
  const pieces: string[] = []
  for (const ordinal of ordinals) {
    const text = parts.get(ordinal)
    if (typeof text === "string" && text.trim().length > 0) {
      pieces.push(text.trim())
    }
  }
  return pieces.join("\n\n").trim()
}

export async function tryPublishFinalMessage(client: SlackClient, session: SessionState, messageID: string): Promise<boolean> {
  if (session.publishedMessageIDs.has(messageID)) return true
  const finish = session.messageFinishByID.get(messageID)
  if (finish !== "stop") return false

  const text = buildMessageText(session, messageID)
  if (!text) return false
  const posted = await postAssistantResponse(client, session, text)
  if (posted) {
    session.publishedMessageIDs.add(messageID)
    return true
  }
  return false
}

export async function publishPendingFinalMessages(client: SlackClient, session: SessionState): Promise<boolean> {
  let published = false

  for (const [messageID, finish] of session.messageFinishByID.entries()) {
    if (finish !== "stop") continue
    const posted = await tryPublishFinalMessage(client, session, messageID)
    if (posted) published = true
  }

  if (published) return true

  // Fallback: the model often does the real work in a step that ends with
  // `tool-calls` while the final `stop` step is empty. Publish the longest
  // un-published assistant message we saw instead.
  let fallbackMessageID = ""
  let fallbackLength = 0
  for (const messageID of session.assistantMessageIDs) {
    if (session.publishedMessageIDs.has(messageID)) continue
    const text = buildMessageText(session, messageID)
    if (text.length > fallbackLength) {
      fallbackLength = text.length
      fallbackMessageID = messageID
    }
  }

  if (fallbackMessageID && fallbackLength > 0) {
    const posted = await postAssistantResponse(client, session, buildMessageText(session, fallbackMessageID))
    if (posted) {
      session.publishedMessageIDs.add(fallbackMessageID)
      return true
    }
  }

  return false
}

// ─── Live stream resilience ──────────────────────────────────────────────────
//
// Slack streams are not durable: the server finalises a streamed message after
// an undocumented lifetime (reports cluster around ~5 minutes, with a shorter
// idle window in some cases). Once that happens `chat.appendStream` and
// `chat.stopStream` fail with `message_not_in_streaming_state`, and the message
// is frozen in Slack's UI as a permanent "Something went wrong" pill.
//
// The Slack SDK's own guidance is to detect that error and fall back to
// `chat.update` using the streamer's `ts` (see the `ChatStreamer.ts` getter:
// "Can be used with chat.update as a fallback if the stream expires
// server-side"). The helpers below do exactly that, so a long answer degrades
// to "no live task updates" instead of an error box.

function slackErrorCode(error: unknown): string | undefined {
  const e = error as { data?: { error?: string }; error?: string } | undefined
  return e?.data?.error ?? e?.error
}

/** True when the stream has been finalised/stopped and can no longer be used. */
export function isStreamExpiredError(error: unknown): boolean {
  const code = slackErrorCode(error)
  return code === "message_not_in_streaming_state" ||
    code === "stopped_by_user" ||
    code === "message_not_found" ||
    code === "message_not_owned_by_app"
}

function isRateLimitError(error: unknown): boolean {
  const code = slackErrorCode(error)
  return code === "ratelimited" || code === "rate_limited"
}

/** Replace a streamed message that Slack has already finalised with a plain
 *  message, clearing the "Something went wrong" state (best effort). */
async function finalizeExpiredStream(client: SlackClient, channel: string, ts: string | undefined): Promise<void> {
  if (!ts) return
  try {
    await client.chat.update({
      channel,
      ts,
      text: "The live progress view timed out, but I'm still working on your answer.",
    })
  } catch (e) {
    console.error("Failed to update expired stream message:", e)
  }
}

/** Outcome of a stream action, so callers can decide whether a retry is useful. */
export type StreamActionResult = "ok" | "expired" | "rate_limited" | "failed"

/**
 * Run an append/stop against the session stream and never throw into the event
 * loop. If Slack has already finalised the stream, disable further live updates
 * and clean up the message instead.
 */
export async function safeStreamAction(
  client: SlackClient,
  session: SessionState,
  action: () => Promise<unknown>,
): Promise<StreamActionResult> {
  if (!session.streamer) return "expired"
  try {
    await action()
    return "ok"
  } catch (error) {
    if (isStreamExpiredError(error)) {
      console.error("Slack stream is no longer in a streaming state; disabling live updates:", error)
      const ts = session.streamer?.ts
      session.streamer = null
      await finalizeExpiredStream(client, session.channel, ts)
      return "expired"
    }
    if (isRateLimitError(error)) {
      // Transient: the caller can re-queue this update for the next flush.
      console.error("Slack rate limit hit while updating the stream; dropping this update:", error)
      return "rate_limited"
    }
    console.error("Failed to update the Slack stream:", error)
    return "failed"
  }
}
