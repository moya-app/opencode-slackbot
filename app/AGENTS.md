# AGENTS.md

## Overview

This directory contains the Slack bot runtime that bridges Slack Assistant events and `@mentions` to an OpenCode session. The app runs in Bun, receives user messages, forwards prompts to OpenCode, and streams tool/task updates and final responses back into Slack threads.

## Project Layout

- `src/index.ts`
  - Entry point. Initializes Slack Bolt (`App`, `Assistant`) and OpenCode SDK.
  - Creates the `SessionStore` and starts the global event loop.
  - Implements `runPrompt` (shared logic for all surfaces) and registers Slack event handlers: Assistant `userMessage`, `app_mention`, `message` (DMs), and the `feedback` button action.

- `src/types.ts`
  - All shared types: `TodoItem`, `SessionUsage`, `MessageUsage`, `SessionState`, `ActiveRunState`, `PromptInput`, `SlackClient`.
  - Exports the `DATA_DIR` constant (`/app/data`) — the agent workspace, visible to OpenCode agents. Do not use this path for bot-internal storage.

- `src/usage.ts`
  - Usage tracking utilities: `emptyUsage`, `normalizeNumber`, `parseMessageUsage`, `applyUsageDelta`.

- `src/todo.ts`
  - Todo parsing and chunk generation: `parseTodos`, `buildTodoChunks`, `todoTaskId`.
  - Each todo item is streamed as a `task_update` chunk into the live stream rather than posted as a separate Slack message. Items appear individually in the plan pane with a spinner while pending/in-progress and a tick when completed.

- `src/db.ts`
  - SQLite persistence for the Slack thread → OpenCode session mapping.
  - Database file: `/root/.local/share/opencode/slack-sessions.db` — co-located with OpenCode's own `opencode.db` and persisted via the `opencode-data` Docker named volume.
  - **Do not store bot-internal state in `/app/data`** — that directory is the agent workspace (docs, segmentation data, etc.) and is visible to OpenCode agents running inside the session.
  - Persists per thread: `channel`, `thread_ts`, `opencode_session_id`, `is_channel`, `last_model_id`, `created_at`, `updated_at`.
  - Exports: `upsertSession`, `updateSessionMeta`, `loadAllSessions`, `deleteSession`.

- `src/session.ts`
  - `SessionStore` class. Owns the `sessions` map (keyed `${channel}-${threadTs}`), the `activeRuns` map, and the `feedbackGiven` set (used to deduplicate feedback button responses).
  - Provides `createSessionState`, `resetRunState`, `findBySessionId`, `persistSession`, `persistModelId`, and `restore`.
  - `restore()` is called at startup: loads all rows from the DB and hydrates the in-memory map with `streamer: null` — any streams active at the time of a prior restart are treated as cancelled.

- `src/slack.ts`
  - All Slack message posting helpers: `postAssistantResponse`, `postResponseMeta`, `publishPendingFinalMessages`, `tryPublishFinalMessage`, `splitTextForSlack`, `registerTextPart`, `buildMessageText`, `clearTextPartsForMessage`, `feedbackBlock`.
- `src/tools.ts`
  - `buildToolChunk`: translates a `ToolPart` from the OpenCode SDK into a Slack `TaskUpdateChunk`.

- `src/chart.ts`
  - Vega-Lite chart rendering: `extractVegaLiteSpecs` parses `<vega-lite>...</vega-lite>` tags from response text, `renderAndUploadCharts` compiles specs to PNG (via `vega` + `vega-lite` + `@resvg/resvg-js`) and uploads them to the Slack thread.

- `src/events.ts`
  - `startEventLoop`: subscribes to the OpenCode event stream and processes events in batched 350 ms flush windows. Handles `session.idle`, `message.updated`, `todo.updated`, `message.part.delta`, and `message.part.updated`.

- `package.json`
  - Runtime scripts:
    - `start`: runs `src/index.ts` with Bun.
    - `typecheck`: runs TypeScript checks via `tsgo --noEmit`.
  - Core dependencies:
    - `@slack/bolt`
    - `@opencode-ai/sdk`

- `tsconfig.json`
  - TypeScript compiler settings for this app.

- `bun.lock`
  - Bun lockfile for deterministic installs.

## Runtime Flow

1. Start Bolt app and OpenCode server.
2. `startEventLoop` subscribes to OpenCode events in the background.
3. Receive message from Assistant pane, channel mention, or DM.
4. `runPrompt` resolves or creates a thread session via `SessionStore`.
5. Open a single Slack `chatStream` with `task_display_mode: "plan"` on the thread. This single stream receives all chunks — working task, tool activity, thinking, todos, and (via `streamer.stop`) the final answer — which Slack collapses into one grouped block.
6. Send the prompt to OpenCode via `session.prompt`.
7. Event loop receives `message.part.delta` / `message.part.updated` events, batches tool/thinking chunks, and flushes them to `streamer` every 350 ms.
8. `todo.updated` events diff the previous and next todo list via `buildTodoChunks` and emit `task_update` chunks to the same `streamer` — each item appears individually in the plan pane with a spinner while pending/in-progress and a tick when completed.
9. When a message finishes (`message.updated` with a `finish` value), any active thinking task for that message is immediately completed on `streamer`.
10. On `session.idle`, remaining pending chunks are flushed, the final response is published via `postAssistantResponse` (a proper `chat.postMessage` with cost info and feedback buttons), and the stream is stopped.

## Session State

Each thread session (`SessionState`) tracks:

- OpenCode `sessionId`
- Slack `channel`, `thread`, and `isChannel` flag
- Active `streamer` while a prompt is running (tool activity, thinking, working task, todos, final answer)
- `seenTaskIds` — tool task IDs already sent to Slack
- `todos` — parsed todo list from `todowrite`
- `textPartStates` — accumulated text per part ID
- `textPartToMessageID` / `messagePartOrder` — mapping from parts to messages
- `messageFinishByID` — finish reason per message ID
- `publishedMessageIDs` — messages already posted to Slack
- `thinkingMessageIDs` — messages with an active in-progress thinking task
- `assistantMessageIDs` — IDs of assistant-role messages (used to filter out user messages from fallback publishing)
- `lastModelID`, `usage`, `messageUsageById` — cost/token tracking

## Notes for Future Changes

- Keep assistant, mention, and DM handlers aligned by extending `runPrompt` rather than duplicating logic.
- Add new tool-specific rendering inside `buildToolChunk` in `src/tools.ts`.
- The event loop batches chunks over 350 ms windows — keep flush logic inside `flushEntry` in `src/events.ts`.
- `isChannel: true` is set for `app_mention` events; `postAssistantResponse` uses `reply_broadcast: true` in that case so the final reply surfaces in the channel.
- Feedback deduplication is handled by `SessionStore.feedbackGiven` — the first click updates the original message in place and sends one ephemeral; subsequent clicks are no-ops.
