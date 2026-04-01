import type { TaskUpdateChunk } from "@slack/types"
import type { TodoItem } from "./types"

/** Derive a stable stream task ID from a todo's content string. */
export function todoTaskId(content: string): string {
  // Replace non-alphanumeric runs with hyphens and truncate for readability
  return "todo-" + content.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
}

/** Map a todo status to the TaskUpdateChunk status field. */
function todoChunkStatus(status: TodoItem["status"]): TaskUpdateChunk["status"] {
  if (status === "completed") return "complete"
  if (status === "cancelled") return "error"
  // pending and in_progress both show as in_progress (spinner)
  return "in_progress"
}

/**
 * Diff previous and next todo lists and return task_update chunks for any
 * items that are new or whose status changed. Items are matched by content.
 */
export function buildTodoChunks(previous: TodoItem[], next: TodoItem[]): TaskUpdateChunk[] {
  const prevByContent = new Map(previous.map((t) => [t.content, t]))
  const chunks: TaskUpdateChunk[] = []

  for (const todo of next) {
    const prev = prevByContent.get(todo.content)
    if (prev && prev.status === todo.status) continue // unchanged

    chunks.push({
      type: "task_update",
      id: todoTaskId(todo.content),
      title: todo.content,
      status: todoChunkStatus(todo.status),
    })
  }

  return chunks
}

export function parseTodos(input: unknown): TodoItem[] {
  if (!input || !Array.isArray(input)) return []

  const todos: TodoItem[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const todo = item as Record<string, unknown>
    const content = typeof todo.content === "string" ? todo.content : null
    const status = typeof todo.status === "string" ? todo.status : null
    const priority = typeof todo.priority === "string" ? todo.priority : null

    if (!content) continue
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") continue
    if (priority !== "high" && priority !== "medium" && priority !== "low") continue

    todos.push({ content, status, priority })
  }
  return todos
}
