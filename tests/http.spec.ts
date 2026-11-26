import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { UserError, type ArtifactRecord, type ProjectRecord, type Ticket, type Trigger } from '../src/core/index.ts'
import { clearWeixinLogins, weixinToken } from '../src/sources/im/weixin-login.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
interface Answer { status: number; headers: Record<string, unknown>; bytes: Buffer }
/**
 * Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers.
 * `raw` returns the response's headers and bytes, for the download route that answers with a file rather than JSON.
 */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  const send = async (method: string, path: string, body?: unknown, headers: Headers = {}): Promise<Answer> => {
    let status = 0, head: Record<string, unknown> = {}
    const chunks: Buffer[] = []
    const sent = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const requestHeaders = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers })
      .filter(([, value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: requestHeaders,
      async *[Symbol.asyncIterator]() { yield* sent } }
    await handler(req, { writeHead: (code: number, values: Record<string, unknown> = {}) => { status = code; head = values },
      end: (data?: string | Buffer) => { if (data !== undefined) chunks.push(Buffer.from(data)) } })
    return { status, headers: head, bytes: Buffer.concat(chunks) }
  }
  const call = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    const { status, bytes } = await send(method, path, body, headers)
    return { status, body: JSON.parse(bytes.toString()) as Record<string, unknown> }
  }
  return Object.assign(call, { raw: send })
}

it('adds and patches Source instances through their own routes', async () => {
  const added: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}), blockRevision: () => 4,
      projects: { get: (id: string) => id === 'prj_aps' ? { id } : undefined } },
    sources: {
      instances: () => [{ id: 'folder:ops', kind: 'folder', enabled: true, config: {}, installed: true }],
      kind: (id: string) => id === 'folder' || id === 'folder:ops'
        ? { kind: 'folder', schema: z.object({ inbox: z.string().default('') }) } : undefined,
      catalog: () => [{ kind: 'folder', title: { zh: '本地文件夹', en: 'Local folder' }, description: { zh: '', en: '' },
        fields: [], defaults: { inbox: '' } }],
      instanceFor: (id: string) => id === 'folder' ? { id: 'folder:ops' } : undefined,
    },
    settings: {
      add: async (request: unknown) => { added.push(request); return { revision: 1, restarting: false } },
      save: async () => ({ saved: true, revision: 5, restarting: false, policy_changed: false, context_delivery: 'injected' }),
    },
  })
  expect(await call('GET', 'source-kinds')).toMatchObject({ status: 200, body: [{ kind: 'folder', defaults: { inbox: '' } }] })
  // A key names the instance beside others of its kind, normalized to the instance id's own alphabet.
  expect(await call('POST', 'sources', { kind: 'folder', key: 'Dev Ops', config: { inbox: '/x' } }))
    .toEqual({ status: 200, body: { id: 'folder:dev-ops', revision: 1, restarting: false } })
  expect(added).toEqual([{ id: 'folder:dev-ops', kind: 'folder', config: { inbox: '/x' } }])
  expect(await call('POST', 'sources', { kind: 'slack', config: {} }))
    .toMatchObject({ status: 400, body: { code: 'sourceNotInstalled' } })
  expect(await call('POST', 'sources', { kind: 'folder', key: '!!!', config: {} }))
    .toMatchObject({ status: 400, body: { code: 'sourceKeyInvalid' } })
  expect(await call('PATCH', 'sources/folder:gone', { enabled: false })).toMatchObject({ status: 404, body: { code: 'unknownSource' } })
  expect(await call('PATCH', 'sources/folder:ops', { enabled: false, label: 'Ops' }))
    .toEqual({ status: 200, body: { revision: 5, restarting: false } })
  expect(await call('PATCH', 'sources/folder:ops', { defaultProjectId: 'prj_gone' }))
    .toMatchObject({ status: 404, body: { code: 'projectUnknown' } })
})

