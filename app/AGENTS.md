# AGENTS.md

## Overview

This directory contains the Slack bot runtime that bridges Slack Assistant events and `@mentions` to an OpenCode V2
session. The app runs in Bun, receives user messages, forwards prompts to the shared OpenCode service over HTTP, and
streams tool/task updates and final responses back into Slack threads.

## Project Layout

- `src/index.ts`
  - Entry point. Initializes Slack Bolt (`App`, `Assistant`) and an `@opencode/client` connection to the shared
    OpenCode service.
  - `Service.ensure()` (from `@opencode/client/service`) discovers the background service or starts one
    (`opencode serve --service`) as a separate process, so the TUI and `opencode api` can attach to the same server for
    debugging. The static system prompt is injected through the highest-priority `OPENCODE_CONFIG_CONTENT` env var,
    which merges on top of the on-disk `config/opencode.jsonc`.
  - The session-specific part of the system prompt (the scratch-directory and file-sending guidance) is attached once
    per session at session begin via `opencode.session.instructions.entry.put` — V2's session-scoped instruction
    entries, the replacement for the v1 per-prompt `system` field. `ensureSessionInstructions` does this and
    `buildSessionInstructions` builds the text.
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

- `src/paths.ts`
  - Shared staging path helpers: `STAGING_ROOT` (`$TMPDIR/opencode-slack`) and `stagingDirFor(sessionId)` — the
    per-session upload/scratch directory. Used by `index.ts` (staging, sweep, permissions) and `files.ts`
    (send-time validation).

- `src/files.ts`
  - Outbound files. `extractSlackFiles` parses `<slack-file>{...}</slack-file>` directives out of the final answer
    (mirroring `<vega-lite>`); `uploadSlackFiles` resolves each path, rejects anything outside the session's own
    scratch directory (or over the size cap), and uploads it to the Slack thread via `files.uploadV2`. Gated by the
    `SEND_FILE_MAX_SIZE` env var: `0` disables sending (directives are still stripped from the text but nothing is
    uploaded and the per-session instructions omit the "Sending files to the user" guidance); otherwise it is the max
    file size in bytes (default 50 MiB).

