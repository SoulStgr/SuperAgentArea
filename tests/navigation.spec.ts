// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { archiveProjectSession, conversationWorkspaceTitle, openKnownSession, openProjectConversation, projectSessionId }
  from '../src/navigation.ts'
import { initialLocation, lastSettingsGroup, parseRoute, remember, setupPage } from '../src/client/route.ts'
const id = 'orchestrator-test' as SessionId
function fixture(ready = false) {
  const pending = Promise.withResolvers<void>()
  const state = { phase: ready ? 'ready' : 'pending', byId: ready ? { [id]: {} } : {} as Record<string, object> }
  const refresh = vi.fn(async () => { await pending.promise })
  // Navigation reads only catalog readiness and membership, not summary fields.
  const sessions = { list: { getSnapshot: () => state }, refresh } as unknown as Pick<ISessions, 'list' | 'refresh'>
  return { sessions, pending, state, refresh }
}
it('waits for initial catalog hydration before opening the linked master', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  expect(open).not.toHaveBeenCalled()
  state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
it('opens known Sessions without another network refresh', async () => {
  const { sessions, refresh } = fixture(true); const open = vi.fn()
  await expect(openKnownSession(sessions, id, open, new AbortController().signal)).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id); expect(refresh).not.toHaveBeenCalled()
})
it('reports unavailable targets without calling the throwing Session selector', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  state.phase = 'ready'; pending.resolve()
  await expect(navigation).rejects.toMatchObject({ code: 'not-listed' })
  expect(open).not.toHaveBeenCalled()
})
it('does not navigate after the panel unmounts or a newer request supersedes it', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn(); const controller = new AbortController()
  const navigation = openKnownSession(sessions, id, open, controller.signal)
  controller.abort(); state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(false); expect(open).not.toHaveBeenCalled()
})
type FixtureWorkspace = { workspaceId: string }
/**
 * A sessions service and Workspace Controller as the plugin entry passes them, with the host's Workspace row, its reset, and
 * the catalog: `rename` answers with the host's Sessions unless it is told to fail or to omit them, as a stale row does.
 */
