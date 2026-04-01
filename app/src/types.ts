import type { App } from "@slack/bolt"

export const DATA_DIR = "/app/data"

export type SlackClient = InstanceType<typeof App>["client"]

export type TodoItem = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

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

export type MessageUsage = {
  cost: number
  tokens: SessionUsage["tokens"]
}

export type SessionState = {
  sessionId: string
  channel: string
  thread: string
  isChannel: boolean
  /** Single stream: tool activity, thinking, working task, todos, and final response. */
  streamer: ReturnType<SlackClient["chatStream"]> | null
  seenTaskIds: Set<string>
  todos: TodoItem[]
  textPartStates: Map<string, string>
  textPartToMessageID: Map<string, string>
  messagePartOrder: Map<string, string[]>
  /** Part IDs belonging to reasoning parts — excluded from the final posted message. */
  reasoningPartIDs: Set<string>
  messageFinishByID: Map<string, string>
  publishedMessageIDs: Set<string>
  thinkingMessageIDs: Set<string>
  assistantMessageIDs: Set<string>
  lastModelID: string
  usage: SessionUsage
  messageUsageById: Map<string, MessageUsage>
}

export type ActiveRunState = {
  workingTaskId: string
  textStreamed: boolean
}

export type PromptInput = {
  client: SlackClient
  channel: string
  threadTs: string
  text: string
  isChannel: boolean
  recipientTeamId?: string
  recipientUserId?: string
  setStatus?: (value: string | { status: string; loading_messages?: string[] }) => Promise<unknown>
  onError: (message: string) => Promise<void>
}