it('deletes a Source instance and answers its refusals with their own status', async () => {
  const removed: string[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}) },
    sources: { instances: () => [{ id: 'folder:ops' }] },
    settings: { remove: async (id: string) => {
      removed.push(id)
      if (id === 'folder:gone') throw new UserError('unknownSource', { source: id })
      if (id === 'folder:used') throw new UserError('sourceInUse', { source: id, count: '1' })
      return { deleted: true }
    } },
  })
  expect(await call('DELETE', 'sources/folder:gone')).toMatchObject({ status: 404, body: { code: 'unknownSource' } })
  // A Source with open work is a conflict; the panel words the code from the body.
  expect(await call('DELETE', 'sources/folder:used')).toMatchObject({ status: 409, body: { code: 'sourceInUse',
    values: { source: 'folder:used', count: '1' } } })
  expect(await call('DELETE', 'sources/folder:ops')).toEqual({ status: 200, body: { deleted: true } })
  expect(removed).toEqual(['folder:gone', 'folder:used', 'folder:ops'])
})
it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('serves the workstation cards, and routes creating and changing one to the Project service', async () => {
  const project: ProjectRecord = { id: 'prj_aps', key: 'aps', status: 'active', createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', value: { name: 'aps', kind: 'station', location: { type: 'managed' },
      outputDir: '/tmp/aps', scratchDir: '/tmp/aps.work', rulesDir: '/tmp/aps.work/rules', sourceIds: [], aliases: [] } }
  const created: unknown[] = [], updated: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}), blockRevision: () => 0, tickets: { list: () => [] },
      artifacts: { list: () => [] }, projects: { get: (id: string) => id === project.id ? project : undefined,
        list: () => [project] } },
    sources: { instances: () => [] },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    projects: {
      createStation: (request: unknown) => {
        created.push(request)
        if ((request as { name: string }).name === 'taken') throw new UserError('projectExists', { project: 'taken' })
        return project
      },
      update: (id: string, changes: unknown) => {
        updated.push({ id, changes })
        if ((changes as { archived?: boolean }).archived) throw new UserError('projectFixed')
        return project
      },
    },
  })
  expect(await call('GET', 'projects')).toMatchObject({ status: 200, body: [{ id: 'prj_aps', openTickets: 0 }] })
  // An unknown status falls back to the active Projects, whose names resolve to their Sources.
  expect(await call('GET', 'projects?status=nonsense')).toMatchObject({ status: 200, body: [{ id: 'prj_aps', status: 'active' }] })
  expect(await call('POST', 'projects', { name: 'aps', location: { type: 'managed' } }))
    .toMatchObject({ status: 200, body: { project: { id: 'prj_aps' } } })
  expect(created).toEqual([{ name: 'aps', location: { type: 'managed' } }])
  expect(await call('POST', 'projects', { name: 'taken', location: { type: 'managed' } }))
    .toMatchObject({ status: 400, body: { code: 'projectExists', values: { project: 'taken' } } })
  expect(await call('POST', 'projects', { location: { type: 'managed' } })).toMatchObject({ status: 400 })
  expect(await call('PATCH', 'projects/prj_aps', { name: 'APS', aliases: ['a'], sourceIds: ['github'] }))
    .toMatchObject({ status: 200, body: { project: { id: 'prj_aps' } } })
  expect(updated).toEqual([{ id: 'prj_aps', changes: { name: 'APS', aliases: ['a'], sourceIds: ['github'] } }])
  expect(await call('PATCH', 'projects/prj_aps', { archived: true }))
    .toMatchObject({ status: 400, body: { code: 'projectFixed' } })
  // An unknown Project is a missing record on every route that names one.
  for (const [method, path] of [['GET', 'projects/prj_gone'], ['GET', 'projects/prj_gone/tickets'],
    ['GET', 'projects/prj_gone/threads'], ['GET', 'projects/prj_gone/decisions'], ['GET', 'projects/prj_gone/history'],
    ['PATCH', 'projects/prj_gone']] as const) {
    expect(await call(method, path, method === 'PATCH' ? { archived: true } : undefined), path)
      .toMatchObject({ status: 404, body: { code: 'projectUnknown' } })
  }
  expect(updated).toHaveLength(2)
})