- `src/events.ts`
  - `startEventLoop`: subscribes to the OpenCode V2 event stream and processes events in batched 1 s flush windows
    (chosen to stay under Slack's `chat.appendStream` Tier 4 rate limit).
  - Handles the V2 events: `session.text.started/delta/ended`, `session.reasoning.started/delta`,
    `session.step.started/ended/failed`, `session.tool.input.started`, `session.tool.called/success/failed`,
    `session.usage.updated`, `session.execution.succeeded/failed/interrupted`, and `session.idle`.
  - Individual `session.step.failed` / `session.tool.failed` events (denied tool calls, provider hiccups) are **not**
    run failures: they are logged, the task is marked complete, and the agent is left to recover. Only
    `session.execution.failed` (and `session.execution.interrupted`) ends the run as failed, and its structured error
    is posted to the thread via `postAssistantResponse` so genuine failures are never silent.
  - The Slack plan pane is the user-facing chain of thought and must never render an error state, so all task updates
    (`Working on your request`, `Thinking`, tool tasks) always use status `complete` on finish. Any error worth
    reporting goes in the final response text, not the chain of thought.

- `package.json`
  - Runtime scripts:
    - `start`: runs `src/index.ts` with Bun.
    - `typecheck`: runs TypeScript checks via `tsgo --noEmit`.
  - Core dependencies:
    - `@slack/bolt`
    - `@opencode/client`

- `tsconfig.json`
  - TypeScript compiler settings for this app.

- `bun.lock`
  - Bun lockfile for deterministic installs.

## Runtime Flow

1. Start Bolt app and connect to the shared OpenCode service (starting it if needed).
2. `startEventLoop` subscribes to OpenCode events in the background.
3. Receive message from Assistant pane, channel mention, or DM.
4. `runPrompt` resolves or creates a thread session via `SessionStore`. Runs are serialized per thread: a prompt waits
   for the previous run on the same thread to finalize before taking over the session state (`runQueue` in
   `src/index.ts`).
5. Open a single Slack `chatStream` with `task_display_mode: "plan"` on the thread. This single stream receives all
   chunks — working task, tool activity, thinking, and (via `streamer.stop`) the final answer — which Slack collapses
   into one grouped block.
6. Send the prompt to OpenCode via `session.prompt({ sessionID, text, files })`. Uploaded files are downloaded into a
   per-session directory under `/tmp/opencode-slack/<session>/` and listed by path in the prompt text so the agent
   reads them itself with the `read` tool. The scratch directory itself is announced once per session as a
   session-scoped system instruction (see `ensureSessionInstructions`), not repeated on each message. Pasted tables
   (inline data, not uploads) are sent as data-URI attachments. The call returns as soon as the input is admitted;
   output arrives asynchronously via events.
7. The event loop receives `session.text.delta` / `session.reasoning.delta` events, batches thinking/tool chunks, and
   flushes them to `streamer` every 1 s.
8. `session.tool.*` events create/complete the tool tasks shown in the plan pane; `todowrite` no longer exists in V2.
9. `session.step.ended` records the finish reason and completes the message's thinking task. A `stop` step publishes the
   final response via `postAssistantResponse` (a proper `chat.postMessage` with cost info and feedback buttons).
10. On `session.idle` (or `session.execution.succeeded/failed/interrupted`, whichever arrives first), remaining pending
    chunks are flushed, any un-published final message is posted, the working task is completed, the stream is stopped,
    and the run slot is released for the next prompt on the thread.
11. Only a genuine run failure (`session.execution.failed` / `session.execution.interrupted`) posts an error
    explanation; individual tool/step failures (including denied shell commands) are ignored as run failures and never
    put the plan pane into an error state. `session.idle` always finalises as success.

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
- The event loop batches chunks over 1 s windows — keep flush logic inside `flushEntry` in `src/events.ts`. A
  `rate_limited` result re-queues the chunks for the next flush; any other failure drops them.
- Runs are serialized per thread with `runQueue` in `src/index.ts`. `finalizeSession` resolves the run's `done` promise
  (which releases the next queued prompt); keep that in sync when changing the run lifecycle.
- Uploaded files live in a per-session directory under `/tmp/opencode-slack/<session>/` and are read by the agent by
  path. That same directory is the agent's only writable scratch space: `runPrompt` creates it and announces its path
  once per session through a session-scoped instruction entry (`ensureSessionInstructions`, key `slack.session`), so
  it can redirect command output (e.g. `clickhouse-client` query results) to a file and read it back without the path
  being repeated before every message. Files are **not** deleted at run end (the agent may read them partially or
  re-read them in a later turn), so `sweepStaleStaging` removes files older than 24 h hourly and at startup.
- `runPrompt` calls `session.update` to set per-session permissions that allow `external_directory`, `read`, and `edit`
  only for that session's own directory, so a session cannot read or write another session's uploads but can read and
  write its own scratch space by default. Note the global config (and the example) deny `external_directory` and `edit`
  for `*`, so those per-session allows are what grant access — if the `session.update` call fails, the agent cannot
  reach its scratch directory at all.
- To send a file to the user, the agent writes it into its session scratch directory and emits a `<slack-file>` JSON
  directive in its final answer; `postAssistantResponse` strips the directive and `uploadSlackFiles` uploads it. The
  path is confined to `stagingDirFor(session.sessionId)`, so keep that validation when changing this flow.
- `isChannel: true` is set for `app_mention` events; `postAssistantResponse` uses `reply_broadcast: true` in that case
  so the final reply surfaces in the channel.
- Feedback deduplication is handled by `SessionStore.feedbackGiven` — the first click updates the original message in
  place and sends one ephemeral; subsequent clicks are no-ops.
- Do not guess V2 field or event names. The API is generated from the OpenCode OpenAPI document; check the
  `@opencode/sdk` / `@opencode/client` types (or <https://opencode.ai/v2/docs/>) before adding event handling.
