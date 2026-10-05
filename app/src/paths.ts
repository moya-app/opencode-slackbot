import { tmpdir } from "node:os"
import { join } from "node:path"

/** Root for per-session upload/scratch directories. */
export const STAGING_ROOT = join(tmpdir(), "opencode-slack")

/** Stable per-session directory (the session id is not path-safe). */
export function stagingDirFor(sessionId: string): string {
  return join(STAGING_ROOT, sessionId.replace(/[^a-zA-Z0-9._-]/g, "_"))
}
