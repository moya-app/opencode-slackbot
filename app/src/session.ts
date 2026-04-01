import type { SessionState, ActiveRunState } from "./types"
import { emptyUsage } from "./usage"
import { upsertSession, updateSessionMeta, loadAllSessions } from "./db"

export class SessionStore {
  /** Per-thread session state, keyed by `${channel}-${threadTs}` */
  readonly sessions = new Map<string, SessionState>()

  /** Active prompt runs, keyed by same session key */
  readonly activeRuns = new Map<string, ActiveRunState>()

  /** Tracks which messages already received feedback (Bug 3 fix).
   *  Keyed by `${channelId}-${messageTs}` */
  readonly feedbackGiven = new Set<string>()

  get(key: string): SessionState | undefined {
    return this.sessions.get(key)
  }

  set(key: string, session: SessionState): void {
    this.sessions.set(key, session)
  }

  findBySessionId(sessionId: string): [string, SessionState] | null {
    for (const entry of this.sessions.entries()) {
      const [, session] = entry
      if (session.sessionId === sessionId) return entry
    }
    return null
  }

  createSessionState(
    sessionId: string,
    channel: string,
    thread: string,
    isChannel: boolean,
  ): SessionState {
    return {
      sessionId,
      channel,
      thread,
      isChannel,
      streamer: null,
      seenTaskIds: new Set(),
      todos: [],
      textPartStates: new Map(),
      textPartToMessageID: new Map(),
      messagePartOrder: new Map(),
      messageFinishByID: new Map(),
      publishedMessageIDs: new Set(),
      thinkingMessageIDs: new Set(),
      assistantMessageIDs: new Set(),
      lastModelID: "",
      usage: emptyUsage(),
      messageUsageById: new Map(),
    }
  }

  /**
   * Persist a newly created session to the database so it survives restarts.
   * Call this immediately after createSessionState + store.set().
   */
  persistSession(key: string, session: SessionState): void {
    const [channel, ...rest] = key.split("-")
    const threadTs = rest.join("-")
    upsertSession({
      channel,
      threadTs,
      opencodeSessionId: session.sessionId,
      isChannel: session.isChannel,
      lastModelId: session.lastModelID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  /**
   * Flush a model ID change to the database. Call when lastModelID is updated.
   */
  persistModelId(session: SessionState): void {
    updateSessionMeta(session.channel, session.thread, { lastModelId: session.lastModelID })
  }

  /**
   * Load all sessions from the database and hydrate the in-memory map.
   * All streamers start as null — any streams active at the time of a prior
   * restart are considered cancelled.
   */
  restore(): number {
    const rows = loadAllSessions()
    for (const row of rows) {
      const key = `${row.channel}-${row.threadTs}`
      if (this.sessions.has(key)) continue // already in memory (shouldn't happen on startup)
      const session = this.createSessionState(
        row.opencodeSessionId,
        row.channel,
        row.threadTs,
        row.isChannel,
      )
      session.lastModelID = row.lastModelId
      this.sessions.set(key, session)
    }
    return rows.length
  }

  resetRunState(session: SessionState): void {
    session.seenTaskIds = new Set()
    session.todos = []
    session.textPartStates = new Map()
    session.textPartToMessageID = new Map()
    session.messagePartOrder = new Map()
    session.messageFinishByID = new Map()
    session.publishedMessageIDs = new Set()
    session.thinkingMessageIDs = new Set()
    session.assistantMessageIDs = new Set()
    session.lastModelID = ""
    session.usage = emptyUsage()
    session.messageUsageById = new Map()
    // streamer is nulled by the event loop after stopping; reset here defensively
    session.streamer = null
  }
}
