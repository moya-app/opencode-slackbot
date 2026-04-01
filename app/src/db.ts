import { Database } from "bun:sqlite"
import { join } from "node:path"

/** OpenCode's own data directory — same place it stores opencode.db and session storage.
 *  Persisted via the opencode-data Docker volume so sessions survive container restarts. */
const OPENCODE_DATA_DIR = "/root/.local/share/opencode"

export type PersistedSession = {
  channel: string
  threadTs: string
  opencodeSessionId: string
  isChannel: boolean
  lastModelId: string
  createdAt: number
  updatedAt: number
}

const DB_PATH = join(OPENCODE_DATA_DIR, "slack-sessions.db")

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db
  _db = new Database(DB_PATH, { create: true })
  _db.exec("PRAGMA journal_mode=WAL")
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      channel           TEXT    NOT NULL,
      thread_ts         TEXT    NOT NULL,
      opencode_session_id TEXT  NOT NULL,
      is_channel        INTEGER NOT NULL DEFAULT 0,
      last_model_id     TEXT    NOT NULL DEFAULT '',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (channel, thread_ts)
    )
  `)
  return _db
}

export function upsertSession(session: PersistedSession): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO sessions (channel, thread_ts, opencode_session_id, is_channel, last_model_id, created_at, updated_at)
    VALUES ($channel, $threadTs, $opencodeSessionId, $isChannel, $lastModelId, $createdAt, $updatedAt)
    ON CONFLICT (channel, thread_ts) DO UPDATE SET
      opencode_session_id = excluded.opencode_session_id,
      is_channel          = excluded.is_channel,
      last_model_id       = excluded.last_model_id,
      updated_at          = excluded.updated_at
  `).run({
    $channel: session.channel,
    $threadTs: session.threadTs,
    $opencodeSessionId: session.opencodeSessionId,
    $isChannel: session.isChannel ? 1 : 0,
    $lastModelId: session.lastModelId,
    $createdAt: session.createdAt,
    $updatedAt: session.updatedAt,
  })
}

export function updateSessionMeta(channel: string, threadTs: string, fields: { lastModelId?: string }): void {
  if (fields.lastModelId === undefined) return
  const db = getDb()
  db.prepare(`
    UPDATE sessions SET last_model_id = $lastModelId, updated_at = $updatedAt
    WHERE channel = $channel AND thread_ts = $threadTs
  `).run({
    $lastModelId: fields.lastModelId,
    $updatedAt: Date.now(),
    $channel: channel,
    $threadTs: threadTs,
  })
}

export function loadAllSessions(): PersistedSession[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT channel, thread_ts, opencode_session_id, is_channel, last_model_id, created_at, updated_at
    FROM sessions
    ORDER BY updated_at DESC
  `).all() as Array<{
    channel: string
    thread_ts: string
    opencode_session_id: string
    is_channel: number
    last_model_id: string
    created_at: number
    updated_at: number
  }>

  return rows.map((row) => ({
    channel: row.channel,
    threadTs: row.thread_ts,
    opencodeSessionId: row.opencode_session_id,
    isChannel: row.is_channel === 1,
    lastModelId: row.last_model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function deleteSession(channel: string, threadTs: string): void {
  getDb().prepare("DELETE FROM sessions WHERE channel = $channel AND thread_ts = $threadTs").run({
    $channel: channel,
    $threadTs: threadTs,
  })
}