it('serves the artifact index and one artifact\'s chain, and downloads a file only from the artifact\'s own landing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-http-'))
  const root = join(directory, 'area', 'aps'), outbox = join(directory, 'outbox', 't1', 'artifacts')
  mkdirSync(root, { recursive: true })
  mkdirSync(outbox, { recursive: true })
  writeFileSync(join(root, 'report.md'), 'done')
  writeFileSync(join(root, '报告.md'), 'x')
  writeFileSync(join(outbox, 'old.csv'), 'a,b')
  writeFileSync(join(directory, 'secret.txt'), 'secret')
  const row = (id: string, name: string, at: string, value: ArtifactRecord['value']): ArtifactRecord =>
    ({ id, ticket: 't1', project: 'prj_aps', source: 'feishu', name, value, at })
  const rows: ArtifactRecord[] = [
    row('a1', 'report.md', '2026-09-23T06:00:00Z', { hash: 'h1', size: 4, at: '2026-09-23T06:00:00Z', targetRoot: root, messageId: 'reply-1' }),
    row('a-gone', 'gone.txt', '2026-09-23T05:00:00Z', { hash: 'h2', size: 1, at: '2026-09-23T05:00:00Z', targetRoot: join(directory, 'nowhere') }),
    row('a-escape', '../secret.txt', '2026-09-23T04:00:00Z', { hash: 'h3', size: 6, at: '2026-09-23T04:00:00Z', targetRoot: root }),
    row('a-unicode', '报告.md', '2026-09-23T03:00:00Z', { hash: 'h4', size: 1, at: '2026-09-23T03:00:00Z', targetRoot: root }),
    // An artifact of a Ticket saved before Projects: its landing is empty, and the outbox copy is what is left.
    { id: 'a-old', ticket: 't-old', source: 'github', name: 'old.csv',
      value: { hash: 'h-old', size: 3, at: '2026-09-22T00:00:00Z', targetRoot: '', deliveredTo: outbox }, at: '2026-09-22T00:00:00Z' },
  ]
  const ticket = { id: 't1', title: '修复回归', projectId: 'prj_aps', sourceId: 'feishu', channels: [], inputs: [], undelivered: [],
    createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z', reporter: { source: 'feishu', id: 'ou_alice' },
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] },
    assignments: [{ id: 'as1', state: 'running', createdAt: '2026-09-22T00:00:00Z', startedAt: '2026-09-22T00:01:00Z',
      report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }] } as unknown as Ticket
  const trigger = { id: 'e1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: { source: 'feishu',
    id: 'ou_alice' }, human: true, at: '2026-09-22T00:00:00Z', text: 'please', meta: {} } as unknown as Trigger
  const projects = [
    { id: 'prj_aps', key: 'aps', value: { name: 'aps' } },
    { id: 'prj_workspace', key: 'workspace', value: { name: 'workspace' } },
  ] as unknown as ProjectRecord[]
  try {
    const call = serve({
      store: { settings: () => SettingsSchema.parse({}), artifacts: { get: (id: string) => rows.find(item => item.id === id),
        list: () => rows }, tickets: { get: (id: string) => id === 't1' ? ticket : undefined },
        triggers: { get: (id: string) => id === 'e1' ? trigger : undefined },
        projects: { get: (id: string) => projects.find(project => project.id === id) } },
      sources: { instances: () => [], kind: () => undefined },
      links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    })
    // The index is newest first, names each row's Project and Source, and says whether the file is still readable.
    const index = await call('GET', 'artifacts')
    expect(index.status).toBe(200)
    expect(index.body).toMatchObject({ total: 5, next_offset: null, items: [
      { id: 'a1', name: 'report.md', ticket: 't1', ticketTitle: '修复回归', project: 'prj_aps', projectName: 'aps', source: 'feishu',
        size: 4, hash: 'h1', deliverable: true, targetRoot: root },
      { id: 'a-gone', deliverable: false },
      { id: 'a-escape', deliverable: false },
      { id: 'a-unicode', deliverable: true },
      { id: 'a-old', project: 'prj_workspace', projectName: 'workspace', deliverable: true },
    ] })
    expect((index.body as { items: { sourceLabel: unknown }[] }).items[0]!.sourceLabel).toEqual({ zh: 'feishu', en: 'feishu' })
    // Filters: a name or hash search, and the Project (also by its key), Source and Ticket.
    expect(await call('GET', 'artifacts?q=REPORT')).toMatchObject({ status: 200, body: { total: 1, items: [{ id: 'a1' }] } })
    expect(await call('GET', 'artifacts?q=h-old')).toMatchObject({ status: 200, body: { total: 1, items: [{ id: 'a-old' }] } })
    expect(await call('GET', 'artifacts?project=prj_workspace')).toMatchObject({ body: { total: 1, items: [{ id: 'a-old' }] } })
    expect(await call('GET', 'artifacts?project=workspace')).toMatchObject({ body: { total: 1, items: [{ id: 'a-old' }] } })
    expect(await call('GET', 'artifacts?source=feishu&limit=2')).toMatchObject({ body: { total: 4, items: [{ id: 'a1' }, { id: 'a-gone' }],
      next_offset: 2 } })
    expect(await call('GET', 'artifacts?ticket=t1&offset=3')).toMatchObject({ body: { total: 4, items: [{ id: 'a-unicode' }],
      next_offset: null } })
    // One artifact's page: its delivery and the chain back to its Ticket, its Assignment and the worker Session.
    expect(await call('GET', 'artifacts/a1')).toMatchObject({ status: 200, body: {
      artifact: { id: 'a1', name: 'report.md', value: { hash: 'h1', targetRoot: root } },
      project: { id: 'prj_aps', name: 'aps', key: 'aps' }, source: { id: 'feishu' },
      ticket: { id: 't1', title: '修复回归', stage: 'working', state: 'open' },
      assignment: { id: 'as1', state: 'running', report: { state: 'progress', summary: 'working' } },
      workerSessionId: 'worker-t1', delivery: { path: join(root, 'report.md'), exists: true, messageId: 'reply-1' },
      links: { ticket: 't1', thread: 'feishu:oc_1:om_root' } } })
    // A named Assignment the Ticket does not have leaves the chain without one, and an unknown artifact is a 404.
    expect((await call('GET', 'artifacts/a1?assignment=as-gone')).body).not.toHaveProperty('assignment')
    expect(await call('GET', 'artifacts/unknown')).toMatchObject({ status: 404, body: { error: 'Artifact not found' } })
    // The file comes back as a download with its own length, name and media type.
    const download = await call.raw('GET', 'artifacts/a1/file')
    expect(download.status).toBe(200)
    expect(download.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'content-length': '4',
      'x-content-type-options': 'nosniff' })
    expect(download.headers['content-disposition']).toBe('attachment; filename="report.md"; filename*=UTF-8\'\'report.md')
    expect(download.bytes.toString()).toBe('done')
    // A non-ASCII name keeps an ASCII fallback and resolves exactly in the encoded form.
    const unicode = await call.raw('GET', 'artifacts/a-unicode/file')
    expect(unicode.headers['content-disposition']).toBe('attachment; filename="__.md"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.md')
    expect(unicode.bytes.toString()).toBe('x')
    // An old artifact downloads its outbox copy; a missing file, a name that would leave the landing root, and an unknown id
    // are all 404.
    expect((await call.raw('GET', 'artifacts/a-old/file')).bytes.toString()).toBe('a,b')
    for (const id of ['a-gone', 'a-escape', 'unknown']) {
      const refused = await call.raw('GET', `artifacts/${id}/file`)
      expect(refused.status, id).toBe(404)
      expect(JSON.parse(refused.bytes.toString())).toEqual({ error: 'Artifact not found' })
    }
    // The download keeps the panel's same-origin check.
    expect((await call.raw('GET', 'artifacts/a1/file', undefined, { 'x-orchestrator-request': undefined })))
      .toMatchObject({ status: 403 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('runs a WeChat QR sign-in through its routes and keeps the token out of every response', async () => {
  clearWeixinLogins()
  const saved = new Map<string, unknown>()
  // iLink over a fake fetch: one QR token, then the statuses the test scripted.
  const statuses = ['wait', 'confirmed']
  const fetchImpl = (async (input: URL | string): Promise<Response> => {
    if (String(input).includes('get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/qr.png' }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const status = statuses.shift() ?? 'wait'
    const body = status === 'confirmed'
      ? { status, bot_token: 'bot-token-1', ilink_bot_id: 'bot-1', ilink_user_id: 'user-1' } : { status }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  vi.stubGlobal('fetch', fetchImpl)
  try {
    const call = serve({
      store: { get: (name: string) => saved.get(name), set: (name: string, value: unknown) => { saved.set(name, value) } },
      sources: {
        instances: () => [{ id: 'wechat:ops', kind: 'wechat', enabled: true, config: { botType: '3' } }],
        kind: (id: string) => id === 'wechat:ops' ? { kind: 'wechat' } : undefined,
      },
    })
    // Not signed in at first; starting returns the QR image and an attempt id.
    expect(await call('GET', 'sources/wechat:ops/wechat/status')).toEqual({ status: 200, body: { loggedIn: false } })
    const started = await call('POST', 'sources/wechat:ops/wechat/login')
    expect(started).toMatchObject({ status: 200, body: { qrImage: 'https://weixin.qq.com/qr.png' } })
    const loginId = (started.body as { loginId: string }).loginId
    expect(typeof loginId).toBe('string')
    // The background poll confirms; the token goes to the instance's KV record, and the responses carry the account id only.
    await vi.waitFor(async () => {
      const poll = await call('GET', `sources/wechat:ops/wechat/login/${loginId}`)
      expect(poll).toMatchObject({ status: 200, body: { status: 'confirmed', ilinkBotId: 'bot-1' } })
    }, { timeout: 5_000 })
    expect(saved.get(weixinToken('wechat:ops'))).toMatchObject({ token: 'bot-token-1', ilinkBotId: 'bot-1',
      at: expect.any(String) })
    const account = await call('GET', 'sources/wechat:ops/wechat/status')
    expect(account).toMatchObject({ status: 200, body: { loggedIn: true, ilinkBotId: 'bot-1', at: expect.any(String) } })
    for (const answer of [started, account]) expect(JSON.stringify(answer.body)).not.toContain('bot-token-1')
    // A new attempt may expire; the route reports it so the panel offers a refresh.
    statuses.push('expired')
    const second = await call('POST', 'sources/wechat:ops/wechat/login')
    const secondId = (second.body as { loginId: string }).loginId
    await vi.waitFor(async () => {
      const poll = await call('GET', `sources/wechat:ops/wechat/login/${secondId}`)
      expect(poll).toMatchObject({ status: 200, body: { status: 'expired' } })
    })
    // The sign-in routes only address a saved WeChat instance, and keep the same-origin check.
    expect(await call('POST', 'sources/folder:ops/wechat/login')).toMatchObject({ status: 404 })
    expect((await call.raw('POST', 'sources/wechat:ops/wechat/login', undefined, { 'x-orchestrator-request': undefined })).status)
      .toBe(403)
    const other = serve({
      store: { get: () => undefined, set: () => {} },
      sources: { instances: () => [{ id: 'folder:ops', kind: 'folder' }], kind: () => ({ kind: 'folder' }) },
    })
    expect(await other('POST', 'sources/folder:ops/wechat/login')).toMatchObject({ status: 400,
      body: { error: 'The Source is not a WeChat instance' } })
  } finally {
    clearWeixinLogins()
    vi.unstubAllGlobals()
  }
})

