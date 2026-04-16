import type { SessionState, SlackClient } from "./types"
import { extractVegaLiteSpecs, renderAndUploadCharts } from "./chart"

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
  // Extract any <vega-lite> chart specs before posting text
  const hasVegaTag = text.includes("<vega-lite>")
  const { cleanedText: trimmed, charts } = extractVegaLiteSpecs(text.trim())
  if (hasVegaTag) {
    console.log(`postAssistantResponse: found <vega-lite> tag, extracted ${charts.length} chart(s), cleaned text length: ${trimmed.length}`)
  }
  if (!trimmed && charts.length === 0) return false

  if (trimmed.length > 12000) {
    try {
      await client.files.uploadV2({
        channel_id: session.channel,
        thread_ts: session.thread,
        title: "OpenCode response",
        filename: `opencode-response-${Date.now()}.md`,
        filetype: "markdown",
        content: trimmed,
        initial_comment: "Response is large, so I uploaded it as a file.",
      })
      await postResponseMeta(client, session)
      if (charts.length > 0) {
        await renderAndUploadCharts(client, session, charts)
      }
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
      text: chunks[0] || "See chart below.",
      blocks,
      reply_broadcast: session.isChannel,
    })
  } catch (e) {
    console.error("Failed to post assistant response:", e)
    return false
  }

  // Render and upload any extracted vega-lite charts to the thread
  if (charts.length > 0) {
    await renderAndUploadCharts(client, session, charts)
  }

  return true
}

function registerTextPart(session: SessionState, messageID: string, partID: string): void {
  session.textPartToMessageID.set(partID, messageID)
  const existing = session.messagePartOrder.get(messageID)
  if (existing) {
    if (!existing.includes(partID)) existing.push(partID)
    return
  }
  session.messagePartOrder.set(messageID, [partID])
}

export { registerTextPart }

export function buildMessageText(session: SessionState, messageID: string): string {
  const partIDs = session.messagePartOrder.get(messageID) ?? []
  const pieces: string[] = []
  for (const partID of partIDs) {
    const text = session.textPartStates.get(partID)
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

  let fallbackMessageID = ""
  let fallbackLength = 0
  for (const [messageID] of session.messagePartOrder.entries()) {
    if (session.publishedMessageIDs.has(messageID)) continue
    // Bug 2 fix: skip non-assistant messages (e.g. user prompts) in fallback
    if (!session.assistantMessageIDs.has(messageID)) continue
    // Include tool-calls messages: the model often puts its text in the message
    // that finishes with "tool-calls" while the final "stop" message is empty.
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

/** Remove any text-part state registered for a given messageID.
 *  Used when we discover a message is not from the assistant (Bug 2 fix). */
export function clearTextPartsForMessage(session: SessionState, messageID: string): void {
  const partIDs = session.messagePartOrder.get(messageID)
  if (partIDs) {
    for (const partID of partIDs) {
      session.textPartStates.delete(partID)
      session.textPartToMessageID.delete(partID)
    }
    session.messagePartOrder.delete(messageID)
  }
}
