import type { TaskUpdateChunk } from "@slack/types"
import type { ToolPart } from "@opencode-ai/sdk"
import type { SessionState } from "./types"
import { DATA_DIR } from "./types"
import { parseTodos } from "./todo"

/** Build a TaskUpdateChunk from a tool part — returns null if no chunk needed */
export function buildToolChunk(part: ToolPart, session: SessionState): TaskUpdateChunk | null {
  const { seenTaskIds } = session
  const taskId = part.id
  const { state } = part

  let title: string = part.tool
  if ("title" in state && state.title) title = state.title

  if (part.tool === "read" && state.input.filePath) {
    const rel_path = (state.input.filePath as string).replace(DATA_DIR + "/", "")
    title = `Reading from ${rel_path}`
  }

  if (state.status === "running") {
    seenTaskIds.add(taskId)
    let output: any
    if (part.tool === "todowrite") {
      const todos = parseTodos(state.input.todos)
      if (todos.length > 0) {
        session.todos = todos
      }
      return null
    } else if (part.tool === "mcp-clickhouse_run_select_query") {
      const query = part.state?.input?.query as string
      output = `\`\`\`sql\n${query}\n\`\`\``
    }
    return { type: "task_update", id: taskId, title, status: "in_progress", output }
  } else if (state.status === "completed") {
    return { type: "task_update", id: taskId, title, status: "complete" }
  } else if (state.status === "error") {
    return { type: "task_update", id: taskId, title, status: "error" }
  }

  return null
}
