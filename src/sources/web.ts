/**
 * Web page or feed Source: one instance polls one public http(s) address — an RSS or Atom feed, or a JSON document holding
 * a list of items — and every new item becomes an explicit Trigger of the instance's operator. The Source is read-only: an
 * item has no reply route, so the kind has no Channel, and no Policy part either; its operator is the reporter.
 *
 * A request passes the same SSRF checks on the first address and on every redirect hop: http/https only, no user name or
 * password, and no local or private address after the host is resolved (all of its addresses must be public). `baseline`
 * decides what the first poll does with the items already there: `latest` only records them, `all` starts work on them.
 * Item ids are remembered for seven days so one item is received once, and `maxItemsPerPoll` bounds a round.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { key, threadKey, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, reportFailure, sourceContext, type Health, type SourceContext } from './host.ts'
import type { FieldSpec, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

/** How long one request may take, from its first hop to the end of its body. */
export const WEB_TIMEOUT_MS = 20_000
/** How much of a response body the Source reads; a longer answer is refused rather than buffered. */
export const WEB_MAX_BYTES = 2 * 1024 * 1024
/** How many redirects one request follows; every hop is checked again before it is fetched. */
export const WEB_MAX_REDIRECTS = 3
/** The User-Agent every request names, so a feed operator can see where the load comes from. */
export const WEB_USER_AGENT = 'dsh-superagent/web'
/** How long a received item id is remembered. */
export const WEB_SEEN_TTL_MS = 7 * 24 * 3600_000
/** How many received item ids are kept; a busier feed forgets its oldest ones first. */
export const WEB_SEEN_LIMIT = 1000
/** How much of an item's title, link and summary the Trigger carries. */
export const WEB_TEXT_CHARS = 8000
const ACCEPT = 'application/rss+xml, application/atom+xml, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5'
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** The formats one instance may expect; `auto` reads the answer's Content-Type and opening bytes. */
export type WebFormat = 'auto' | 'rss' | 'atom' | 'json'
/** The parser a concrete answer is read with. */
export type WebFeedFormat = Exclude<WebFormat, 'auto'>
/** What the first poll does with items that were already in the feed when the instance was added. */
export type WebBaseline = 'latest' | 'all'
/** The dot paths a JSON document is read with; an empty item path reads the document's root array. */
export interface WebJsonPaths { items: string; id: string; title: string; link: string; summary: string }
/** One instance's reading of its address, as a poll round and its Trigger builder use it. */
export interface WebInstance {
  id: string; url: string; format: WebFormat; baseline: WebBaseline; maxItemsPerPoll: number; paths: WebJsonPaths
}
/** One item of a feed or JSON document, before it becomes a Trigger. */
export interface WebItem { id: string; title: string; link?: string; summary?: string; publishedAt?: string }
/** What one poll round did: what it read, how many new items it received, how many it skipped and how many wait. */
export interface WebRound { read: number; received: number; skipped: number; deferred: number; baseline?: true }
/** One page read from the address: where it finally came from, its declared type and its body text. */
export interface WebPage { url: string; contentType: string; text: string }
/** Resolves a host name to every address it names; tests replace it so no DNS query is made. */
export type ResolveHost = (hostname: string) => Promise<{ address: string }[]>
/** The fetch the Source runs; `manual` redirects are followed by hand so every hop is checked. */
export type WebFetch = (url: string, init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>
/** How a polling loop reaches the web: the fetch, DNS resolution and the bounds; tests replace the first two. */
export interface WebTransportOptions { fetch?: WebFetch; resolve?: ResolveHost; timeoutMs?: number; maxBytes?: number }

const dnsLookup: ResolveHost = async hostname => lookup(hostname, { all: true, verbatim: true })
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}…` : text

/** The four numbers of an IPv4 address, or undefined when `address` is not one. */
function ipv4Of(address: string): number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const numbers = parts.map(part => /^\d{1,3}$/.test(part) ? Number(part) : NaN)
  return numbers.every(number => Number.isInteger(number) && number >= 0 && number <= 255) ? numbers : undefined
}
/**
 * True when `address` is an address no public feed can legitimately live at: IPv4 loopback, private, link-local and
 * "this network" ranges, IPv6 loopback, unique-local (`fc00::/7`) and link-local (`fe80::/10`) ranges, and IPv4-mapped
 * forms of those. The check is the SSRF guard, so it covers every address a host name resolves to.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = ipv4Of(value)
  if (ipv4) {
    const [first, second] = ipv4 as [number, number, number, number]
    return first === 0 || first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168) || (first === 169 && second === 254)
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped) return isPrivateAddress(mapped[1]!)
  // A full IPv6 address may spell loopback without the `::` shorthand.
  if (value === '::1' || /^(?:0:){7}1$/.test(value)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true
  return false
}
/** True when `host` is a literal local name rather than a public host name: `localhost` and anything under `.local`. */
export function isPrivateHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')
}
/**
 * Why `raw` is not usable as a public feed address, or undefined when it is: an absolute http/https URL, without a user
 * name or password, naming neither a local host name nor a private address. A host name is only resolved at fetch time,
 * where every address it names is checked; this save-time check refuses what can be told without one.
 */
export function webUrlProblem(raw: string): string | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return 'must be an absolute http or https address' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'must be an absolute http or https address'
  if (url.username || url.password) return 'must not carry a user name or a password'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) return 'must name a host'
  if (isIP(host) ? isPrivateAddress(host) : isPrivateHost(host)) return 'must not name a local or private address'
  return undefined
}
/** Why `value` is not a dot path (`data.items`, `0.title`) or undefined; an empty path is allowed for the item list's root. */
function dotPathProblem(value: string): string | undefined {
  return value === '' || /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(value) ? undefined : 'must be a dot path such as data.items'
}

const ConfigSchema = z.object({
  /** The public http(s) address this instance reads, such as an RSS feed or a JSON endpoint. */
  url: z.string().trim().default(''),
  format: z.enum(['auto', 'rss', 'atom', 'json']).default('auto'),
  /** 300 by default, at least 30: a feed is a public page, not a chat. */
  pollSeconds: z.number().int().min(30).max(86400).default(300),
  /** `latest` records the items present on the first poll without starting work; `all` starts work on them all. */
  baseline: z.enum(['latest', 'all']).default('latest'),
  /** How many new items one round receives; the rest wait for the next round. */
  maxItemsPerPoll: z.number().int().min(1).max(50).default(10),
  jsonItemsPath: z.string().trim().default('items'),
  jsonIdPath: z.string().trim().default('id'),
  jsonTitlePath: z.string().trim().default('title'),
  jsonLinkPath: z.string().trim().default('url'),
  jsonSummaryPath: z.string().trim().default('summary'),
  /** Actor id of the operator this instance reports its items for; `web` by default, and empty falls back to the OS user name. */
  operator: z.string().trim().default('web'),
}).strict().superRefine((config, ctx) => {
  const issue = (field: string, message: string | undefined): void => {
    if (message) ctx.addIssue({ code: 'custom', path: [field], message })
  }
  // An empty address keeps an account saveable before it is complete; a filled one must be safe to fetch.
  if (config.url) issue('url', webUrlProblem(config.url))
  for (const [field, value] of [['jsonItemsPath', config.jsonItemsPath], ['jsonIdPath', config.jsonIdPath],
    ['jsonTitlePath', config.jsonTitlePath], ['jsonLinkPath', config.jsonLinkPath], ['jsonSummaryPath', config.jsonSummaryPath]] as const) {
    issue(field, dotPathProblem(value))
  }
})
export type WebConfig = z.infer<typeof ConfigSchema>

/** The instance a stored configuration describes, as `pollWeb` and its Trigger builder read it. */
export function webInstanceOf(id: string, config: WebConfig): WebInstance {
  return { id, url: config.url, format: config.format, baseline: config.baseline, maxItemsPerPoll: config.maxItemsPerPoll,
    paths: { items: config.jsonItemsPath, id: config.jsonIdPath, title: config.jsonTitlePath, link: config.jsonLinkPath,
      summary: config.jsonSummaryPath } }
}

/** Decodes the XML entities a feed may carry in text and attribute values. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (match, decimal?: string, hex?: string, named?: string) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return named === 'lt' ? '<' : named === 'gt' ? '>' : named === 'quot' ? '"' : named === 'apos' ? "'" : '&'
  })
}
/** The visible text of a feed value: CDATA unwrapped, tags dropped and whitespace collapsed. */
function plainText(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  const text = cdata ? cdata[1]! : value
  return decodeEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}
/** The tags named `name` in `xml`, whatever namespace prefix they carry; their inner text. */
function xmlBlocks(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'gi')
  return [...xml.matchAll(pattern)].map(match => match[1] ?? '')
}
/** The text of the first `name` tag in `block`, CDATA unwrapped but not yet entity-decoded. */
function xmlTag(block: string, name: string): string | undefined {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'i')
  const match = pattern.exec(block)
  if (!match) return undefined
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(match[1] ?? '')
  return (cdata ? cdata[1]! : match[1] ?? '').trim() || undefined
}
/** The attributes of every `link` tag in an Atom entry, with the alternate link first. */
function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<(?:[\w.-]+:)?link\b([^>]*?)\/?>/gi)].map(match => {
    const attributes: Record<string, string> = {}
    for (const attribute of (match[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attribute[1]!.toLowerCase()] = decodeEntities(attribute[2] ?? attribute[3] ?? '')
    }
    return attributes
  })
  return (links.find(attributes => !attributes.rel || attributes.rel === 'alternate') ?? links[0])?.href
}
/** A link an item may carry: only an absolute http/https address without a user name or password is kept. */
function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  return url.toString()
}
/** The item id: its own id, else its link, else a hash of its title and summary, so an id-less feed still deduplicates. */
export function webItemId(rawId: string | undefined, link: string | undefined, title: string, summary: string | undefined): string {
  const named = rawId?.trim() || link?.trim()
  if (named) return clip(named, 500)
  const digest = createHash('sha256').update(JSON.stringify([title, summary ?? ''])).digest('hex').slice(0, 32)
  return key('web-item', digest)
}
/** The published date of an item as an ISO timestamp, or undefined when it states none or one Date cannot parse. */
function isoTimeOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}
/** One item built from its parts, with an id and the trimmed fields a Trigger and its Thread carry. */
function itemOf(parts: { id?: string; title?: string; link?: string; summary?: string; publishedAt?: string }): WebItem {
  const title = clip(plainText(parts.title ?? ''), 1000)
  const summary = clip(plainText(parts.summary ?? ''), WEB_TEXT_CHARS)
  const link = safeLink(parts.link)
  const id = webItemId(parts.id, link, title, summary || undefined)
  const publishedAt = isoTimeOf(parts.publishedAt)
  return { id, title, ...link ? { link } : {}, ...summary ? { summary } : {}, ...publishedAt ? { publishedAt } : {} }
}
/** Every `<item>` of an RSS document. */
function parseRss(xml: string): WebItem[] {
  return xmlBlocks(xml, 'item').map(block => itemOf({ id: xmlTag(block, 'guid'), title: xmlTag(block, 'title'),
    link: xmlTag(block, 'link'), summary: xmlTag(block, 'description'), publishedAt: xmlTag(block, 'pubDate') }))
}
/** Every `<entry>` of an Atom document: its id, title, alternate link, updated (or published) time and summary. */
function parseAtom(xml: string): WebItem[] {
  return xmlBlocks(xml, 'entry').map(block => itemOf({ id: xmlTag(block, 'id'), title: xmlTag(block, 'title'),
    link: atomLink(block), summary: xmlTag(block, 'summary') ?? xmlTag(block, 'content'),
    publishedAt: xmlTag(block, 'updated') ?? xmlTag(block, 'published') }))
}
/** The value at a dot path (`data.items`, `0.title`) of a parsed JSON document. */
function pathValue(root: unknown, path: string): unknown {
  let current = root
  for (const part of path === '' ? [] : path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else return undefined
  }
  return current
}
/** The string at a dot path, numbers and booleans spelled out; undefined while the path is empty or names no value. */
function textAt(root: unknown, path: string): string | undefined {
  if (!path) return undefined
  const value = pathValue(root, path)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}
/** The items of a JSON document: the array at `paths.items` (or the document itself), each read by its dot paths. */
function parseJson(text: string, paths: WebJsonPaths): WebItem[] {
  const document: unknown = JSON.parse(text)
  const list = paths.items === '' ? document : pathValue(document, paths.items)
  if (!Array.isArray(list)) throw new Error(`The JSON answer has no items array${paths.items === '' ? ' at its root' : ` at "${paths.items}"`}`)
  return list.flatMap((entry): WebItem[] => entry && typeof entry === 'object'
    ? [itemOf({ id: textAt(entry, paths.id), title: textAt(entry, paths.title), link: textAt(entry, paths.link),
      summary: textAt(entry, paths.summary) })]
    : [])
}
/** The parser `format` names, or the one the answer's Content-Type and opening bytes state. */
export function detectFormat(contentType: string, text: string): WebFeedFormat {
  const type = contentType.toLowerCase()
  const opening = text.replace(/^\uFEFF/, '').trimStart().slice(0, 4096)
  if (type.includes('json') || opening.startsWith('{') || opening.startsWith('[')) return 'json'
  if (type.includes('rss')) return 'rss'
  if (type.includes('atom')) return 'atom'
  if (/<(?:\w+:)?rss[\s>]/i.test(opening)) return 'rss'
  if (/<(?:\w+:)?feed[\s>]/i.test(opening)) return 'atom'
  if (/<(?:\w+:)?item[\s>]/i.test(opening)) return 'rss'
  if (/<(?:\w+:)?entry[\s>]/i.test(opening)) return 'atom'
  throw new Error('The web answer is neither an RSS/Atom feed nor a JSON document')
}
/** The items of one answer read with an explicit format; a malformed answer throws. */
export function parseFeed(format: WebFeedFormat, text: string, paths: WebJsonPaths): WebItem[] {
  if (format === 'json') return parseJson(text, paths)
  if (format === 'rss') return parseRss(text)
  return parseAtom(text)
}

/** Refuses an address the Source must not fetch: another scheme, credentials, or a local/private host or address. */
async function checkTarget(url: URL, resolve: ResolveHost): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`The web address must be http or https, not ${url.protocol}`)
  if (url.username || url.password) throw new Error('The web address must not carry a user name or a password')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new Error('The web address names no host')
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`The web address ${host} is a local or private address`)
    return
  }
  if (isPrivateHost(host)) throw new Error(`The web address ${host} is a local or private address`)
  let addresses: { address: string }[]
  try { addresses = await resolve(host) }
  catch { throw new Error(`The web address ${host} could not be resolved`) }
  if (!addresses.length) throw new Error(`The web address ${host} resolved to no address`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`The web address ${host} resolves to ${address}, a local or private address`)
  }
}
/** Reads at most `limit` bytes of a response body, refusing a body declared or found to be longer. */
async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const sized = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(sized) && sized > limit) throw new Error(`The web answer is larger than ${limit} bytes`)
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > limit) throw new Error(`The web answer is larger than ${limit} bytes`)
    return body
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error('The web fetch was stopped')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error(`The web answer is larger than ${limit} bytes`)
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}
/**
 * Fetches one public http(s) address with the Source's own envelope: a 20 s timeout, a manual redirect chain of at most
 * three hops (each hop checked again), a 2 MiB body cap and the `dsh-superagent/web` User-Agent. The address, its
 * resolved addresses and every redirect target pass the SSRF checks; a `file:` or other scheme is refused.
 */
export async function fetchPage(address: string, signal: AbortSignal, options: WebTransportOptions = {}): Promise<WebPage> {
  const fetchImpl: WebFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const resolve = options.resolve ?? dnsLookup
  const timeoutMs = options.timeoutMs ?? WEB_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? WEB_MAX_BYTES
  let url: URL
  try { url = new URL(address) } catch { throw new Error('The web address must be an absolute http or https address') }
  const stopped = new AbortController()
  const timer = setTimeout(() => stopped.abort(new Error('timeout')), timeoutMs)
  const combined = AbortSignal.any([signal, stopped.signal])
  try {
    for (let hop = 0; hop <= WEB_MAX_REDIRECTS; hop += 1) {
      await checkTarget(url, resolve)
      let response: Response
      try {
        response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', headers: { 'user-agent': WEB_USER_AGENT,
          accept: ACCEPT }, signal: combined })
      } catch (error) {
        if (signal.aborted) throw new Error('The web Source stopped during the fetch')
        if (stopped.signal.aborted) throw new Error(`The web address timed out after ${Math.round(timeoutMs / 1000)} s`)
        throw error
      }
      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (!location) throw new Error(`The web address answered ${response.status} without a location`)
        if (hop === WEB_MAX_REDIRECTS) throw new Error(`The web address redirected more than ${WEB_MAX_REDIRECTS} times`)
        let next: URL
        try { next = new URL(location, url) } catch { throw new Error('The web address redirected to an invalid location') }
        url = next
        continue
      }
      if (!response.ok) throw new Error(`The web address answered HTTP ${response.status}`)
      const body = await readBody(response, maxBytes, combined)
      return { url: url.toString(), contentType: response.headers.get('content-type') ?? '', text: body.toString('utf8') }
    }
    throw new Error(`The web address redirected more than ${WEB_MAX_REDIRECTS} times`)
  } finally { clearTimeout(timer) }
}

/** The Trigger of one item on `instance`: its Thread is the item id, the operator is the reporter, and there is no Channel. */
export function webTrigger(item: WebItem, instance: WebInstance, operator: string, fetchedAt: string): Trigger {
  const at = item.publishedAt ?? fetchedAt
  const text = [item.title, item.link, item.summary].filter((part): part is string => !!part).join('\n\n').slice(0, WEB_TEXT_CHARS)
  return {
    id: key('web', instance.id, item.id),
    source: instance.id,
    threads: [{ source: instance.id, id: item.id }],
    actor: { source: instance.id, id: operator },
    human: true,
    addressed: 'direct',
    at,
    text,
    ...item.link ? { url: item.link } : {},
    meta: { row: instance.id, itemId: item.id, link: item.link ?? '', title: item.title, publishedAt: at },
  }
}

/** Keeps the item ids seen within the last seven days, newest first and at most `WEB_SEEN_LIMIT` of them. */
export function pruneSeen(seen: Record<string, string>, now: number): Record<string, string> {
  const kept = Object.entries(seen).filter(([, at]) => {
    const time = Date.parse(at)
    return Number.isFinite(time) && now - time < WEB_SEEN_TTL_MS
  })
  kept.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
  return Object.fromEntries(kept.slice(0, WEB_SEEN_LIMIT))
}
/**
 * One poll round: fetch the instance's address, read it in its format, and receive a Trigger for each item it has not
 * received before — at most `maxItemsPerPoll` of them, the rest waiting for the next round. The first round with
 * `baseline: 'latest'` only records the items already there, so adding an address does not open Tickets for old news.
 * Received ids are stored only after every receive of the round, so a failed round is retried without a second Trigger.
 */
export async function pollWeb(ctx: SourceContext, instance: WebInstance, operator: string, signal: AbortSignal,
  options: WebTransportOptions = {}): Promise<WebRound> {
  const problem = webUrlProblem(instance.url)
  if (problem) throw new Error(`The web address is unusable: ${problem}`)
  const page = await fetchPage(instance.url, signal, options)
  const format = instance.format === 'auto' ? detectFormat(page.contentType, page.text) : instance.format
  const items = parseFeed(format, page.text, instance.paths)
  const fetchedAt = new Date().toISOString()
  const seen = ctx.state.get(KV.web.seen(instance.id)) ?? {}
  const first = ctx.state.get(KV.web.initialized(instance.id)) !== true
  if (first && instance.baseline === 'latest') {
    const recorded = pruneSeen({ ...seen, ...Object.fromEntries(items.map((item): [string, string] => [item.id, fetchedAt])) },
      Date.parse(fetchedAt))
    ctx.atomic(() => {
      ctx.state.set(KV.web.seen(instance.id), recorded)
      ctx.state.set(KV.web.initialized(instance.id), true)
    })
    return { read: items.length, received: 0, skipped: items.length, deferred: 0, baseline: true }
  }
  const fresh = items.filter(item => !seen[item.id])
  const taken = fresh.slice(0, instance.maxItemsPerPoll)
  const deferred = fresh.length - taken.length
  const nextSeen: Record<string, string> = { ...seen }
  let received = 0
  for (const item of taken) {
    if (signal.aborted) throw new Error('The web Source stopped during the read')
    const trigger = webTrigger(item, instance, operator, fetchedAt)
    const result = await ctx.receive(trigger)
    nextSeen[item.id] = fetchedAt
    if (result !== 'duplicate') received += 1
    ctx.threads.describe(threadKey(trigger.threads[0]!), { label: item.title || item.id, ...item.link ? { url: item.link } : {} })
  }
  const recorded = pruneSeen(nextSeen, Date.parse(fetchedAt))
  ctx.atomic(() => {
    ctx.state.set(KV.web.seen(instance.id), recorded)
    ctx.state.set(KV.web.initialized(instance.id), true)
  })
  return { read: items.length, received, skipped: Math.max(0, items.length - received - deferred), deferred,
    ...first ? { baseline: true as const } : {} }
}

/** What one instance's loop has done since startup, for that instance's own health detail. */
interface WebLoopRound extends WebRound { failures: number; error?: string }
/** The health one instance's entry reports: a poll error once it failed three rounds in a row, else the round's counts. */
export function webHealth(round: WebLoopRound): Health {
  if (round.failures >= 3) return health('error', 'pollFailures', { count: String(round.failures), error: round.error ?? 'failed' })
  const baseline = round.baseline ? '; baseline recorded the current items' : ''
  const deferred = round.deferred ? `; ${round.deferred} more wait for the next round` : ''
  return { state: 'ready', detail: `${round.read} items, ${round.received} new, ${round.skipped} skipped${baseline}${deferred}`,
    at: new Date().toISOString() }
}
/** Why an enabled instance cannot poll: no address, or one the save-time check would refuse. */
function pausedDetail(config: WebConfig): string {
  if (!config.url) return 'The web address is not configured: url'
  return `The web address is unusable: ${webUrlProblem(config.url)}`
}
/**
 * The polling loop: waits for setup, follows the switch, polls each enabled instance on its own interval, reports each
 * instance's own health, and stops at once on abort. An enabled instance whose address is still empty is paused with what
 * it waits for, rather than counted as a failed poll.
 */
export async function watchWeb(ctx: SourceContext, signal: AbortSignal, options: WebTransportOptions = {}): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    for (const instance of ctx.instances('web')) ctx.report(instance.id, health('paused', 'setupPending'))
    return
  }
  const rounds = new Map<string, WebLoopRound>()
  const due = new Map<string, number>()
  while (!signal.aborted) {
    const instances = ctx.instances<WebConfig>('web')
    const enabled = instances.filter(instance => instance.enabled)
    const active = enabled.filter(instance => webUrlProblem(instance.config.url) === undefined)
    if (!enabled.length) for (const instance of instances) ctx.report(instance.id, health('paused', 'sourceOff'))
    else if (!active.length) {
      for (const instance of enabled) ctx.report(instance.id, { state: 'paused', detail: pausedDetail(instance.config),
        at: new Date().toISOString() })
    } else {
      const now = Date.now()
      for (const instance of active) {
        if ((due.get(instance.id) ?? 0) > now) continue
        due.set(instance.id, now + instance.config.pollSeconds * 1000)
        const round = rounds.get(instance.id) ?? { failures: 0, read: 0, received: 0, skipped: 0, deferred: 0 }
        rounds.set(instance.id, round)
        round.read = 0; round.received = 0; round.skipped = 0; round.deferred = 0; delete round.baseline
        try {
          const operator = instance.config.operator || userInfo().username
          const polled = await pollWeb(ctx, webInstanceOf(instance.id, instance.config), operator, signal, options)
          round.failures = 0; round.error = undefined
          round.read = polled.read; round.received = polled.received; round.skipped = polled.skipped
          round.deferred = polled.deferred; if (polled.baseline) round.baseline = true
        } catch (error) {
          round.failures += 1; round.error = clip(String(error), 500)
        }
        ctx.report(instance.id, webHealth(round))
      }
    }
    const seconds = active.length ? Math.min(...active.map(instance => instance.config.pollSeconds)) : 30
    await pause(seconds * 1000, signal)
  }
}

const fields: FieldSpec[] = [
  { key: 'url', type: 'text', label: { zh: '地址', en: 'Address' },
    hint: { zh: '公开的 RSS/Atom 订阅地址或 JSON 地址（http/https）', en: 'A public RSS/Atom feed or JSON address (http/https)' } },
  { key: 'format', type: 'select', label: { zh: '格式', en: 'Format' }, options: [
    { value: 'auto', label: { zh: '自动识别', en: 'Automatic' } },
    { value: 'rss', label: { zh: 'RSS', en: 'RSS' } },
    { value: 'atom', label: { zh: 'Atom', en: 'Atom' } },
    { value: 'json', label: { zh: 'JSON', en: 'JSON' } },
  ] },
  { key: 'baseline', type: 'select', label: { zh: '首次拉取', en: 'First poll' }, options: [
    { value: 'latest', label: { zh: '只记录当前条目', en: 'Record current items only' } },
    { value: 'all', label: { zh: '全部建单', en: 'Start work on all' } },
  ], hint: { zh: '只记录：首次轮询不建单，之后的轮询只为新条目建单', en: 'Record only: the first poll starts nothing; later polls start work on new items' } },
  { key: 'operator', type: 'text', label: { zh: '汇报人', en: 'Operator' },
    hint: { zh: '默认 web；条目的汇报人与归属，留空用本机用户名', en: 'Defaults to web; reported and attributed as this operator, empty uses the OS user name' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 86400, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  { key: 'maxItemsPerPoll', type: 'number', advanced: true, min: 1, max: 50,
    label: { zh: '每轮最多新条目', en: 'New items per round' }, hint: { zh: '超过的条目留到下一轮，健康详情会写明还有多少', en: 'The rest wait for the next round; the health detail names how many' } },
  { key: 'jsonItemsPath', type: 'text', advanced: true, label: { zh: 'JSON 条目数组路径', en: 'JSON items array path' },
    hint: { zh: '点路径，如 data.items；留空表示根就是数组', en: 'A dot path such as data.items; empty reads the root array' } },
  { key: 'jsonIdPath', type: 'text', advanced: true, label: { zh: 'JSON 条目 id 路径', en: 'JSON item id path' }, hint: { zh: '缺 id 时用链接，再缺用标题+摘要哈希', en: 'Missing: the link; missing too: a title+summary hash' } },
  { key: 'jsonTitlePath', type: 'text', advanced: true, label: { zh: 'JSON 标题路径', en: 'JSON title path' } },
  { key: 'jsonLinkPath', type: 'text', advanced: true, label: { zh: 'JSON 链接路径', en: 'JSON link path' } },
  { key: 'jsonSummaryPath', type: 'text', advanced: true, label: { zh: 'JSON 摘要路径', en: 'JSON summary path' } },
]

export const webKind: SourceKind<WebConfig> = {
  kind: 'web',
  order: 3,
  title: { zh: '网页/地址', en: 'Web page or feed' },
  description: { zh: '定时拉取公开的 RSS/Atom 或 JSON 地址，新条目生成工单；只读，不回帖。',
    en: 'Polls a public RSS/Atom or JSON address and starts work on its new items; read-only, no replies.' },
  schema: ConfigSchema,
  fields,
  health: ['web'],
  // Every item this kind produces is the operator's own direct request, so the Source listens to all of it and observes none.
  scope: () => ({ listened: true, observed: false }),
  // Read-only: there is no reply route, so no Channel, and no Policy part either.
  people: config => config.operator ? [{ id: config.operator }] : [],
}

export const name = 'dsh-superagent-web'
export const inject = ['orchestrator']
/** Registers the kind and starts its loop. `options` carries a stand-in fetch and resolver in tests. */
export function apply(ctx: Context, options: WebTransportOptions = {}): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webKind), 'web: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchWeb(source, controller.signal, options)
      .catch((error: unknown) => { reportFailure(source, webKind.kind, error) })
    return async () => { controller.abort(); await running }
  })
}
