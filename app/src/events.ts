import type { AnyChunk } from "@slack/types"
import type { OpenCodeEvent } from "@opencode/sdk"
import type { SlackClient, SessionState } from "./types"
import type { SessionStore } from "./session"
import { buildToolChunk, clampTaskTextTail } from "./tools"
import { appendTextPart, setTextPart, tryPublishFinalMessage, publishPendingFinalMessages, postAssistantResponse, safeStreamAction } from "./slack"

/**
 * Slack's `chat.appendStream` is rate limited (Tier 4, ~100 calls/minute), and
 * streams are expensive, so batch updates into ~1s windows rather than the old
 * 350 ms (which could issue ~170 calls/minute).
 */
const FLUSH_INTERVAL_MS = 1000

/** Minimal structural type for the embedded OpenCode host — avoids a hard import. */
type EventSource = {
  events: { subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<OpenCodeEvent> }
}

type PendingEntry = {
  session: SessionState
  chunks: AnyChunk[]
  thinkingUpdates: Map<string, string>
}

/** Format a structured OpenCode error (e.g. `provider.auth`) for Slack. */
function formatSessionError(error: unknown): string {
  if (typeof error === "string") return error.trim()
  const e = error as { type?: unknown; message?: unknown; status?: unknown } | undefined
  if (!e || typeof e !== "object") return ""
  const message = typeof e.message === "string" ? e.message.trim() : ""
  const bits: string[] = []
  if (message) bits.push(message)
  if (typeof e.status === "number") bits.push(`HTTP ${e.status}`)
  if (typeof e.type === "string" && e.type.length > 0 && e.type !== "unknown") bits.push(`(${e.type})`)
  return bits.join(" ")
}

