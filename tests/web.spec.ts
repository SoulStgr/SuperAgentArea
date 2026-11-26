/**
 * The web page/feed Source without the network: configuration checks, RSS/Atom/JSON parsing and format detection, the
 * first-poll baseline, deduplication and the per-round limit, the fetch envelope (timeout, body cap, redirects), the SSRF
 * refusals, the polling loop's health and the plugin entry — all over a fake `fetch` and a fake DNS resolver.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { WEB_MAX_BYTES, WEB_MAX_REDIRECTS, WEB_SEEN_LIMIT, WEB_TIMEOUT_MS, WEB_USER_AGENT, apply, detectFormat,
  fetchPage, isPrivateAddress, isPrivateHost, parseFeed, pollWeb, pruneSeen, watchWeb, webHealth, webInstanceOf, webItemId,
  webKind, webTrigger, webUrlProblem, type ResolveHost, type WebConfig, type WebFetch, type WebInstance, type WebItem,
  type WebTransportOptions } from '../src/sources/web.ts'
import { testDeployment } from './fixtures/deployment.ts'

let dir: string
const stores: Store[] = []
let hosts = 0
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'web-')); hosts = 0 })
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** An address that resolves to a public documentation-range address, so no DNS is ever queried. */
const PUBLIC = '203.0.113.10'
const FEED_URL = 'https://feeds.example/news.xml'
const resolveTo = (...addresses: string[]): ResolveHost => vi.fn(async () => (addresses.length ? addresses : [PUBLIC])
  .map(address => ({ address })))
const xml = (body: string, type = 'application/rss+xml'): Response => new Response(body, { status: 200, headers: { 'content-type': type } })
const redirect = (location: string, status = 302): Response => new Response(null, { status, headers: { location } })
const paths = { items: 'items', id: 'id', title: 'title', link: 'url', summary: 'summary' }

/** One recorded request: its address, the envelope and the signal the Source passed. */
interface FetchCall { url: string; method: string; redirect: RequestRedirect | undefined; headers: Headers; signal: AbortSignal | undefined }
/** A fake fetch answering whole `Response` objects, recording every call; the handler may throw to simulate a network error. */
function fetchStub(handler: (call: FetchCall) => Response | Promise<Response>): { impl: WebFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const spy = vi.fn(async (url: string, init: Parameters<WebFetch>[1]) => {
    const call: FetchCall = { url, method: init.method, redirect: init.redirect, headers: new Headers(init.headers), signal: init.signal }
    calls.push(call)
    return handler(call)
  })
  return { impl: spy as unknown as WebFetch, calls }
}
/** The transport a test uses: the fake fetch and resolver, with a short timeout and body cap so failures are quick. */
const transport = (impl: WebFetch, overrides: WebTransportOptions = {}): WebTransportOptions =>
  ({ fetch: impl, resolve: resolveTo(), timeoutMs: 1000, maxBytes: 64 * 1024, ...overrides })
const signal = (): AbortSignal => new AbortController().signal
/** A validated configuration for instance `web:news`; tests change one field to check a refusal or a round. */
const config = (overrides: Partial<WebConfig> = {}): WebConfig => webKind.schema.parse({ url: FEED_URL, operator: 'alice', ...overrides })
const instance = (overrides: Partial<WebInstance> = {}): WebInstance => ({ ...webInstanceOf('web:news', config()), ...overrides })

