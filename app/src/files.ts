import { readFile, realpath, stat } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"

import type { SessionState, SlackClient } from "./types"
import { stagingDirFor } from "./paths"
import { settings } from "./settings"

export type SlackFileRequest = {
  /** Absolute path the model asked to send (validated against the session dir). */
  path: string
  title?: string
  filename?: string
  comment?: string
}

/**
 * Extract `<slack-file>...</slack-file>` directives from response text. Each
 * block's body is a JSON object:
 *
 *   {"path": "/tmp/opencode-slack/<session>/out.csv", "title": "…", "comment": "…"}
 *
 * Tags are ALWAYS removed from the output text, even when malformed, so a bad
 * directive never leaks to the user as raw markup.
 */
export function extractSlackFiles(text: string): { cleanedText: string; files: SlackFileRequest[] } {
  const files: SlackFileRequest[] = []
  const cleanedText = text.replace(/<slack-file>([\s\S]*?)<\/slack-file>/g, (_match, body: string) => {
    try {
      const parsed = JSON.parse(body.trim()) as Record<string, unknown>
      const path = typeof parsed.path === "string" ? parsed.path.trim() : ""
      if (!path) throw new Error("directive is missing a non-empty 'path'")
      files.push({
        path,
        title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
        filename: typeof parsed.filename === "string" ? parsed.filename.trim() : undefined,
        comment: typeof parsed.comment === "string" ? parsed.comment.trim() : undefined,
      })
    } catch (e) {
      console.error("Failed to parse <slack-file> directive (tag still stripped from output):", e)
      return "\n\n_⚠ A file attachment was requested but its directive was malformed._\n\n"
    }
    return "" // remove the tag; the file will be uploaded
  })

  return { cleanedText: cleanedText.trim(), files }
}

/** True when `child` is inside `dir` (both must be absolute, resolved paths). */
function isInside(dir: string, child: string): boolean {
  if (child === dir) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return child.startsWith(prefix)
}

/**
 * Upload files the agent asked to send to the Slack thread. Each path is
 * resolved (following symlinks) and must live inside the session's own scratch
 * directory, so a session cannot exfiltrate arbitrary files from the host.
 */
export async function uploadSlackFiles(
  client: SlackClient,
  session: SessionState,
  requests: SlackFileRequest[],
): Promise<void> {
  if (requests.length === 0) return
  // SEND_FILE_MAX_SIZE = 0 disables outbound files entirely.
  const maxSize = settings.SEND_FILE_MAX_SIZE
  if (maxSize <= 0) return

  const allowedDir = await realpath(stagingDirFor(session.sessionId)).catch(() => null)
  if (!allowedDir) {
    console.error(`Session scratch directory is missing; cannot send files for session ${session.sessionId}`)
    return
  }

  for (const request of requests) {
    try {
      const resolved = await realpath(resolve(request.path)).catch(() => null)
      if (!resolved || !isInside(allowedDir, resolved)) {
        console.error(`Refusing to send file outside the session scratch directory: ${request.path}`)
        continue
      }

      const info = await stat(resolved)
      if (!info.isFile()) {
        console.error(`Refusing to send non-file path: ${request.path}`)
        continue
      }
      if (info.size > maxSize) {
        console.error(`Refusing to send file larger than ${maxSize} bytes: ${resolved} (${info.size} bytes)`)
        continue
      }

      const content = await readFile(resolved)
      const options: Record<string, unknown> = {
        channel_id: session.channel,
        thread_ts: session.thread,
        filename: request.filename || basename(resolved),
        file: content,
      }
      if (request.title) options.title = request.title
      if (request.comment) options.initial_comment = request.comment

      await client.files.uploadV2(options as any)
      console.log(`Sent file to Slack thread: ${resolved} (${info.size} bytes)`)
    } catch (e) {
      console.error(`Failed to send file "${request.path}" to Slack:`, e)
    }
  }
}