export async function startEventLoop(
  opencode: EventSource,
  client: SlackClient,
  store: SessionStore,
): Promise<void> {
  const pending = new Map<string, PendingEntry>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  async function flushEntry(entry: PendingEntry) {
    const { session, chunks, thinkingUpdates } = entry

    if (!session.streamer) return
    try {
      if (thinkingUpdates.size > 0) {
        for (const [messageID, delta] of thinkingUpdates.entries()) {
          if (!session.thinkingMessageIDs.has(messageID)) continue
          chunks.push({
            type: "task_update",
            id: `thinking-${messageID}`,
            title: "Thinking",
            status: "in_progress",
            output: clampTaskTextTail(delta),
          })
        }
      }

      if (chunks.length > 0) {
        await safeStreamAction(client, session, () => session.streamer!.append({ chunks }))
      }
    } catch (e) {
      console.error("Failed to flush stream event updates:", e)
    }
  }

  async function flushStreamEvents() {
    flushTimer = null
    if (pending.size === 0) return

    const snapshot = new Map(pending)
    pending.clear()

    for (const entry of snapshot.values()) {
      await flushEntry(entry)
    }
  }

  function getOrCreatePending(key: string, session: SessionState): PendingEntry {
    let entry = pending.get(key)
    if (!entry) {
      entry = { session, chunks: [], thinkingUpdates: new Map() }
      pending.set(key, entry)
    }
    return entry
  }

  function scheduleFlush() {
    if (!flushTimer) {
      flushTimer = setTimeout(flushStreamEvents, FLUSH_INTERVAL_MS)
    }
  }

  /** Start an in-progress "Thinking" task for an assistant message. */
  function startThinking(session: SessionState, messageID: string) {
    if (session.thinkingMessageIDs.has(messageID)) return
    if (session.messageFinishByID.has(messageID)) return
    session.thinkingMessageIDs.add(messageID)
    console.log(`[thinking] registered thinking-${messageID}`)
  }

  /** Queue a thinking delta for the next flush. */
  function streamThinking(entry: PendingEntry, session: SessionState, messageID: string, delta: string) {
    if (!session.thinkingMessageIDs.has(messageID)) return
    const previous = entry.thinkingUpdates.get(messageID) ?? ""
    entry.thinkingUpdates.set(messageID, previous + delta)
  }

  /** Flush any pending thinking output, then mark the thinking task complete. */
  async function completeThinking(key: string, session: SessionState, messageID: string) {
    if (!session.thinkingMessageIDs.has(messageID)) return
    const pendingEntry = pending.get(key)
    if (pendingEntry) {
      pending.delete(key) // remove first so the flush timer can't double-process
      await flushEntry(pendingEntry).catch(() => {})
    }
    session.thinkingMessageIDs.delete(messageID)
    if (session.streamer) {
      await safeStreamAction(client, session, () => session.streamer!.append({
        chunks: [{ type: "task_update", id: `thinking-${messageID}`, title: "Thinking", status: "complete" }],
      }))
    }
  }

  /**
   * Finish a run: flush pending stream output, publish any final message,
   * complete the working/thinking tasks, and stop the stream. Idempotent —
   * the first of `session.execution.succeeded/failed/interrupted` or
   * `session.idle` to arrive wins; later ones are no-ops.
   */
  async function finalizeSession(key: string, session: SessionState, failed: boolean) {
    if (!store.activeRuns.has(key)) return

    const pendingEntry = pending.get(key)
    if (pendingEntry) {
      pending.delete(key)
      await flushEntry(pendingEntry)
    }

    const published = await publishPendingFinalMessages(client, session)
    const run = store.activeRuns.get(key)
    if (run && published) run.textStreamed = true

    // Decide what (if anything) the user still needs to see for this run. On
    // failure we always post an explanation, even if partial text was already
    // published, so errors are never silent.
    let outcomeText: string | null = null
    if (failed) {
      const detail = session.lastError.trim()
      outcomeText = detail
        ? `:warning: Sorry, I couldn't complete that request: ${detail}`
        : ":warning: Sorry, something went wrong while working on that request. Please try again."
    } else if (!published) {
      outcomeText = "I completed the request but did not receive a text response from model output."
    }

    if (outcomeText) {
      await postAssistantResponse(client, session, outcomeText).catch((e) => {
        console.error("Failed to post run outcome to Slack:", e)
      })
    }

    if (run && session.streamer) {
      const stopChunks: AnyChunk[] = []

      stopChunks.push({
        type: "task_update",
        id: run.workingTaskId,
        title: "Working on your request",
        status: failed ? "error" : "complete",
      })

      if (session.thinkingMessageIDs.size > 0) {
        console.log(`[session] finalize: completing ${session.thinkingMessageIDs.size} thinking task(s)`)
        for (const messageID of session.thinkingMessageIDs) {
          stopChunks.push({
            type: "task_update",
            id: `thinking-${messageID}`,
            title: "Thinking",
            status: failed ? "error" : "complete",
          })
        }
      }

      // Surface the outcome (error or no-text fallback) in the plan pane too.
      if (outcomeText) {
        stopChunks.push({ type: "markdown_text", text: outcomeText } as AnyChunk)
      }

      console.log(`[session] finalize: stopping streamer with ${stopChunks.length} stop chunk(s)`)
      await safeStreamAction(client, session, () => session.streamer!.stop({ chunks: stopChunks }))

      session.streamer = null
    }

    store.activeRuns.delete(key)
    store.resetRunState(session)
  }

  for await (const event of opencode.events.subscribe()) {
    switch (event.type) {
      // ── Text output ──────────────────────────────────────────────
      case "session.text.started": {
        const { sessionID, assistantMessageID } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [, session] = match
        session.assistantMessageIDs.add(assistantMessageID)
        startThinking(session, assistantMessageID)
        scheduleFlush()
        break
      }

      case "session.text.delta": {
        const { sessionID, assistantMessageID, ordinal, delta } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        if (!session.streamer) break
        session.assistantMessageIDs.add(assistantMessageID)
        appendTextPart(session, assistantMessageID, ordinal, delta)

        const entry = getOrCreatePending(key, session)
        startThinking(session, assistantMessageID)
        streamThinking(entry, session, assistantMessageID, delta)

        const run = store.activeRuns.get(key)
        if (run) run.textStreamed = true

        scheduleFlush()
        break
      }

      case "session.text.ended": {
        const { sessionID, assistantMessageID, ordinal, text } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        session.assistantMessageIDs.add(assistantMessageID)
        setTextPart(session, assistantMessageID, ordinal, text)

        const posted = await tryPublishFinalMessage(client, session, assistantMessageID)
        if (posted) {
          const run = store.activeRuns.get(key)
          if (run) run.textStreamed = true
        }
        break
      }

      // ── Reasoning (thinking) output ──────────────────────────────
      case "session.reasoning.started": {
        const { sessionID, assistantMessageID } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [, session] = match
        session.assistantMessageIDs.add(assistantMessageID)
        startThinking(session, assistantMessageID)
        break
      }

      case "session.reasoning.delta": {
        const { sessionID, assistantMessageID, delta } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        if (!session.streamer) break
        const entry = getOrCreatePending(key, session)
        startThinking(session, assistantMessageID)
        streamThinking(entry, session, assistantMessageID, delta)
        scheduleFlush()
        break
      }

      // ── Steps ────────────────────────────────────────────────────
      case "session.step.started": {
        const { sessionID, assistantMessageID, model } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [, session] = match
        session.assistantMessageIDs.add(assistantMessageID)
        // A new step means any earlier failure was retried; clear it.
        session.lastError = ""
        if (model) {
          session.lastModelID = model.variant
            ? `${model.providerID}/${model.id}#${model.variant}`
            : `${model.providerID}/${model.id}`
          store.persistModelId(session)
        }
        break
      }

      case "session.step.ended": {
        const { sessionID, assistantMessageID, finish } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        session.messageFinishByID.set(assistantMessageID, finish)
        await completeThinking(key, session, assistantMessageID)

        if (finish === "stop") {
          const posted = await tryPublishFinalMessage(client, session, assistantMessageID)
          if (posted) {
            const run = store.activeRuns.get(key)
            if (run) run.textStreamed = true
          }
        }
        break
      }

      case "session.step.failed": {
        const { sessionID, assistantMessageID, error } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        console.error(`[session] step failed for ${assistantMessageID}:`, error)
        const detail = formatSessionError(error)
        if (detail) session.lastError = detail
        await completeThinking(key, session, assistantMessageID)
        break
      }

      // ── Tools ────────────────────────────────────────────────────
      case "session.tool.input.started": {
        const { sessionID, id, name } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        if (!session.streamer) break
        session.toolNames.set(id, name)
        const chunk = buildToolChunk({ id, name, status: "in_progress" })
        if (chunk) {
          const entry = getOrCreatePending(key, session)
          entry.chunks.push(chunk)
          scheduleFlush()
        }
        break
      }

      case "session.tool.called": {
        const { sessionID, id, input } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        if (!session.streamer) break
        const name = session.toolNames.get(id) ?? id
        const chunk = buildToolChunk({ id, name, input, status: "in_progress" })
        if (chunk) {
          const entry = getOrCreatePending(key, session)
          entry.chunks.push(chunk)
          scheduleFlush()
        }
        break
      }

      case "session.tool.success": {
        const { sessionID, id } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        if (!session.streamer) break
        const name = session.toolNames.get(id) ?? id
        const chunk = buildToolChunk({ id, name, status: "complete" })
        if (chunk) {
          const entry = getOrCreatePending(key, session)
          entry.chunks.push(chunk)
          scheduleFlush()
        }
        break
      }

      case "session.tool.failed": {
        const { sessionID, id } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        if (!session.streamer) break
        const name = session.toolNames.get(id) ?? id
        const chunk = buildToolChunk({ id, name, status: "error" })
        if (chunk) {
          const entry = getOrCreatePending(key, session)
          entry.chunks.push(chunk)
          scheduleFlush()
        }
        break
      }

      // ── Usage ────────────────────────────────────────────────────
      case "session.usage.updated": {
        const { sessionID, cost, tokens } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [, session] = match
        session.usage = { cost, tokens }
        break
      }

      case "session.execution.failed": {
        const { sessionID, error } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        console.error(`[session] execution failed for ${sessionID}:`, error)
        const detail = formatSessionError(error)
        if (detail) session.lastError = detail
        await finalizeSession(key, session, true)
        break
      }

      case "session.execution.interrupted": {
        const { sessionID, reason } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        console.log(`[session] execution interrupted for ${sessionID} (${reason})`)
        if (!session.lastError) session.lastError = `the run was interrupted (${reason})`
        await finalizeSession(key, session, true)
        break
      }

      // ── Execution finished → finalise ────────────────────────────
      case "session.execution.succeeded": {
        const { sessionID } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        await finalizeSession(key, session, false)
        break
      }

      case "session.idle": {
        const { sessionID } = event.data
        console.log(`[session] idle event received for sessionID=${sessionID}`)
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        console.log(`[session] idle: found session key=${key}, thinkingMessageIDs.size=${session.thinkingMessageIDs.size}`)
        // If a step failed and no execution event carried the error, surface it.
        await finalizeSession(key, session, session.lastError.trim().length > 0)
        break
      }

      default:
        break
    }
  }
}
