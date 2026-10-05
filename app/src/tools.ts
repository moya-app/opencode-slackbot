import type { TaskUpdateChunk } from "@slack/types"
import { DATA_DIR } from "./types"

/**
 * Slack limit: "The character limit for chunk sizes for `task_update` and
 * `plan_update` is 256 characters." Keep every text field well under it.
 */
export const TASK_TEXT_LIMIT = 256

/** Trim text to the chunk limit, keeping the start (e.g. a SQL query). */
export function clampTaskText(value: string, limit = TASK_TEXT_LIMIT): string {
  if (value.length <= limit) return value
  return value.slice(0, limit - 1) + "…"
}

/** Trim text to the chunk limit, keeping the tail (e.g. streaming output). */
export function clampTaskTextTail(value: string, limit = TASK_TEXT_LIMIT): string {
  if (value.length <= limit) return value
  return "…" + value.slice(value.length - (limit - 1))
}

export type ToolStatus = "in_progress" | "complete" | "error"

export type ToolEvent = {
  /** Tool call ID (stable across started/called/success/failed events). */
  id: string
  /** Tool name, e.g. `read`, `grep`, `shell`, or `mcp-clickhouse_run_select_query`. */
  name: string
  /** Parsed tool input once the model has finished emitting it. */
  input?: Record<string, unknown>
  status: ToolStatus
  /** Optional streamed output shown under the task while it runs. */
  output?: string
}

/** Build a human-readable task title from the tool name and its input. */
export function toolTitle(name: string, input: Record<string, unknown> | undefined): string {
  if (name === "read") {
    const path = input?.filePath ?? input?.path
    if (typeof path === "string") return `Reading ${path.replace(DATA_DIR, "")}`
  } else if (name === "grep" && typeof input?.pattern === "string") {
    const pattern = input.pattern
    return `Searching for "${pattern.length > 40 ? pattern.slice(0, 40) + "…" : pattern}"`
  } else if (name === "glob" && typeof input?.pattern === "string") {
    const pattern = input.pattern
    return `Finding ${pattern.length > 40 ? pattern.slice(0, 40) + "…" : pattern}`
  } else if (name === "shell" && typeof input?.command === "string") {
    const command = input.command
    return `Running ${command.length > 60 ? command.slice(0, 60) + "…" : command}`
  }
  return name
}

/** Build a TaskUpdateChunk from a tool event — returns null if no chunk is needed. */
export function buildToolChunk(tool: ToolEvent): TaskUpdateChunk | null {
  const taskId = tool.id
  const title = clampTaskText(toolTitle(tool.name, tool.input))

  if (tool.status === "in_progress") {
    let output = tool.output
    if (tool.name.endsWith("run_select_query") && typeof tool.input?.query === "string") {
      output = `\`\`\`sql\n${tool.input.query}\n\`\`\``
    }
    return { type: "task_update", id: taskId, title, status: "in_progress", output: output === undefined ? undefined : clampTaskText(output) }
  }
  if (tool.status === "complete") {
    return { type: "task_update", id: taskId, title, status: "complete" }
  }
  return { type: "task_update", id: taskId, title, status: "error" }
}
