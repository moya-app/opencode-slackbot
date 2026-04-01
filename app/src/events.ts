import type { AnyChunk } from "@slack/types"
import type { SlackClient, SessionState } from "./types"
import type { SessionStore } from "./session"
import { parseMessageUsage, applyUsageDelta, emptyUsage } from "./usage"
import { parseTodos, buildTodoChunks } from "./todo"
import { buildToolChunk } from "./tools"
import { tryPublishFinalMessage, publishPendingFinalMessages, postAssistantResponse, registerTextPart, clearTextPartsForMessage } from "./slack"

type PendingEntry = {
  session: SessionState
  chunks: AnyChunk[]
  thinkingUpdates: Map<string, string>
}

export async function startEventLoop(
  opencode: { client: { event: { subscribe: () => Promise<{ stream: AsyncIterable<any> }> } } },
  client: SlackClient,
  store: SessionStore,
): Promise<void> {
  const events = await opencode.client.event.subscribe()

  const pending = new Map<string, PendingEntry>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  async function flushEntry(entry: PendingEntry) {
    const { session, chunks, thinkingUpdates } = entry

    if (!session.streamer) return
    try {
      if (thinkingUpdates.size > 0) {
        for (const [messageID, delta] of thinkingUpdates.entries()) {
          // Only add thinking update if this messageID hasn't already been completed
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

  for await (const event of events.stream) {
    //console.log(event)
    const eventAny = event as any

    // On idle the task has completed so handle any message flushes, complete all tasks, give final message and cost
    // summary to user
    if (event.type === "session.idle") {
      const match = store.findBySessionId(event.properties.sessionID)
      if (!match) continue
      const [key, session] = match

      const pendingEntry = pending.get(key)
      if (pendingEntry) {
        pending.delete(key)
        await flushEntry(pendingEntry)
      }

      const published = await publishPendingFinalMessages(client, session)
      if (published) {
        const run = store.activeRuns.get(key)
        if (run) run.textStreamed = true
      }

      const run = store.activeRuns.get(key)
      if (run && session.streamer) {
        await session.streamer.append({
          chunks: [{ type: "task_update", id: run.workingTaskId, title: "Working on your request", status: "complete" }],
        }).catch((e) => {
          console.error("Failed to append completed working task update:", e)
        })

        // Complete any remaining thinking tasks not already completed by message.updated
        if (session.thinkingMessageIDs.size > 0) {
          const completeThinkingChunks: AnyChunk[] = []
          for (const messageID of session.thinkingMessageIDs) {
            completeThinkingChunks.push({
              type: "task_update",
              id: `thinking-${messageID}`,
              title: "Thinking",
              status: "complete",
            })
          }
          await session.streamer.append({ chunks: completeThinkingChunks }).catch((e) => {
            console.error("Failed to complete thinking task updates:", e)
          })
        }

        // If no text was streamed, post a fallback assistant message with cost/feedback
        // via postAssistantResponse (so it gets the feedback buttons) rather than
        // embedding it in streamer.stop() which would not include them.
        if (!run.textStreamed) {
          await postAssistantResponse(
            client,
            session,
            "I completed the request but did not receive a text response from model output.",
          ).catch((e) => {
            console.error("Failed to post no-text fallback response:", e)
          })
        }

        await session.streamer.stop({
          chunks: [],
        }).catch((e) => {
          console.error("Failed to stop stream on idle:", e)
        })

        session.streamer = null
      }

      store.activeRuns.delete(key)
      store.resetRunState(session)
    } else if (event.type === "message.updated") {
      const info = event.properties.info
      const match = store.findBySessionId(info.sessionID)
      if (!match) continue
      const [key, session] = match

      if (info.role !== "assistant") {
        // Clean up any text parts registered for non-assistant messages
        // so they don't appear in fallback publishing
        clearTextPartsForMessage(session, info.id)
        continue
      }

      session.assistantMessageIDs.add(info.id)

      const nextUsage = parseMessageUsage(info)
      const previousUsage = session.messageUsageById.get(info.id) ?? emptyUsage()

      applyUsageDelta(session.usage, previousUsage, nextUsage)
      session.messageUsageById.set(info.id, nextUsage)
      if (typeof info.modelID === "string" && info.modelID.length > 0) {
        session.lastModelID = info.modelID
      }

      if (typeof info.finish === "string") {
        session.messageFinishByID.set(info.id, info.finish)

        // when a message finishes (any finish value), immediately complete its thinking task so it stops flashing.
        // Don't wait for session.idle.
        if (session.thinkingMessageIDs.has(info.id) && session.streamer) {
          const pendingEntry = pending.get(key)
          if (pendingEntry) {
            pendingEntry.thinkingUpdates.delete(info.id)
          }
          session.thinkingMessageIDs.delete(info.id)
          await session.streamer.append({
            chunks: [{
              type: "task_update",
              id: `thinking-${info.id}`,
              title: "Thinking",
              status: "complete",
            }],
          }).catch((e) => {
            console.error("Failed to complete thinking on message finish:", e)
          })
        }
      }

      if (info.finish === "stop") {
        const posted = await tryPublishFinalMessage(client, session, info.id)
        if (posted) {
          const run = store.activeRuns.get(key)
          if (run) run.textStreamed = true
        }
      }
    } else if (event.type === "todo.updated") {
      const match = store.findBySessionId(event.properties.sessionID)
      if (!match) continue
      const [key, session] = match
      const nextTodos = parseTodos(event.properties.todos as unknown)
      const todoChunks = buildTodoChunks(session.todos, nextTodos)
      session.todos = nextTodos

      if (todoChunks.length > 0) {
        const entry = getOrCreatePending(key, session)
        entry.chunks.push(...todoChunks)
        scheduleFlush()
      }
    } else if (eventAny.type === "message.part.delta") {
      if (eventAny.properties?.field !== "text") continue

      const match = store.findBySessionId(eventAny.properties?.sessionID)
      if (!match) continue
      const [key, session] = match
      if (!session.streamer) continue

      const partId = eventAny.properties?.partID
      const messageID = eventAny.properties?.messageID
      const delta = eventAny.properties?.delta
      if (typeof partId !== "string" || partId.length === 0) continue
      if (typeof messageID !== "string" || messageID.length === 0) continue
      if (typeof delta !== "string" || delta.length === 0) continue

      // Reasoning-part deltas feed the thinking stream task but must not be
      // registered as publishable text — they are thinking traces, not the
      // final answer. (gpt-5.4 and other reasoning models emit reasoning parts
      // before the actual text part, causing the full thought chain to appear
      // in the posted Slack message if we don't exclude them here.)
      if (session.reasoningPartIDs.has(partId)) {
        const entry = getOrCreatePending(key, session)
        if (!session.thinkingMessageIDs.has(messageID) && !session.messageFinishByID.has(messageID)) {
          session.thinkingMessageIDs.add(messageID)
        }
        if (session.thinkingMessageIDs.has(messageID)) {
          const prevDelta = entry.thinkingUpdates.get(messageID) || ""
          entry.thinkingUpdates.set(messageID, prevDelta + delta)
        }
        scheduleFlush()
        continue
      }

      registerTextPart(session, messageID, partId)

      const previous = session.textPartStates.get(partId) || ""
      const next = previous + delta
      session.textPartStates.set(partId, next)

      // Mark as thinking on the very first delta for this message — regardless of
      // finish state. message.updated may arrive before or after deltas (no ordering
      // guarantee), so we can't use messageFinishByID to decide. The thinking task
      // is completed in the message.updated handler when finish is set.
      const entry = getOrCreatePending(key, session)
      if (!session.thinkingMessageIDs.has(messageID) && !session.messageFinishByID.has(messageID)) {
        session.thinkingMessageIDs.add(messageID)
      }
      if (session.thinkingMessageIDs.has(messageID)) {
        const prevDelta = entry.thinkingUpdates.get(messageID) || ""
        entry.thinkingUpdates.set(messageID, prevDelta + delta)
      }

      const run = store.activeRuns.get(key)
      if (run) run.textStreamed = true

      // If this message already has finish=stop (message.updated arrived before
      // all deltas), attempt to publish now that we have more text.
      const posted = await tryPublishFinalMessage(client, session, messageID)
      if (posted) {
        const activeRun = store.activeRuns.get(key)
        if (activeRun) activeRun.textStreamed = true
      }

      scheduleFlush()
    } else if (event.type === "message.part.updated") {
      const part = event.properties.part
      const match = store.findBySessionId(part.sessionID)
      if (!match) continue
      const [key, session] = match
      if (!session.streamer) continue

      const entry = getOrCreatePending(key, session)

      if (part.type === "tool") {
        const chunk = buildToolChunk(part, session)
        if (chunk) entry.chunks.push(chunk)
      } else if (part.type === "reasoning") {
        // Mark this part ID so its text deltas are routed to the thinking stream
        // only — not accumulated into the publishable message text.
        session.reasoningPartIDs.add(part.id)
      } else if (part.type === "text") {
        registerTextPart(session, part.messageID, part.id)
        const previous = session.textPartStates.get(part.id) || ""
        const next = typeof part.text === "string" ? part.text : previous
        if (next !== previous) {
          session.textPartStates.set(part.id, next)

          // Bug 1: only queue thinking updates for messages not already finished
          if (session.thinkingMessageIDs.has(part.messageID)) {
            if (next.startsWith(previous)) {
              const delta = next.slice(previous.length)
              if (delta.length > 0) {
                const prevDelta = entry.thinkingUpdates.get(part.messageID) || ""
                entry.thinkingUpdates.set(part.messageID, prevDelta + delta)
              }
            } else if (next.length > 0) {
              entry.thinkingUpdates.set(part.messageID, next)
            }
          }

          const posted = await tryPublishFinalMessage(client, session, part.messageID)
          if (posted) {
            const run = store.activeRuns.get(key)
            if (run) run.textStreamed = true
          }
        }
      }

      scheduleFlush()
    }
  }
}