function conversationFixture(options: {
  workspace?: 'none' | 'fail' | FixtureWorkspace
  rename?: 'ok' | 'fail' | 'stale'
  /** Sessions the host already holds before the click, which the catalog has not listed yet. */
  sessions?: string[]
  /** The generation the host's conversation reset answers. */
  generation?: number
} = {}) {
  const catalog: { phase: string; byId: Record<string, object> } = { phase: 'ready', byId: {} }
  const host = new Set(options.sessions ?? [])
  const sessions = {
    list: { getSnapshot: () => catalog },
    refresh: vi.fn(async () => { for (const sessionId of host) catalog.byId[sessionId] = {} }),
    create: vi.fn(async (request: { sessionId?: SessionId; cwd?: string; workspaceId?: string }) => {
      if (host.has(request.sessionId!)) throw new Error(`session create failed: session/conflict: ${request.sessionId}`)
      host.add(request.sessionId!); catalog.byId[request.sessionId!] = {}
      return request.sessionId
    }),
  } as unknown as Pick<ISessions, 'create' | 'list' | 'refresh'>
  const workspaceId = typeof options.workspace === 'object' ? options.workspace.workspaceId : 'ws-aps'
  const workspaces = options.workspace === 'none' ? undefined : {
    create: vi.fn(async () => {
      if (options.workspace === 'fail') throw new Error('the directory cannot be owned')
      return { workspaceId, title: 'aps', sessionIds: [...host] }
    }),
    rename: vi.fn(async (_workspaceId: string, title: string) => {
      if (options.rename === 'fail') throw new Error('the Workspace cannot be renamed')
      return { workspaceId, title, sessionIds: options.rename === 'stale' ? [] : [...host] }
    }),
  }
  const reset = vi.fn(async () => options.generation ?? 1)
  return { sessions, workspaces, reset, catalog, host }
}
const project = { id: 'prj_aps', name: 'aps', conversationDir: '/srv/aps' }
it('opens a Project conversation in a Workspace named SAA-<name>, whose reply lists the Session so no picker appears', async () => {
  const { sessions, workspaces, reset, catalog } = conversationFixture({ workspace: { workspaceId: 'ws-aps' } })
  const open = vi.fn()
  await expect(openProjectConversation({ sessions, workspaces, open, reset }, project, new AbortController().signal)).resolves.toBe(true)
  expect(conversationWorkspaceTitle(project)).toBe('SAA-aps')
  expect(workspaces!.create).toHaveBeenCalledExactlyOnceWith({ path: '/srv/aps' })
  expect(workspaces!.rename).toHaveBeenCalledExactlyOnceWith('ws-aps', 'SAA-aps')
  expect(sessions.create).toHaveBeenCalledExactlyOnceWith({ sessionId: 'project-prj_aps', workspaceId: 'ws-aps' })
  // The catalog is refreshed before the UI opens it, so its tree lists the Session.
  expect(sessions.refresh).toHaveBeenCalled()
  expect(catalog.byId['project-prj_aps']).toEqual({})
  expect(reset).not.toHaveBeenCalled()
  expect(open).toHaveBeenCalledExactlyOnceWith('project-prj_aps')
  // Opening it again lists it and creates nothing.
  await expect(openProjectConversation({ sessions, workspaces, open, reset }, project, new AbortController().signal)).resolves.toBe(true)
  expect(sessions.create).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledTimes(2)
})
it('falls back to creating the Workspace again when renaming it fails, and still opens the Session', async () => {
  const { sessions, workspaces, catalog } = conversationFixture({ workspace: { workspaceId: 'ws-aps' }, rename: 'fail' })
  const open = vi.fn()
  await expect(openProjectConversation({ sessions, workspaces, open }, project, new AbortController().signal)).resolves.toBe(true)
  expect(workspaces!.rename).toHaveBeenCalledOnce()
  // The create fallback answers the Workspace row with the Session the host filed there.
  expect(workspaces!.create).toHaveBeenCalledTimes(2)
  expect(catalog.byId['project-prj_aps']).toEqual({})
  expect(open).toHaveBeenCalledExactlyOnceWith('project-prj_aps')
})
it('starts a Session the Workspace reply does not list over with the next generation', async () => {
  const { sessions, workspaces, reset } = conversationFixture({ workspace: { workspaceId: 'ws-aps' }, rename: 'stale', generation: 2 })
  const open = vi.fn()
  await expect(openProjectConversation({ sessions, workspaces, open, reset }, project, new AbortController().signal)).resolves.toBe(true)
  expect(reset).toHaveBeenCalledExactlyOnceWith('prj_aps')
  expect(sessions.create).toHaveBeenNthCalledWith(1, { sessionId: 'project-prj_aps', workspaceId: 'ws-aps' })
  expect(sessions.create).toHaveBeenNthCalledWith(2, { sessionId: 'project-prj_aps-2', workspaceId: 'ws-aps' })
  // The new generation is renamed again before it opens, so its Workspace carries the Session.
  expect(workspaces!.rename).toHaveBeenCalledTimes(2)
  expect(workspaces!.rename).toHaveBeenLastCalledWith('ws-aps', 'SAA-aps')
  expect(open).toHaveBeenCalledExactlyOnceWith('project-prj_aps-2')
})
it('creates the Project Session with its directory when no Workspace Controller is at hand or it refuses', async () => {
  for (const workspace of ['none', 'fail'] as const) {
    const { sessions } = conversationFixture({ workspace })
    const open = vi.fn()
    await expect(openProjectConversation({ sessions, open }, project, new AbortController().signal)).resolves.toBe(true)
    expect(sessions.create).toHaveBeenCalledExactlyOnceWith({ sessionId: 'project-prj_aps', cwd: '/srv/aps' })
    expect(open).toHaveBeenCalledExactlyOnceWith('project-prj_aps')
  }
})
it('adopts a Session the host already holds whose catalog row had not arrived, and reports an unexplained failure', async () => {
  const { sessions, workspaces, reset, catalog } = conversationFixture({ workspace: { workspaceId: 'ws-aps' },
    sessions: ['project-prj_aps'] })
  const open = vi.fn()
  await expect(openProjectConversation({ sessions, workspaces, open, reset }, project, new AbortController().signal)).resolves.toBe(true)
  // Creating it is refused as a conflict; the refreshed catalog explains that it already existed.
  expect(sessions.create).toHaveBeenCalledOnce()
  expect(catalog.byId['project-prj_aps']).toEqual({})
  expect(reset).not.toHaveBeenCalled()
  expect(open).toHaveBeenCalledExactlyOnceWith('project-prj_aps')
  // A creation failure the refreshed catalog does not explain is the failure the click reports.
  const failure = new Error('cwd unusable')
  const refused = conversationFixture({ workspace: 'none' })
  vi.spyOn(refused.sessions, 'create').mockRejectedValueOnce(failure)
  await expect(openProjectConversation({ sessions: refused.sessions, open }, { id: 'prj_new', name: 'new', conversationDir: '/srv/new' },
    new AbortController().signal)).rejects.toBe(failure)
  expect(refused.sessions.refresh).toHaveBeenCalledOnce()
})
it('does nothing for a Project conversation click that was superseded before it started', async () => {
  const { sessions, workspaces } = conversationFixture({ workspace: { workspaceId: 'ws-aps' } })
  const controller = new AbortController(); controller.abort()
  const open = vi.fn()
  await expect(openProjectConversation({ sessions, workspaces, open }, project, controller.signal)).resolves.toBe(false)
  expect(workspaces!.create).not.toHaveBeenCalled()
  expect(sessions.create).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
it('names a Project conversation by its generation: the first one and one started over', () => {
  expect(projectSessionId('prj_aps')).toBe('project-prj_aps')
  expect(projectSessionId('prj_aps', 0)).toBe('project-prj_aps')
  expect(projectSessionId('prj_aps', 2)).toBe('project-prj_aps-2')
})
it('opens the conversation of the generation the Project is on', async () => {
  const { sessions, catalog } = conversationFixture({ workspace: 'none' })
  const open = vi.fn()
  await expect(openProjectConversation({ sessions, open }, { ...project, conversationGeneration: 2 },
    new AbortController().signal)).resolves.toBe(true)
  expect(sessions.create).toHaveBeenCalledExactlyOnceWith({ sessionId: 'project-prj_aps-2', cwd: '/srv/aps' })
  expect(catalog.byId['project-prj_aps-2']).toEqual({})
  expect(open).toHaveBeenCalledExactlyOnceWith('project-prj_aps-2')
})
it('archives an old conversation best effort, and a workspace UI failure does not fail the deletion', async () => {
  const archived: { id: string; stopActivity?: boolean }[] = []
  await archiveProjectSession({
    archiveSession: async (id, options) => { archived.push({ id: String(id), ...options }) },
  }, projectSessionId('prj_aps', 1))
  expect(archived).toEqual([{ id: 'project-prj_aps-1', stopActivity: true }])
  // A Session the workspace UI cannot archive (already gone, or the host is busy) leaves the successful deletion alone.
  await expect(archiveProjectSession({ archiveSession: async () => { throw new Error('session is gone') } },
    projectSessionId('prj_aps'))).resolves.toBeUndefined()
})
it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'decisions', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'decisions', query: { filter: 'stop' } },
    stack: [{ page: 'overview' }] })
  // A page this version does not have falls back to the overview.
  sessionStorage.setItem('dsh-superagentarea/route', JSON.stringify({ route: { page: 'gone' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagentarea/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'gone' }, { page: 'trigger' }] }))
  expect(initialLocation().stack).toEqual([{ page: 'trigger' }])
  // A route saved by an older version still opens a page this one has.
  sessionStorage.setItem('dsh-superagentarea/route', JSON.stringify({ route: { page: 'policy', query: { segment: 'decisions', filter: 'stop' } }, stack: [] }))
  expect(initialLocation().route).toEqual({ page: 'decisions', query: { filter: 'stop' } })
  sessionStorage.setItem('dsh-superagentarea/route', '{')
  expect(initialLocation().route).toEqual({ page: 'overview' })
})
it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'trigger', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'trigger' })
  expect(parseRoute({ page: 'trigger', id: 'github:1', query: { trigger: 'e1', filter: 'recent' } }))
    .toEqual({ page: 'trigger', id: 'github:1', query: { trigger: 'e1' } })
  // Prompts and Policy are no longer pages: a Source owns both, so their old routes open the Sources page.
  expect(parseRoute({ page: 'prompts' })).toEqual({ page: 'source' })
  expect(parseRoute({ page: 'policy', query: { segment: 'rules', version: 'abcdef12' } })).toEqual({ page: 'source' })
  // The old Eval page's Decisions keep their page, which has no tab of its own.
  expect(parseRoute({ page: 'eval', query: { filter: 'stop', window: '7d' } }))
    .toEqual({ page: 'decisions', query: { filter: 'stop' } })
  expect(parseRoute({ page: 'policy', query: { segment: 'decisions', filter: 'stop', window: '24h' } }))
    .toEqual({ page: 'decisions', query: { filter: 'stop', window: '24h' } })
  // Eval settings moved to the Routing and Eval group of the Settings page.
  expect(parseRoute({ page: 'policy', query: { segment: 'eval', version: 'abcdef12' } }))
    .toEqual({ page: 'settings', query: { group: 'routing' } })
  expect(parseRoute({ page: 'execution', id: 5, query: { filter: 'idle' } })).toEqual({ page: 'execution', query: { filter: 'idle' } })
  expect(parseRoute({ page: 'workstations', query: { segment: 'tickets' } })).toEqual({ page: 'workstations' })
  expect(parseRoute({ page: 'workstations', id: 'prj_aps', query: { segment: 'tickets' } }))
    .toEqual({ page: 'workstations', id: 'prj_aps', query: { segment: 'tickets' } })
  // A section the panel does not know is left out, opening the first one.
  expect(parseRoute({ page: 'workstations', id: 'prj_aps', query: { segment: 'gone' } })).toEqual({ page: 'workstations', id: 'prj_aps' })
  // A Source page keeps its section, and drops one it does not know.
  expect(parseRoute({ page: 'source', id: 'feishu', query: { segment: 'config' } }))
    .toEqual({ page: 'source', id: 'feishu', query: { segment: 'config' } })
  expect(parseRoute({ page: 'source', id: 'feishu', query: { segment: 'gone' } })).toEqual({ page: 'source', id: 'feishu' })
  // A Source's Policy and prompts have a page of their own: their old section opens it at the Policy part.
  expect(parseRoute({ page: 'source', id: 'feishu', query: { segment: 'governance' } }))
    .toEqual({ page: 'governance', id: 'feishu' })
  expect(parseRoute({ page: 'governance', id: 'feishu' })).toEqual({ page: 'governance', id: 'feishu' })
  expect(parseRoute({ page: 'governance', id: 'feishu', query: { part: 'prompts' } }))
    .toEqual({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  // A part the panel does not know is left out, opening the Policy; a page without its Source opens the Sources.
  expect(parseRoute({ page: 'governance', id: 'feishu', query: { part: 'gone' } })).toEqual({ page: 'governance', id: 'feishu' })
  expect(parseRoute({ page: 'governance' })).toEqual({ page: 'source' })
  // The Settings page keeps its four groups, the Source types first; an older group opens the page its work moved to.
  expect(parseRoute({ page: 'settings', query: { group: 'sources' } })).toEqual({ page: 'settings', query: { group: 'sources' } })
  expect(parseRoute({ page: 'settings', query: { group: 'source', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'sources' } })
  expect(parseRoute({ page: 'settings', query: { group: 'prompts' } })).toEqual({ page: 'settings', query: { group: 'sources' } })
  expect(parseRoute({ page: 'settings', query: { group: 'eval' } })).toEqual({ page: 'settings', query: { group: 'routing' } })
  expect(parseRoute({ page: 'settings', query: { group: 'gone' } })).toEqual({ page: 'settings', query: { group: 'sources' } })
  expect(parseRoute({ page: 'settings', query: { group: 'deployment' } })).toEqual({ page: 'settings', query: { group: 'deployment' } })
  // Settings opens the Source types when no group was left open.
  expect(lastSettingsGroup({ route: { page: 'overview' }, stack: [] })).toBe('sources')
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('opens the settings that fix each setup problem: the Deployment group, or the settings of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place)).toEqual({ page: 'source', id: place,
    query: { segment: 'config' } })
})
