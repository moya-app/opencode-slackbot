# AGENTS.md

## Overview

This directory contains the Slack bot runtime that bridges Slack Assistant events and `@mentions` to an OpenCode V2
session. The app runs in Bun, receives user messages, forwards prompts to an embedded OpenCode host, and streams
tool/task updates and final responses back into Slack threads.

## Project Layout

- `src/index.ts`
  - Entry point. Initializes Slack Bolt (`App`, `Assistant`) and the embedded OpenCode V2 host
    (`OpenCode.create(...)` from `@opencode/sdk`).
  - The host runs in-process (no HTTP listener). The system prompt and any inline overrides are passed through the
    host's `config.content` layer, which merges on top of the on-disk `config/opencode.jsonc`.
  - Creates the `SessionStore` and starts the global event loop.
  - Implements `runPrompt` (shared logic for all surfaces) and registers Slack event handlers: Assistant `userMessage`,
    `app_mention`, `message` (DMs), and the `feedback` button action.

- `src/types.ts`
  - All shared types: `SessionUsage`, `SessionState`, `ActiveRunState`, `PromptInput`, `SlackClient`.
  - Exports the `DATA_DIR` constant (`/app/data`) — the agent workspace, visible to OpenCode agents. Do not use this
    path for bot-internal storage.

- `src/usage.ts`
  - `emptyUsage()` builds the zero-valued `SessionUsage` used when a run starts.

- `src/db.ts`
  - SQLite persistence for the Slack thread → OpenCode session mapping.
  - Database file: `/root/.local/share/opencode/slack-sessions.db` — co-located with OpenCode's own `opencode.db` and
    persisted via the `opencode-data` Docker named volume.
  - **Do not store bot-internal state in `/app/data`** — that directory is the agent workspace (docs, segmentation
    data, etc.) and is visible to OpenCode agents running inside the session.
  - Persists per thread: `channel`, `thread_ts`, `opencode_session_id`, `is_channel`, `last_model_id`, `created_at`,
    `updated_at`.
  - Exports: `upsertSession`, `updateSessionMeta`, `loadAllSessions`, `deleteSession`.

- `src/session.ts`
  - `SessionStore` class. Owns the `sessions` map (keyed `${channel}-${threadTs}`), the `activeRuns` map, and the
    `feedbackGiven` set (used to deduplicate feedback button responses).
  - Provides `createSessionState`, `resetRunState`, `findBySessionId`, `persistSession`, `persistModelId`, and
    `restore`.
  - `restore()` is called at startup: loads all rows from the DB and hydrates the in-memory map with `streamer: null` —
    any streams active at the time of a prior restart are treated as cancelled.

- `src/slack.ts`
  - All Slack message posting helpers: `postAssistantResponse`, `postResponseMeta`, `publishPendingFinalMessages`,
    `tryPublishFinalMessage`, `splitTextForSlack`, `setTextPart`, `appendTextPart`, `buildMessageText`, `feedbackBlock`.
- `src/tools.ts`
  - `buildToolChunk`: translates a V2 tool event into a Slack `TaskUpdateChunk`, deriving a human-readable title from
    the tool name and input.

- `src/chart.ts`
  - Vega-Lite chart rendering: `extractVegaLiteSpecs` parses `<vega-lite>...</vega-lite>` tags from response text,
    `renderAndUploadCharts` compiles specs to PNG (via `vega` + `vega-lite` + `@resvg/resvg-js`) and uploads them to
    the Slack thread.

- `src/events.ts`
  - `startEventLoop`: subscribes to the OpenCode V2 event stream and processes events in batched 1 s flush windows
    (chosen to stay under Slack's `chat.appendStream` Tier 4 rate limit).
  - Handles the V2 events: `session.text.started/delta/ended`, `session.reasoning.started/delta`,
    `session.step.started/ended/failed`, `session.tool.input.started`, `session.tool.called/success/failed`,
    `session.usage.updated`, `session.execution.succeeded/failed/interrupted`, and `session.idle`.
  - Structured errors (`session.step.failed` / `session.execution.failed`) are captured on the session and always
    posted back to the Slack thread via `postAssistantResponse`, so failures are never silent.

- `package.json`
  - Runtime scripts:
    - `start`: runs `src/index.ts` with Bun.
    - `typecheck`: runs TypeScript checks via `tsgo --noEmit`.
  - Core dependencies:
    - `@slack/bolt`
    - `@opencode/sdk`

- `tsconfig.json`
  - TypeScript compiler settings for this app.

- `bun.lock`
  - Bun lockfile for deterministic installs.

## Runtime Flow

1. Start Bolt app and the embedded OpenCode V2 host.
2. `startEventLoop` subscribes to OpenCode events in the background.
3. Receive message from Assistant pane, channel mention, or DM.
4. `runPrompt` resolves or creates a thread session via `SessionStore`.
5. Open a single Slack `chatStream` with `task_display_mode: "plan"` on the thread. This single stream receives all
   chunks — working task, tool activity, thinking, and (via `streamer.stop`) the final answer — which Slack collapses
   into one grouped block.
6. Send the prompt to OpenCode via `session.prompt({ sessionID, text, files })` (images and pasted tables are sent as
   data-URI attachments). The call returns as soon as the input is admitted; output arrives asynchronously via events.
7. The event loop receives `session.text.delta` / `session.reasoning.delta` events, batches thinking/tool chunks, and
   flushes them to `streamer` every 1 s.
8. `session.tool.*` events create/complete the tool tasks shown in the plan pane; `todowrite` no longer exists in V2.
9. `session.step.ended` records the finish reason and completes the message's thinking task. A `stop` step publishes the
   final response via `postAssistantResponse` (a proper `chat.postMessage` with cost info and feedback buttons).
10. On `session.idle` (or `session.execution.succeeded/failed/interrupted`, whichever arrives first), remaining pending
    chunks are flushed, any un-published final message is posted, the working task is completed, and the stream is
    stopped.
11. If the run failed, the structured error is posted to the thread (and shown in the plan pane) so the user sees what
    went wrong instead of a silent stop.

## Session State

Each thread session (`SessionState`) tracks:

- OpenCode `sessionId`
- Slack `channel`, `thread`, and `isChannel` flag
- Active `streamer` while a prompt is running (tool activity, thinking, working task, final answer)
- `toolNames` — tool call ID → tool name, so later tool events can be titled
- `textByMessage` — final assistant text per message ID, keyed by text-part ordinal
- `messageFinishByID` — finish reason per assistant message ID
- `publishedMessageIDs` — messages already posted to Slack
- `thinkingMessageIDs` — messages with an active in-progress thinking task
- `assistantMessageIDs` — assistant message IDs seen in the run (used to filter fallback publishing)
- `lastModelID`, `usage` — model and cost/token tracking

## Notes for Future Changes

- Keep assistant, mention, and DM handlers aligned by extending `runPrompt` rather than duplicating logic.
- Add new tool-specific rendering inside `buildToolChunk` in `src/tools.ts`.
- The event loop batches chunks over 1 s windows — keep flush logic inside `flushEntry` in `src/events.ts`.
- `isChannel: true` is set for `app_mention` events; `postAssistantResponse` uses `reply_broadcast: true` in that case
  so the final reply surfaces in the channel.
- Feedback deduplication is handled by `SessionStore.feedbackGiven` — the first click updates the original message in
  place and sends one ephemeral; subsequent clicks are no-ops.
- Do not guess V2 field or event names. The API is generated from the OpenCode OpenAPI document; check the
  `@opencode/sdk` / `@opencode/client` types (or <https://opencode.ai/v2/docs/>) before adding event handling.
