// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, openOrCreateSession, projectSessionId } from '../src/navigation.ts'
import { initialLocation, parseRoute, remember, setupPage } from '../src/client/route.ts'
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
/** A sessions service whose create fills the host and catalog, refusing an id it already holds, as the host resumes one. */
function projectFixture() {
  const catalog: { phase: string; byId: Record<string, object> } = { phase: 'ready', byId: {} }
  const host = new Set<string>()
  const sessions = {
    list: { getSnapshot: () => catalog },
    refresh: vi.fn(async () => { for (const sessionId of host) catalog.byId[sessionId] = {} }),
    create: vi.fn(async (options: { sessionId?: SessionId; cwd?: string }) => {
      if (host.has(options.sessionId!)) throw new Error(`session create failed: session/conflict: ${options.sessionId}`)
      host.add(options.sessionId!); catalog.byId[options.sessionId!] = {}
      return options.sessionId
    }),
  } as unknown as Pick<ISessions, 'create' | 'list' | 'refresh'>
  return { sessions, catalog, host }
}
it('creates a Project Session on its first click and opens it, and opens a listed one without creating it again', async () => {
  const { sessions } = projectFixture()
  const open = vi.fn()
  const target = { sessionId: projectSessionId('prj_aps'), cwd: '/tmp/aps.work' }
  await expect(openOrCreateSession(sessions, target, open, new AbortController().signal)).resolves.toBe(true)
  expect(sessions.create).toHaveBeenCalledExactlyOnceWith({ sessionId: target.sessionId, cwd: '/tmp/aps.work' })
  expect(open).toHaveBeenCalledExactlyOnceWith(target.sessionId)
  await expect(openOrCreateSession(sessions, target, open, new AbortController().signal)).resolves.toBe(true)
  expect(sessions.create).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledTimes(2)
  expect(sessions.refresh).not.toHaveBeenCalled()
})
it('opens a Project Session whose catalog row had not arrived when creating it was refused, and reports an unexplained failure', async () => {
  const { sessions, catalog, host } = projectFixture()
  const open = vi.fn()
  const target = { sessionId: projectSessionId('prj_aps'), cwd: '/tmp/aps.work' }
  host.add(target.sessionId)
  await expect(openOrCreateSession(sessions, target, open, new AbortController().signal)).resolves.toBe(true)
  expect(sessions.create).toHaveBeenCalledOnce()
  expect(sessions.refresh).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledExactlyOnceWith(target.sessionId)
  // The catalog now lists it, so a further click opens it directly.
  expect(catalog.byId[target.sessionId]).toEqual({})
  await openOrCreateSession(sessions, target, open, new AbortController().signal)
  expect(sessions.create).toHaveBeenCalledOnce()
  // A creation failure the refreshed catalog does not explain is the failure the click reports.
  const failure = new Error('cwd unusable')
  const refused = projectFixture()
  vi.spyOn(refused.sessions, 'create').mockRejectedValueOnce(failure)
  await expect(openOrCreateSession(refused.sessions, { sessionId: projectSessionId('prj_new'), cwd: '/tmp/new.work' }, open,
    new AbortController().signal)).rejects.toBe(failure)
  expect(refused.sessions.refresh).toHaveBeenCalledOnce()
})
it('does nothing for a Project Session click that was superseded before it started', async () => {
  const { sessions } = projectFixture()
  const controller = new AbortController(); controller.abort()
  const open = vi.fn()
  await expect(openOrCreateSession(sessions, { sessionId: projectSessionId('prj_aps'), cwd: '/tmp/aps.work' }, open,
    controller.signal)).resolves.toBe(false)
  expect(sessions.create).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'decisions', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'decisions', query: { filter: 'stop' } },
    stack: [{ page: 'overview' }] })
  // A page this version does not have falls back to the overview.
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'gone' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'gone' }, { page: 'trigger' }] }))
  expect(initialLocation().stack).toEqual([{ page: 'trigger' }])
  // A route saved by an older version still opens a page this one has.
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'policy', query: { segment: 'decisions', filter: 'stop' } }, stack: [] }))
  expect(initialLocation().route).toEqual({ page: 'decisions', query: { filter: 'stop' } })
  sessionStorage.setItem('dsh-superagent/route', '{')
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
  expect(parseRoute({ page: 'source', id: 'feishu', query: { segment: 'governance' } }))
    .toEqual({ page: 'source', id: 'feishu', query: { segment: 'governance' } })
  expect(parseRoute({ page: 'source', id: 'feishu', query: { segment: 'gone' } })).toEqual({ page: 'source', id: 'feishu' })
  // The Settings page keeps its three groups; a removed one opens the page its work moved to.
  expect(parseRoute({ page: 'settings', query: { group: 'source', source: 'feishu' } })).toEqual({ page: 'source' })
  expect(parseRoute({ page: 'settings', query: { group: 'eval' } })).toEqual({ page: 'settings', query: { group: 'routing' } })
  expect(parseRoute({ page: 'settings', query: { group: 'gone' } })).toEqual({ page: 'settings', query: { group: 'execution' } })
  expect(parseRoute({ page: 'settings', query: { group: 'deployment' } })).toEqual({ page: 'settings', query: { group: 'deployment' } })
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('opens the settings that fix each setup problem: the Deployment group, or the settings of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place)).toEqual({ page: 'source', id: place,
    query: { segment: 'config' } })
})
