import type { AnyChunk } from "@slack/types"
import type { OpenCodeEvent } from "@opencode/sdk"
import type { SlackClient, SessionState } from "./types"
import type { SessionStore } from "./session"
import { buildToolChunk } from "./tools"
import { appendTextPart, setTextPart, tryPublishFinalMessage, publishPendingFinalMessages, postAssistantResponse } from "./slack"

/** Minimal structural type for the embedded OpenCode host — avoids a hard import. */
type EventSource = {
  events: { subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<OpenCodeEvent> }
}

type PendingEntry = {
  session: SessionState
  chunks: AnyChunk[]
  thinkingUpdates: Map<string, string>
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
          const safe = delta.length > 600 ? delta.slice(-600) : delta
          chunks.push({
            type: "task_update",
            id: `thinking-${messageID}`,
            title: "Thinking",
            status: "in_progress",
            output: safe,
          })
        }
      }

      if (chunks.length > 0) {
        await session.streamer.append({ chunks })
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
      flushTimer = setTimeout(flushStreamEvents, 350)
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
      await session.streamer.append({
        chunks: [{ type: "task_update", id: `thinking-${messageID}`, title: "Thinking", status: "complete" }],
      }).catch((e) => {
        console.error("Failed to complete thinking task:", e)
      })
    }
  }

  /**
   * Finish a run: flush pending stream output, publish any final message,
   * complete the working/thinking tasks, and stop the stream. Idempotent —
   * the first of `session.execution.succeeded/failed/interrupted` or
   * `session.idle` to arrive wins; later ones are no-ops.
   */
  async function finalizeSession(key: string, session: SessionState, failed: boolean, reason?: string) {
    if (!store.activeRuns.has(key)) return

    const pendingEntry = pending.get(key)
    if (pendingEntry) {
      pending.delete(key)
      await flushEntry(pendingEntry)
    }

    const published = await publishPendingFinalMessages(client, session)
    const run = store.activeRuns.get(key)
    if (run && published) run.textStreamed = true

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

      // If no text was streamed, include a fallback so the plan pane is never empty.
      if (!run.textStreamed) {
        const fallback = failed
          ? `Sorry, something went wrong${reason ? `: ${reason}` : ""}. Please try again.`
          : "I completed the request but did not receive a text response from model output."
        stopChunks.push({ type: "markdown_text", text: fallback } as AnyChunk)
        await postAssistantResponse(client, session, fallback).catch((e) => {
          console.error("Failed to post fallback response:", e)
        })
      }

      console.log(`[session] finalize: stopping streamer with ${stopChunks.length} stop chunk(s)`)
      await session.streamer.stop({ chunks: stopChunks }).catch((e) => {
        console.error("Failed to stop stream on finalize:", e)
      })

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
        await finalizeSession(key, session, true)
        break
      }

      case "session.execution.interrupted": {
        const { sessionID } = event.data
        const match = store.findBySessionId(sessionID)
        if (!match) break
        const [key, session] = match
        console.log(`[session] execution interrupted for ${sessionID}`)
        await finalizeSession(key, session, false)
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
        await finalizeSession(key, session, false)
        break
      }

      default:
        break
    }
  }
}
