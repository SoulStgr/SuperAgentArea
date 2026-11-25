/** Open a DSH Session in the workspace after ensuring the session catalog is loaded, and create a Project's one on first use. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Thrown by `openKnownSession` when the host Session catalog is not ready or does not list the target Session.
 * The management panel catches it to display a localized error message.
 */
export class SessionNavigationError extends Error {
  constructor(readonly code: 'not-ready' | 'not-listed') { super(code) }
}

/** Select `id` in the workspace once the catalog lists it, unless aborted first. */
export async function openKnownSession(sessions: Pick<ISessions, 'list' | 'refresh'>, id: SessionId, open: (id: SessionId) => void, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (sessions.list.getSnapshot().phase !== 'ready' || !sessions.list.getSnapshot().byId[id]) await sessions.refresh()
  if (signal.aborted) return false
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') throw new SessionNavigationError('not-ready')
  if (!list.byId[id]) throw new SessionNavigationError('not-listed')
  open(id)
  return true
}

/** The deterministic id of a Project's agent Session: clicking again opens the same one. */
export const projectSessionId = (projectId: string): SessionId => `project-${projectId}` as SessionId
/** A Project as its agent section opens its Session: the id the Session is named after, and the directory it works in. */
export interface ProjectSession { id: string; scratchDir: string }
/**
 * Open a Project's Session, creating it the first time: one the catalog already lists opens directly, and one an earlier
 * click created — so creating it again is refused as a conflict — is opened after refreshing the catalog. A creation
 * failure the catalog does not explain is reported as it happened. The caller words the open error.
 */
export async function openOrCreateSession(sessions: Pick<ISessions, 'create' | 'list' | 'refresh'>,
  target: { sessionId: SessionId; cwd: string }, open: (id: SessionId) => void, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (sessions.list.getSnapshot().byId[target.sessionId] === undefined) {
    try {
      await sessions.create({ sessionId: target.sessionId, cwd: target.cwd })
    } catch (creation) {
      if (signal.aborted) return false
      // The Session may have existed before this click: the refreshed catalog tells that case from one that failed outright.
      try { await sessions.refresh() } catch { throw creation }
      if (signal.aborted) return false
      if (sessions.list.getSnapshot().byId[target.sessionId] === undefined) throw creation
    }
  }
  return openKnownSession(sessions, target.sessionId, open, signal)
}