/** An RSS document with the items the call names. */
const rssOf = (...items: { title?: string; link?: string; guid?: string; summary?: string; date?: string }[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>News</title>${items.map(item =>
    `<item>${item.title === undefined ? '' : `<title>${item.title}</title>`}${item.link === undefined ? '' : `<link>${item.link}</link>`
    }${item.guid === undefined ? '' : `<guid isPermaLink="false">${item.guid}</guid>`}${item.date === undefined ? '' : `<pubDate>${item.date}</pubDate>`
    }${item.summary === undefined ? '' : `<description>${item.summary}</description>`}</item>`).join('')}</channel></rss>`
/** An Atom document with the entries the call names. */
const atomOf = (...entries: { id: string; title: string; href?: string; updated?: string; summary?: string }[]): string =>
  `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>${entries.map(entry =>
    `<entry><id>${entry.id}</id><title>${entry.title}</title>${entry.href === undefined ? '' : `<link rel="alternate" href="${entry.href}"/>`
    }${entry.updated === undefined ? '' : `<updated>${entry.updated}</updated>`}${entry.summary === undefined ? '' : `<summary>${entry.summary}</summary>`
    }</entry>`).join('')}</feed>`
/** The dependencies a web Source context runs on, over `store` and the registry `sources`. */
function depsOf(store: Store, sources: SourceRegistry, overrides: Partial<SourceContextDeps> = {}) {
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment({ stateDir: dir }), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: vi.fn() }, commands, sources,
    deployment: testDeployment({ stateDir: dir }), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { parts, engine, receive }
}
/** A host with one enabled `web:news` instance whose operator is on the Policy's allowed list. */
function host(sourceConfig: Partial<WebConfig> = {}, overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(dir, `db-${hosts++}.sqlite`))
  stores.push(store)
  store.saveSettings(SettingsSchema.parse({
    sources: { 'web:news': { kind: 'web', enabled: true, config: config(sourceConfig) } },
    policy: { sources: { 'web:news': { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webKind)
  const { parts, engine, receive } = depsOf(store, sources, overrides)
  return { ...parts, store, engine, receive, health: board.all, ctx: sourceContextOf(parts, webKind) }
}
/** Runs the loop until `run` finishes and always stops it, also when an assertion fails, so no round touches a closed Store. */
async function watching(h: ReturnType<typeof host>, options: WebTransportOptions, run: () => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const running = watchWeb(h.ctx, controller.signal, options)
  try { await run() } finally { controller.abort(); await running }
}

const item = (overrides: Partial<WebItem> = {}): WebItem => ({ id: 'post-1', title: 'First post',
  link: 'https://example.com/first', summary: 'Hello & welcome', publishedAt: '2026-11-24T10:00:00.000Z', ...overrides })

describe('configuration', () => {
  it('fills the defaults, keeps its fields and order, and is read-only: no Channel and no Policy part', () => {
    expect(webKind.schema.parse({})).toEqual({ url: '', format: 'auto', pollSeconds: 300, baseline: 'latest', maxItemsPerPoll: 10,
      jsonItemsPath: 'items', jsonIdPath: 'id', jsonTitlePath: 'title', jsonLinkPath: 'url', jsonSummaryPath: 'summary', operator: 'web' })
    expect(webKind).toMatchObject({ kind: 'web', order: 3, health: ['web'], title: { zh: '网页/地址', en: 'Web page or feed' } })
    expect(webKind.placeholder).toBeUndefined()
    expect(webKind.fields.map(field => field.key)).toEqual(['url', 'format', 'baseline', 'operator', 'pollSeconds', 'maxItemsPerPoll',
      'jsonItemsPath', 'jsonIdPath', 'jsonTitlePath', 'jsonLinkPath', 'jsonSummaryPath'])
    for (const field of webKind.fields) expect(field.label.zh && field.label.en, field.key).toBeTruthy()
    // Read-only: an item has no reply route and no sender policy, so the kind has neither a Channel nor a Policy part.
    expect(webKind.channel).toBeUndefined()
    expect(webKind.policy).toBeUndefined()
    expect(webKind.threadContext).toBeUndefined()
    expect(webKind.placeholder).toBeUndefined()
    // Every item is the operator's direct request: the Source listens to all of it and observes none.
    expect(webKind.scope!({ meta: {}, instance: 'web:news' }, config())).toEqual({ listened: true, observed: false })
    expect(webKind.people!(config(), 'web:news')).toEqual([{ id: 'alice' }])
    expect(webKind.people!(config({ operator: '' }), 'web:news')).toEqual([])
  })
  it('accepts only a public http/https address without credentials, and bounds the tunables', () => {
    const parse = (value: Record<string, unknown>) => (): WebConfig => webKind.schema.parse({ url: FEED_URL, ...value })
    // An incomplete account saves; a filled address must be fetchable and safe at save time.
    expect(webKind.schema.parse({ operator: 'bob' })).toMatchObject({ url: '', format: 'auto', operator: 'bob' })
    expect(parse({ url: 'ftp://feeds.example/news.xml' })).toThrow(/url/)
    expect(parse({ url: 'file:///etc/passwd' })).toThrow(/url/)
    expect(parse({ url: 'javascript:alert(1)' })).toThrow(/url/)
    expect(parse({ url: 'not a url' })).toThrow(/url/)
    expect(parse({ url: 'https://user:secret@feeds.example/news.xml' })).toThrow(/url/)
    for (const url of ['http://localhost/news.xml', 'http://app.localhost/news.xml', 'http://printer.local/news.xml',
      'http://127.0.0.1/news.xml', 'http://10.1.2.3/news.xml', 'http://172.16.0.1/news.xml', 'http://192.168.1.5/news.xml',
      'http://169.254.169.254/latest', 'http://[::1]/news.xml', 'http://[fd00::1]/news.xml']) {
      expect(() => webKind.schema.parse({ url }), url).toThrow(/url/)
    }
    for (const pollSeconds of [29, 0, 86_401, 2.5]) expect(parse({ pollSeconds }), String(pollSeconds)).toThrow()
    for (const maxItemsPerPoll of [0, 51, 1.5]) expect(parse({ maxItemsPerPoll }), String(maxItemsPerPoll)).toThrow()
    expect(parse({ format: 'xml' })).toThrow()
    expect(parse({ baseline: 'none' })).toThrow()
    expect(parse({ jsonItemsPath: 'data..items' })).toThrow(/jsonItemsPath/)
    expect(parse({ extra: 1 })).toThrow()
    // The JSON item path may be empty, meaning the document's root is the array.
    expect(parse({ jsonItemsPath: '' })).not.toThrow()
    expect(parse({ pollSeconds: 30, maxItemsPerPoll: 50, format: 'json', baseline: 'all' })())
      .toMatchObject({ pollSeconds: 30, maxItemsPerPoll: 50, format: 'json', baseline: 'all' })
  })
  it('names private ranges and local host names, and keeps a public address fetchable', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
      '0.0.0.0', '::1', '0:0:0:0:0:0:0:1', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    for (const address of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', 'printer.local', 'feed.local.']) expect(isPrivateHost(host), host).toBe(true)
    for (const host of ['feeds.example', 'local.example.com']) expect(isPrivateHost(host), host).toBe(false)
    expect(webUrlProblem(FEED_URL)).toBeUndefined()
    expect(webUrlProblem('http://feeds.example:8080/rss')).toBeUndefined()
    expect(webUrlProblem('https://feeds.example/rss?x=1#top')).toBeUndefined()
    expect(webUrlProblem('http://192.168.1.2/rss')).toMatch(/local or private/)
    expect(webUrlProblem('http://localhost/rss')).toMatch(/local or private/)
    expect(webUrlProblem('ftp://feeds.example/rss')).toMatch(/http or https/)
    expect(webUrlProblem('https://me:secret@feeds.example/rss')).toMatch(/user name or a password/)
  })
})

describe('translation', () => {
  it('names a stable id, the item thread, the operator as reporter, the item text and its meta, with no Channel', () => {
    const trigger = webTrigger(item(), instance(), 'alice', '2026-11-26T00:00:00.000Z')
    expect(trigger.id).toBe(key('web', 'web:news', 'post-1'))
    expect(trigger.source).toBe('web:news')
    expect(trigger.threads).toEqual([{ source: 'web:news', id: 'post-1' }])
    expect(threadKey(trigger.threads[0]!)).toBe('web:news:post-1')
    expect(trigger.actor).toEqual({ source: 'web:news', id: 'alice' })
    expect(trigger).toMatchObject({ human: true, addressed: 'direct', at: '2026-11-24T10:00:00.000Z',
      text: 'First post\n\nhttps://example.com/first\n\nHello & welcome', url: 'https://example.com/first' })
    expect(trigger.channel).toBeUndefined()
    expect(trigger.meta).toEqual({ row: 'web:news', itemId: 'post-1', link: 'https://example.com/first', title: 'First post',
      publishedAt: '2026-11-24T10:00:00.000Z' })
  })
  it('dates an item without a publication time by the fetch, and truncates title, link and summary to 8,000 characters', () => {
    const fetchedAt = '2026-11-26T00:00:00.000Z'
    const undated = webTrigger(item({ id: 'undated', publishedAt: undefined }), instance(), 'alice', fetchedAt)
    expect(undated.at).toBe(fetchedAt)
    expect(undated.meta.publishedAt).toBe(fetchedAt)
    const long = webTrigger(item({ id: 'long', title: 'T'.repeat(20), summary: 'x'.repeat(9000) }), instance(), 'alice', fetchedAt)
    expect(long.text).toHaveLength(8000)
    const alone = webTrigger(item({ id: 'alone', title: '', link: undefined, summary: undefined }), instance(), 'alice', fetchedAt)
    expect(alone.text).toBe('')
    expect(alone.meta.link).toBe('')
  })
})

describe('parsing', () => {
  it('reads RSS items with guid, link, pubDate and description, unwrapping CDATA and entities', () => {
    const text = rssOf(
      { title: 'First post', link: 'https://example.com/first', guid: 'post-1', summary: '<![CDATA[<p>Hello &amp; welcome</p>]]>',
        date: 'Mon, 24 Nov 2025 10:00:00 GMT' },
      { title: 'Second post', link: 'https://example.com/second', summary: 'Plain summary', date: 'Tue, 25 Nov 2025 10:00:00 GMT' })
    expect(parseFeed('rss', text, paths)).toEqual([
      { id: 'post-1', title: 'First post', link: 'https://example.com/first', summary: 'Hello & welcome',
        publishedAt: '2025-11-24T10:00:00.000Z' },
      // A missing guid uses the link, so the same post is not received twice.
      { id: 'https://example.com/second', title: 'Second post', link: 'https://example.com/second', summary: 'Plain summary',
        publishedAt: '2025-11-25T10:00:00.000Z' },
    ])
  })
  it('reads Atom entries with id, title, the alternate link href, updated and summary', () => {
    const text = atomOf(
      { id: 'tag:example.com,2026:1', title: 'Atom one', href: 'https://example.com/atom-1', updated: '2026-11-20T08:00:00Z',
        summary: 'Atom summary' },
      { id: 'tag:example.com,2026:2', title: 'Atom two', href: 'https://example.com/atom-2' })
    expect(parseFeed('atom', text, paths)).toEqual([
      { id: 'tag:example.com,2026:1', title: 'Atom one', link: 'https://example.com/atom-1', summary: 'Atom summary',
        publishedAt: '2026-11-20T08:00:00.000Z' },
      { id: 'tag:example.com,2026:2', title: 'Atom two', link: 'https://example.com/atom-2' },
    ])
  })
  it('reads a JSON list by dot paths, and falls back from a missing id to the link and then to a title+summary hash', () => {
    const document = JSON.stringify({ data: { posts: [
      { id: 'j1', title: 'JSON one', url: 'https://example.com/j1', summary: 'JSON summary' },
      { title: 'JSON two', url: 'https://example.com/j2' },
      { title: 'JSON three', summary: 'No id and no link' },
    ] } })
    const jsonPaths = { items: 'data.posts', id: 'id', title: 'title', link: 'url', summary: 'summary' }
    const items = parseFeed('json', document, jsonPaths)
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({ id: 'j1', title: 'JSON one', link: 'https://example.com/j1', summary: 'JSON summary' })
    expect(items[1]).toMatchObject({ id: 'https://example.com/j2', title: 'JSON two' })
    expect(items[2]!.id).toBe(webItemId(undefined, undefined, 'JSON three', 'No id and no link'))
    // The hash id is stable across polls of the same content, so an id-less item is still deduplicated.
    expect(parseFeed('json', document, jsonPaths)[2]!.id).toBe(items[2]!.id)
    // An empty items path reads the document's root array; a document without it is refused.
    expect(parseFeed('json', JSON.stringify([{ id: 'root' }]), { ...paths, items: '' })).toEqual([{ id: 'root', title: '' }])
    expect(() => parseFeed('json', '{"data":[]}', jsonPaths)).toThrow(/items array/)
    expect(() => parseFeed('json', '{not json', paths)).toThrow()
  })
  it('detects the format from the Content-Type and the opening bytes, and refuses an unreadable answer', () => {
    expect(detectFormat('application/rss+xml; charset=utf-8', '')).toBe('rss')
    expect(detectFormat('application/atom+xml', '')).toBe('atom')
    expect(detectFormat('application/json', '')).toBe('json')
    expect(detectFormat('text/xml', rssOf({ title: 'x' }))).toBe('rss')
    expect(detectFormat('application/xml', atomOf({ id: '1', title: 'x' }))).toBe('atom')
    expect(detectFormat('text/plain', '  {"items": []}')).toBe('json')
    expect(detectFormat('text/plain', '\uFEFF<rss version="2.0"></rss>')).toBe('rss')
    expect(() => detectFormat('text/html', '<!doctype html><html></html>')).toThrow(/neither an RSS/)
  })
  it('keeps only an http/https item link and drops a script or credential address', () => {
    const items = parseFeed('json', JSON.stringify([{ id: 'a', title: 'A', url: 'javascript:alert(1)' },
      { id: 'b', title: 'B', url: 'https://user:pass@example.com/b' }]), { ...paths, items: '' })
    expect(items[0]!.link).toBeUndefined()
    expect(items[1]!.link).toBeUndefined()
  })
})

describe('the fetch envelope', () => {
  it('sends the Source envelope: GET, manual redirects, its User-Agent and a bounded body', async () => {
    const stub = fetchStub(() => xml(rssOf({ title: 'one', guid: '1' })))
    const page = await fetchPage(FEED_URL, signal(), transport(stub.impl))
    expect(page).toMatchObject({ url: FEED_URL, contentType: 'application/rss+xml' })
    expect(page.text).toContain('<title>one</title>')
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ url: FEED_URL, method: 'GET', redirect: 'manual' })
    expect(stub.calls[0]!.headers.get('user-agent')).toBe(WEB_USER_AGENT)
    expect(stub.calls[0]!.headers.get('accept')).toContain('application/rss+xml')
  })
  it('follows at most three redirects, checking every hop, and refuses the fourth', async () => {
    const targets = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']
    const stub = fetchStub(call => redirect(targets[Math.min(stub.calls.length - 1, targets.length - 1)]!))
    await expect(fetchPage(FEED_URL, signal(), transport(stub.impl)))
      .rejects.toThrow(new RegExp(`redirected more than ${WEB_MAX_REDIRECTS} times`))
    expect(stub.calls.map(call => call.url)).toEqual([FEED_URL, ...targets])
    // A chain of exactly three redirects reaches the answer.
    const chain = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']
    const ok = fetchStub(call => {
      const index = chain.indexOf(call.url)
      if (index < 0) return redirect(chain[0]!)
      return index === chain.length - 1 ? xml(rssOf({ title: 'done', guid: 'd' })) : redirect(chain[index + 1]!)
    })
    await expect(fetchPage(FEED_URL, signal(), transport(ok.impl))).resolves.toMatchObject({ url: 'https://c.example/3' })
    expect(ok.calls.map(call => call.url)).toEqual([FEED_URL, ...chain])
  })
  it('refuses an HTTP error, a redirect without a location, and an answer over the body cap', async () => {
    const missing = fetchStub(() => new Response('nope', { status: 404 }))
    await expect(fetchPage(FEED_URL, signal(), transport(missing.impl))).rejects.toThrow(/HTTP 404/)
    const blind = fetchStub(() => new Response(null, { status: 302 }))
    await expect(fetchPage(FEED_URL, signal(), transport(blind.impl))).rejects.toThrow(/without a location/)
    const declared = fetchStub(() => new Response('x'.repeat(100), { headers: { 'content-type': 'text/plain', 'content-length': '100' } }))
    await expect(fetchPage(FEED_URL, signal(), transport(declared.impl, { maxBytes: 64 }))).rejects.toThrow(/larger than 64 bytes/)
    // A body without a declared length is read through its stream and stopped at the cap.
    const streamed = fetchStub(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('a'.repeat(40)))
      controller.enqueue(new TextEncoder().encode('b'.repeat(40)))
      controller.close()
    } }), { headers: { 'content-type': 'text/plain' } }))
    await expect(fetchPage(FEED_URL, signal(), transport(streamed.impl, { maxBytes: 64 }))).rejects.toThrow(/larger than 64 bytes/)
  })
  it('times out after its 20-second budget, and stops when the Source aborts', async () => {
    expect(WEB_TIMEOUT_MS).toBe(20_000)
    expect(WEB_MAX_BYTES).toBe(2 * 1024 * 1024)
    const hanging: WebFetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    await expect(fetchPage(FEED_URL, signal(), { fetch: hanging, resolve: resolveTo(), timeoutMs: 20 }))
      .rejects.toThrow(/timed out after/)
    const controller = new AbortController()
    const fetchImpl: WebFetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      controller.abort()
    })
    await expect(fetchPage(FEED_URL, controller.signal, { fetch: fetchImpl, resolve: resolveTo(), timeoutMs: 5000 }))
      .rejects.toThrow(/stopped during the fetch/)
  })
})

describe('SSRF protection', () => {
  it('refuses a non-http scheme, a credential address and a local host without any request', async () => {
    for (const [address, problem] of [['file:///etc/passwd', /http or https/], ['ftp://feeds.example/rss', /http or https/],
      ['https://user:secret@feeds.example/rss', /user name or a password/], ['http://localhost/rss', /local or private/],
      ['http://printer.local/rss', /local or private/], ['http://127.0.0.1/rss', /local or private/],
      ['http://[::1]/rss', /local or private/], ['http://10.0.0.7/rss', /local or private/]] as const) {
      const stub = fetchStub(() => xml(rssOf({ title: 'x', guid: 'x' })))
      await expect(fetchPage(address, signal(), transport(stub.impl)), address).rejects.toThrow(problem)
      expect(stub.calls, address).toHaveLength(0)
    }
  })
  it('refuses a host name that resolves to any private address, before the request', async () => {
    const stub = fetchStub(() => xml(rssOf({ title: 'x', guid: 'x' })))
    await expect(fetchPage(FEED_URL, signal(), transport(stub.impl, { resolve: resolveTo('10.0.0.5') })))
      .rejects.toThrow(/resolves to 10\.0\.0\.5, a local or private address/)
    // Every address the name resolves to must be public, not only the first.
    await expect(fetchPage(FEED_URL, signal(), transport(stub.impl, { resolve: resolveTo(PUBLIC, '192.168.1.5') })))
      .rejects.toThrow(/resolves to 192\.168\.1\.5/)
    expect(stub.calls).toHaveLength(0)
    // A name that cannot be resolved fails the round rather than falling through.
    const broken: ResolveHost = async () => { throw new Error('ENOTFOUND') }
    await expect(fetchPage(FEED_URL, signal(), transport(stub.impl, { resolve: broken }))).rejects.toThrow(/could not be resolved/)
    expect(stub.calls).toHaveLength(0)
  })
  it('checks every redirect target again, so a public feed cannot redirect into the private network', async () => {
    for (const location of ['http://127.0.0.1/admin', 'http://10.0.0.1/admin', 'http://[::1]/admin', 'http://localhost/admin']) {
      const stub = fetchStub(() => redirect(location))
      await expect(fetchPage(FEED_URL, signal(), transport(stub.impl)), location).rejects.toThrow(/local or private/)
      expect(stub.calls, location).toHaveLength(1)
    }
    // A redirect to another scheme is refused too, before it is fetched.
    const toFile = fetchStub(() => redirect('file:///etc/passwd'))
    await expect(fetchPage(FEED_URL, signal(), transport(toFile.impl))).rejects.toThrow(/http or https/)
    expect(toFile.calls).toHaveLength(1)
    // A redirect to a different public host re-resolves that host and passes it to the fetch.
    const pub = fetchStub(call => call.url === 'https://cdn.example/feed'
      ? xml(rssOf({ title: 'moved', guid: 'm' })) : redirect('https://cdn.example/feed'))
    const resolve = vi.fn(async (hostname: string) => [{ address: hostname === 'cdn.example' ? '198.51.100.7' : PUBLIC }])
    await expect(fetchPage(FEED_URL, signal(), transport(pub.impl, { resolve }))).resolves.toMatchObject({ url: 'https://cdn.example/feed' })
    expect(resolve.mock.calls.map(call => call[0])).toEqual(['feeds.example', 'cdn.example'])
  })
})

describe('poll rounds', () => {
  it('records the items of the first poll with the latest baseline and starts nothing, then receives only new items', async () => {
    const h = host()
    let body = rssOf({ title: 'First post', link: 'https://example.com/first', guid: 'post-1', summary: 'Hello' },
      { title: 'Older post', link: 'https://example.com/older', guid: 'post-0' })
    const stub = fetchStub(() => xml(body))
    expect(await pollWeb(h.ctx, instance(), 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 2, received: 0, skipped: 2, deferred: 0, baseline: true })
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.web.seen('web:news'))).toEqual({ 'post-1': expect.any(String), 'post-0': expect.any(String) })
    expect(h.store.get(KV.web.initialized('web:news'))).toBe(true)
    // The next poll receives the new item once; the recorded ones are skipped.
    body = rssOf({ title: 'Fresh post', link: 'https://example.com/fresh', guid: 'post-2', summary: 'Fresh' },
      { title: 'First post', link: 'https://example.com/first', guid: 'post-1', summary: 'Hello' })
    expect(await pollWeb(h.ctx, instance(), 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 2, received: 1, skipped: 1, deferred: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger).toMatchObject({ source: 'web:news', actor: { source: 'web:news', id: 'alice' } })
    expect(trigger).toMatchObject({ meta: { itemId: 'post-2', link: 'https://example.com/fresh', title: 'Fresh post' } })
    // The item was stored as an explicit request of the allowed operator.
    expect(h.engine.candidate(trigger.id)?.strength).toBe('explicit')
    // A third poll of the unchanged feed starts nothing.
    expect(await pollWeb(h.ctx, instance(), 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 2, received: 0, skipped: 2, deferred: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
  })
  it('starts work on the whole backlog with the all baseline, bounded by maxItemsPerPoll', async () => {
    const h = host({ baseline: 'all', maxItemsPerPoll: 2 })
    const all = instance({ baseline: 'all', maxItemsPerPoll: 2 })
    let body = rssOf({ title: 'One', guid: '1' }, { title: 'Two', guid: '2' }, { title: 'Three', guid: '3' })
    const stub = fetchStub(() => xml(body))
    expect(await pollWeb(h.ctx, all, 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 3, received: 2, skipped: 0, deferred: 1, baseline: true })
    // The deferred item and any newer one wait for the next round.
    body = rssOf({ title: 'Four', guid: '4' }, { title: 'Three', guid: '3' })
    expect(await pollWeb(h.ctx, all, 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 2, received: 2, skipped: 0, deferred: 0 })
    expect(h.receive.mock.calls.map(call => (call[0].meta as { itemId: string }).itemId)).toEqual(['1', '2', '4', '3'])
  })
  it('receives an item once even when the seen record is lost, because a repeated Trigger is a duplicate', async () => {
    const h = host({ baseline: 'all' })
    const all = instance({ baseline: 'all' })
    const stub = fetchStub(() => xml(rssOf({ title: 'One', guid: 'dup' })))
    expect(await pollWeb(h.ctx, all, 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 1, received: 1, skipped: 0, deferred: 0, baseline: true })
    h.store.delete(KV.web.seen('web:news'))
    expect(await pollWeb(h.ctx, all, 'alice', signal(), transport(stub.impl)))
      .toMatchObject({ read: 1, received: 0, skipped: 1 })
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(h.store.get(KV.web.seen('web:news'))).toEqual({ dup: expect.any(String) })
  })
  it('reads a JSON feed, auto-detects the format, and keeps the limit to the new items of the round', async () => {
    const h = host({ format: 'auto', baseline: 'all', maxItemsPerPoll: 1 })
    const jsonInstance = instance({ format: 'auto', baseline: 'all', maxItemsPerPoll: 1, paths: { ...paths, items: '' } })
    let body = JSON.stringify([{ id: 'j1', title: 'From the root array' }])
    const stub = fetchStub(() => new Response(body, { headers: { 'content-type': 'application/json' } }))
    expect(await pollWeb(h.ctx, jsonInstance, 'alice', signal(), transport(stub.impl)))
      .toMatchObject({ read: 1, received: 1 })
    expect(h.receive.mock.calls[0]![0].text).toContain('From the root array')
    body = JSON.stringify([{ id: 'j2', title: 'Second' }, { id: 'j3', title: 'Third' }])
    expect(await pollWeb(h.ctx, jsonInstance, 'alice', signal(), transport(stub.impl)))
      .toEqual({ read: 2, received: 1, skipped: 0, deferred: 1 })
  })
  it('throws for an HTTP, parse or SSRF failure so the loop counts it, and records nothing', async () => {
    const h = host()
    const failing = fetchStub(() => new Response('gone', { status: 500 }))
    await expect(pollWeb(h.ctx, instance(), 'alice', signal(), transport(failing.impl))).rejects.toThrow(/HTTP 500/)
    expect(h.store.get(KV.web.seen('web:news'))).toBeUndefined()
    expect(h.store.get(KV.web.initialized('web:news'))).toBeUndefined()
    const badFormat = fetchStub(() => new Response('<html>not a feed</html>', { headers: { 'content-type': 'text/html' } }))
    await expect(pollWeb(h.ctx, instance(), 'alice', signal(), transport(badFormat.impl))).rejects.toThrow(/neither an RSS/)
    const blocked = fetchStub(() => xml(rssOf({ title: 'x', guid: 'x' })))
    await expect(pollWeb(h.ctx, instance(), 'alice', signal(), transport(blocked.impl, { resolve: resolveTo('10.0.0.9') })))
      .rejects.toThrow(/local or private/)
    expect(blocked.calls).toHaveLength(0)
    expect(h.receive).not.toHaveBeenCalled()
  })
})

describe('deduplication bookkeeping', () => {
  it('forgets seen ids older than seven days and keeps at most a thousand of the newest', () => {
    const now = Date.parse('2026-11-26T00:00:00.000Z')
    const fresh = new Date(now - 3_600_000).toISOString()
    const old = new Date(now - 8 * 24 * 3600_000).toISOString()
    expect(pruneSeen({ old, fresh, broken: 'not a date' }, now)).toEqual({ fresh })
    const many = Object.fromEntries(Array.from({ length: WEB_SEEN_LIMIT + 5 }, (_, index) =>
      [`item-${index}`, new Date(now - index * 1000).toISOString()]))
    const kept = pruneSeen(many, now)
    expect(Object.keys(kept)).toHaveLength(WEB_SEEN_LIMIT)
    // The newest survive; the five oldest are forgotten first.
    expect(kept['item-0']).toBeDefined()
    expect(kept[`item-${WEB_SEEN_LIMIT + 4}`]).toBeUndefined()
  })
  it('keeps at most a thousand ids when a feed brings more items at once', async () => {
    const h = host({ baseline: 'latest' })
    const items = Array.from({ length: WEB_SEEN_LIMIT + 10 }, (_, index) => ({ title: `Item ${index}`, guid: `id-${index}` }))
    const stub = fetchStub(() => xml(rssOf(...items)))
    await pollWeb(h.ctx, instance(), 'alice', signal(), transport(stub.impl, { maxBytes: 2 * 1024 * 1024 }))
    expect(Object.keys(h.store.get(KV.web.seen('web:news'))!)).toHaveLength(WEB_SEEN_LIMIT)
  })
})

describe('health', () => {
  it('reports a ready round with its read, new and skipped counts', () => {
    expect(webHealth({ failures: 0, read: 12, received: 3, skipped: 8, deferred: 1 }))
      .toMatchObject({ state: 'ready', detail: '12 items, 3 new, 8 skipped; 1 more wait for the next round' })
    expect(webHealth({ failures: 0, read: 2, received: 0, skipped: 2, deferred: 0, baseline: true }))
      .toMatchObject({ state: 'ready', detail: '2 items, 0 new, 2 skipped; baseline recorded the current items' })
  })
  it('reports an error only after three consecutive failed rounds, and a later good round clears it', () => {
    expect(webHealth({ failures: 2, read: 0, received: 0, skipped: 0, deferred: 0, error: 'The web address answered HTTP 500' }))
      .toMatchObject({ state: 'ready' })
    const failed = webHealth({ failures: 3, read: 0, received: 0, skipped: 0, deferred: 0, error: 'The web address answered HTTP 500' })
    expect(failed).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3', error: 'The web address answered HTTP 500' } })
    expect(failed.detail).toContain('3 consecutive failed polls')
    // The loop rebuilds the round's failure count to zero on its next success, so the entry goes back to ready.
    expect(webHealth({ failures: 0, read: 3, received: 1, skipped: 2, deferred: 0 })).toMatchObject({ state: 'ready' })
  })
  it('waits for setup, is paused without an address, and reports the first round of a configured instance', async () => {
    const waiting = host({}, { configured: () => false })
    await watchWeb(waiting.ctx, new AbortController().signal, transport(fetchStub(() => xml('')).impl))
    expect(waiting.health['web:news']).toMatchObject({ state: 'paused', code: 'setupPending' })
    const empty = host({ url: '' })
    await watching(empty, transport(fetchStub(() => xml('')).impl), async () => {
      await vi.waitFor(() => expect(empty.health['web:news']).toMatchObject({ state: 'paused',
        detail: 'The web address is not configured: url' }))
    })
    const h = host()
    const stub = fetchStub(() => xml(rssOf({ title: 'One', guid: '1' }, { title: 'Two', guid: '2' })))
    await watching(h, transport(stub.impl), async () => {
      await vi.waitFor(() => expect(h.health['web:news']).toMatchObject({ state: 'ready',
        detail: '2 items, 0 new, 2 skipped; baseline recorded the current items' }))
      expect(h.receive).not.toHaveBeenCalled()
    })
  })
  it('registers its kind and starts its loop from the plugin entry', async () => {
    const store = new Store(join(dir, 'plugin.sqlite'))
    stores.push(store)
    store.saveSettings(SettingsSchema.parse({ sources: { 'web:news': { kind: 'web', enabled: true, config: config() } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    const { parts } = depsOf(store, sources)
    const disposers: (() => unknown)[] = []
    const ctx = { orchestrator: { sources,
      context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) } }
    apply(ctx as never, transport(fetchStub(() => xml(rssOf({ title: 'One', guid: '1' }))).impl))
    await vi.waitFor(() => expect(board.all['web:news']).toMatchObject({ state: 'ready' }))
    expect(sources.kind('web')).toBe(webKind)
    for (const dispose of disposers.reverse()) await dispose()
  })
})
