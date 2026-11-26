/** Open a DSH Session in the workspace after ensuring the session catalog is loaded, and a Project's conversation without a picker. */
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

/** The deterministic id of a Project's conversation Session: opening the conversation again opens the same one. */
export const projectSessionId = (projectId: string): SessionId => `project-${projectId}` as SessionId
/** A Project as its conversation opens: the id its Session is named after, and the directory the conversation works in. */
export interface ProjectConversation { id: string; conversationDir: string }
/**
 * The client Workspace Controller as the panel reaches it through `ctx.get('workspaces')`: creating a Workspace for an
 * existing directory registers it and merges it into the local snapshot at once, so a Session filed under it shows up
 * without opening the Workspace picker.
 */
export interface WorkspaceController { create(input: { path: string }): Promise<{ workspaceId: string }> }
/** What opening a Project's conversation needs: the Session controller, the Workspace controller when provided, and the UI open call. */
export interface ConversationHost {
  sessions: Pick<ISessions, 'create' | 'list' | 'refresh'>
  workspaces?: Pick<WorkspaceController, 'create'> | undefined
  open: (id: SessionId) => void
}
/**
 * Open a Project's conversation Session in the DSH workspace UI without asking for a workspace: a Workspace is created for
 * the Project's conversation directory, the Session is created under it (or with that directory as its cwd when no Workspace
 * controller is at hand, or its creation failed), a Session that already exists opens after refreshing the catalog, and the
 * refreshed catalog is opened in the UI. A creation the catalog does not explain is reported as it happened.
 */
export async function openProjectConversation(host: ConversationHost, project: ProjectConversation,
  signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const sessionId = projectSessionId(project.id)
  // The Workspace files the conversation under the Project's directory at once; without one its cwd carries the directory.
  type WorkspaceId = NonNullable<Parameters<ISessions['create']>[0]>['workspaceId']
  let workspaceId: WorkspaceId
  if (host.workspaces) {
    try { workspaceId = (await host.workspaces.create({ path: project.conversationDir })).workspaceId as WorkspaceId }
    catch { workspaceId = undefined }
  }
  if (signal.aborted) return false
  if (host.sessions.list.getSnapshot().byId[sessionId] === undefined) {
    try {
      await host.sessions.create(workspaceId === undefined ? { sessionId, cwd: project.conversationDir }
        : { sessionId, workspaceId })
    } catch (creation) {
      if (signal.aborted) return false
      // The Session may have existed before this click: the refreshed catalog tells that case from one that failed outright.
      try { await host.sessions.refresh() } catch { throw creation }
      if (signal.aborted) return false
      if (host.sessions.list.getSnapshot().byId[sessionId] === undefined) throw creation
    }
  }
  // The catalog and the Workspace tree list the Session before the UI shows it, so opening never falls back to a picker.
  await host.sessions.refresh()
  return openKnownSession(host.sessions, sessionId, host.open, signal)
}
