import type { App } from "@slack/bolt"

export const DATA_DIR = "/app/data"

export type SlackClient = InstanceType<typeof App>["client"]

export type SessionUsage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type SessionState = {
  sessionId: string
  channel: string
  thread: string
  isChannel: boolean
  /** Single stream: tool activity, thinking, working task, and final response. */
  streamer: ReturnType<SlackClient["chatStream"]> | null
  /** Tool call ID → tool name, so later tool events can be titled. */
  toolNames: Map<string, string>
  /**
   * Final assistant text, keyed by assistant message ID and then by the
   * text-part ordinal the V2 API assigns within that message.
   */
  textByMessage: Map<string, Map<number, string>>
  /** Finish reason per assistant message ID (from `session.step.ended`/`failed`). */
  messageFinishByID: Map<string, string>
  publishedMessageIDs: Set<string>
  /** Assistant messages with an active in-progress "Thinking" task. */
  thinkingMessageIDs: Set<string>
  /** Assistant message IDs seen in this run — used to filter fallback publishing. */
  assistantMessageIDs: Set<string>
  lastModelID: string
  usage: SessionUsage
}

export type ActiveRunState = {
  workingTaskId: string
  textStreamed: boolean
}

export type IncomingAttachment = {
  id?: string
  name?: string
  mimetype?: string
  filetype?: string
  url_private?: string
  url_private_download?: string
}

export type PromptInput = {
  client: SlackClient
  channel: string
  threadTs: string
  text: string
  files?: IncomingAttachment[]
  /** Raw Slack attachments array — used to extract inline tables pasted into messages. */
  attachments?: any[]
  isChannel: boolean
  recipientTeamId?: string
  recipientUserId?: string
  setStatus?: (value: string | { status: string; loading_messages?: string[] }) => Promise<unknown>
  onError: (message: string) => Promise<void>
}
