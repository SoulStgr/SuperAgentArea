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

/** The deterministic id of a Project's conversation Session: opening the conversation again opens the same one, and starting
 * the conversation over (a later generation) names a new one. */
export const projectSessionId = (projectId: string, generation = 0): SessionId =>
  (generation > 0 ? `project-${projectId}-${generation}` : `project-${projectId}`) as SessionId
/**
 * A Project as its conversation opens: the id its Session is named after, the station's name for the conversation's
 * Workspace title, the directory the conversation works in, and the generation (the first unless a person started over).
 */
export interface ProjectConversation { id: string; name: string; conversationDir: string; conversationGeneration?: number }
/** The UI workspace call that archives a Session: the panel uses it when a Project or its conversation is deleted. */
export interface SessionArchiver { archiveSession(id: SessionId, options: { stopActivity: boolean }): Promise<unknown> }
/**
 * Archive a Project's conversation Session, best effort: the Project or its conversation is already deleted, so a Session
 * that cannot be archived (already gone, or the host is busy) must not turn the successful deletion into a failure.
 */
export async function archiveProjectSession(ui: Pick<SessionArchiver, 'archiveSession'>, sessionId: SessionId): Promise<void> {
  try { await ui.archiveSession(sessionId, { stopActivity: true }) } catch { /* The old conversation stays in DSH as it is. */ }
}
/**
 * The client Workspace the conversation merges into its snapshot: `sessionIds` and `title` are what let the DSH conversation
 * show its Workspace instead of a Workspace picker.
 */
export interface WorkspaceView { workspaceId: string; title?: string; sessionIds?: readonly string[] }
/**
 * The client Workspace Controller as the panel reaches it through `ctx.get('workspaces')`. `create` registers an existing
 * directory and merges its row at once; `rename` returns the row after the Session joins it, whose `sessionIds` the panel
 * needs to stop the conversation from asking for a Workspace again.
 */
export interface WorkspaceController {
  create(input: { path: string }): Promise<WorkspaceView>
  rename?(workspaceId: string, title: string): Promise<WorkspaceView>
}
/** The name a Project's conversation Workspace wears, so its conversations are recognizable in DSH. */
export const conversationWorkspaceTitle = (project: Pick<ProjectConversation, 'id' | 'name'>): string =>
  `SAA-${project.name.trim() || project.id}`
/** What opening a Project's conversation needs: the Session controller, the Workspace controller when provided, the UI open
 * call, and the host's conversation reset when a Session has to be migrated to its Workspace. */
export interface ConversationHost {
  sessions: Pick<ISessions, 'create' | 'list' | 'refresh'>
  workspaces?: WorkspaceController | undefined
  open: (id: SessionId) => void
  /** Starts the Project's conversation over and returns its new generation. */
  reset?: (projectId: string) => Promise<number>
}
/**
 * Open a Project's conversation Session in the DSH conversation without asking for a workspace. The Workspace for the
 * Project's directory is created first, the Session is created under it (or with the directory as cwd when no Workspace
 * controller is at hand, or its creation failed), and then the Workspace is renamed to `SAA-<name>`: the rename reply carries
 * the Workspace's `sessionIds`, which the client merges at once, so the DSH conversation shows its Workspace chip instead of
 * the "choose a workspace" placeholder. A Session an earlier version left outside its Workspace is started over under the
 * next generation (with `reset`), and the refreshed catalog is opened in the UI. A creation the catalog does not explain is
 * reported as it happened.
 */
export async function openProjectConversation(host: ConversationHost, project: ProjectConversation,
  signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  type WorkspaceId = NonNullable<Parameters<ISessions['create']>[0]>['workspaceId']
  let generation = project.conversationGeneration ?? 0
  let sessionId = projectSessionId(project.id, generation)
  let workspaceId: WorkspaceId
  if (host.workspaces) {
    try { workspaceId = (await host.workspaces.create({ path: project.conversationDir })).workspaceId as WorkspaceId }
    catch { workspaceId = undefined }
  }
  if (signal.aborted) return false
  // Create the Session unless the catalog already lists it; an existing one is adopted (or kept as it is).
  const create = async (id: SessionId): Promise<void> => {
    if (host.sessions.list.getSnapshot().byId[id] !== undefined) return
    try {
      await host.sessions.create(workspaceId === undefined ? { sessionId: id, cwd: project.conversationDir }
        : { sessionId: id, workspaceId })
    } catch (creation) {
      if (signal.aborted) return
      // The Session may have existed before this click: the refreshed catalog tells that case from one that failed outright.
      try { await host.sessions.refresh() } catch { throw creation }
      if (host.sessions.list.getSnapshot().byId[id] === undefined) throw creation
    }
  }
  await create(sessionId)
  await host.sessions.refresh()
  if (signal.aborted) return false
  // The rename follows the Session into its Workspace, so its reply carries the updated sessionIds as well as the title.
  let workspace: WorkspaceView | undefined
  if (host.workspaces && workspaceId !== undefined) {
    const title = conversationWorkspaceTitle(project)
    if (host.workspaces.rename) {
      try { workspace = await host.workspaces.rename(workspaceId, title) } catch { /* Refresh the row below. */ }
    }
    if (workspace === undefined) {
      try { workspace = await host.workspaces.create({ path: project.conversationDir }) } catch { workspace = undefined }
    }
  }
  // A Session created by an earlier version may not be filed under its Workspace; start the conversation over instead of
  // opening a Session the composer cannot attach to a Workspace.
  if (workspace !== undefined && workspaceId !== undefined && !(workspace.sessionIds ?? []).includes(sessionId) && host.reset) {
    try {
      generation = await host.reset(project.id)
      sessionId = projectSessionId(project.id, generation)
      await create(sessionId)
      await host.sessions.refresh()
      if (signal.aborted) return false
      if (host.workspaces?.rename) {
        try { await host.workspaces.rename(workspaceId, conversationWorkspaceTitle(project)) } catch { /* The title stays. */ }
      }
    } catch { /* Open what exists; the conversation reports what it cannot show. */ }
  }
  return openKnownSession(host.sessions, sessionId, host.open, signal)
}
