/**
 * Remote folder Source: one instance watches one inbox on a remote host over SFTP; a file dropped there becomes a Trigger,
 * replies are written to the instance's remote outbox and handled source files are archived in `<inbox>/.done`. The transport
 * is SFTP over SSH with key-only authentication, a strictly checked host key and batch commands only (see
 * remote-transport.ts): this Source stores no password, reads no private key and never runs a shell on the host. A drop is an
 * explicit request of the operator, exactly as a local folder's drop is.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, reportFailure, sourceContext, type SourceContext } from './host.ts'
import type { FieldSpec, SourceKind } from './kind.ts'
import { ROUND_FILE_LIMIT, archiveFiles, clip, fetchFile, fingerprintProblem, hostProblem, listInbox, localFileProblem,
  putFile, remoteNameProblem, remotePathProblem, targetProblem, usernameProblem, verifyHostKey,
  type RemoteTarget, type TransportOptions } from './remote-transport.ts'

const ConfigSchema = z.object({
  /** Host name or address, without a user or a port (`host`, `port` and `username` say those). */
  host: z.string().trim().default(''),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().default(''),
  /** Absolute local path of the private key handed to `sftp` with `-i`; its content is never read by this plugin. */
  identityFile: z.string().trim().default(''),
  /** Absolute local path of the known_hosts file `sftp` reads with `StrictHostKeyChecking=yes`. */
  knownHosts: z.string().trim().default(''),
  /** Optional `SHA256:...` host key pin compared against the known hosts file before every round. */
  hostKeySha256: z.string().trim().default(''),
  /** Absolute POSIX path of the remote inbox this instance lists. */
  inbox: z.string().trim().default(''),
  /** Absolute POSIX path of the remote outbox replies are written to. */
  outbox: z.string().trim().default(''),
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  maxFileBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
  /** Actor id of the operator who drops the files; empty resolves to the OS user name. The Policy's allowed list names it. */
  operator: z.string().trim().default(''),
}).strict().superRefine((config, ctx) => {
  const issue = (field: string, message: string | undefined): void => {
    if (message) ctx.addIssue({ code: 'custom', path: [field], message })
  }
  if (config.host) issue('host', hostProblem(config.host))
  if (config.username) issue('username', usernameProblem(config.username))
  // Saving checks that the key and known_hosts files exist and are readable, so a connection cannot fail for a typo alone.
  if (config.identityFile) issue('identityFile', localFileProblem(config.identityFile, 'identityFile'))
  if (config.knownHosts) issue('knownHosts', localFileProblem(config.knownHosts, 'knownHosts'))
  if (config.hostKeySha256) issue('hostKeySha256', fingerprintProblem(config.hostKeySha256))
  if (config.inbox) issue('inbox', remotePathProblem(config.inbox))
  if (config.outbox) issue('outbox', remotePathProblem(config.outbox))
})
export type RemoteConfig = z.infer<typeof ConfigSchema>
/** One configured instance's connection and folders, as the polling loop and its Trigger builder read them. */
export interface RemoteInstance {
  id: string; host: string; port: number; username: string; identityFile: string; knownHosts: string; hostKeySha256?: string
  inbox: string; outbox: string; maxFileBytes: number
}
/** One file read from a remote inbox, before it becomes a Trigger. */
export interface RemoteDrop { file: string; bytes: number; hash: string; at: string; text: string; truncated: boolean }
/** Why one inbox entry was left for the operator or a later round. */
export interface RemoteSkip { file: string; size?: number; reason: 'invalid-name' | 'oversized' | 'not-a-file' }
/** What one polling round did: what it read, what it received, what it skipped and what waited for the next round. */
export interface RemoteRound { read: number; received: number; skipped: RemoteSkip[]; deferred: number }

/** The connection one instance's polls and receipts use. */
export function remoteTargetOf(instance: RemoteInstance): RemoteTarget {
  return { host: instance.host, port: instance.port, username: instance.username, identityFile: instance.identityFile,
    knownHosts: instance.knownHosts, ...instance.hostKeySha256 ? { hostKeySha256: instance.hostKeySha256 } : {} }
}
/** The instance a stored configuration describes, as `pollRemote` and the Trigger builder read it. */
export function remoteInstanceOf(id: string, config: RemoteConfig): RemoteInstance {
  return { id, host: config.host, port: config.port, username: config.username, identityFile: config.identityFile,
    knownHosts: config.knownHosts, ...config.hostKeySha256 ? { hostKeySha256: config.hostKeySha256 } : {},
    inbox: config.inbox, outbox: config.outbox, maxFileBytes: config.maxFileBytes }
}

/** How much of a file the Trigger carries; the rest is not available to the worker, as a remote file has no local path. */
const TEXT_CHARS = 8000
const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex').slice(0, 16)
/**
 * The Trigger of one remote drop on `instance`: its source and Thread carry the instance id, so the thread key is
 * `remote:<instance>:<file>`. The operator's drop is an explicit, human, direct request, and the Channel address carries
 * everything a reply needs except any credential: the key's path, never its content.
 */
export function remoteTrigger(drop: RemoteDrop, instance: RemoteInstance, operator: string): Trigger {
  const thread = `${instance.id}:${drop.file}`
  return {
    id: key('remote', instance.id, drop.file, drop.hash),
    source: instance.id,
    threads: [{ source: instance.id, id: drop.file }],
    actor: { source: instance.id, id: operator },
    human: true,
    addressed: 'direct',
    at: drop.at,
    text: drop.text,
    channel: { source: instance.id, thread, address: { row: instance.id, host: instance.host, port: String(instance.port),
      username: instance.username, identityFile: instance.identityFile, knownHosts: instance.knownHosts, outbox: instance.outbox,
      ...instance.hostKeySha256 ? { hostKeySha256: instance.hostKeySha256 } : {} } },
    meta: { row: instance.id, file: drop.file, host: instance.host, bytes: drop.bytes, hash: drop.hash, inbox: instance.inbox,
      outbox: instance.outbox, ...drop.truncated ? { truncated: true } : {} },
  }
}

/** Empties the instance's temporary directory, dropping files a stopped round left behind. */
async function clearTemp(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) await rm(join(directory, entry), { recursive: true, force: true })
}
/** What one round skipped, for the instance's health detail; names are clipped as they come from the remote host. */
function skippedText(skipped: readonly RemoteSkip[]): string {
  return skipped.map(skip => `${clip(skip.file, 60)}${skip.reason === 'oversized' ? ` (${skip.size ?? '?'} bytes over the limit)`
    : skip.reason === 'not-a-file' ? ' (not a file)' : ' (invalid name)'}`).join(', ')
}
/**
 * One polling round: verifies the pinned host key, lists the inbox, downloads each candidate file into
 * `<stateDir>/area/remote.tmp/<instance>/`, turns its text into a Trigger and receives it, then archives every handled file
 * under `.done`. A file is skipped when it is hidden, not a valid name, or larger than `maxFileBytes`; a round processes at
 * most `ROUND_FILE_LIMIT` files, leaving the rest for the next one. A file stays in the inbox when its round fails, and the
 * per-instance seen hashes keep a reread of a file that was already received from becoming a second Trigger.
 */
export async function pollRemote(ctx: SourceContext, instance: RemoteInstance, operator: string, signal: AbortSignal,
  options: TransportOptions = {}): Promise<RemoteRound> {
  const target = remoteTargetOf(instance)
  const inboxProblem = remotePathProblem(instance.inbox), outboxProblem = remotePathProblem(instance.outbox)
  const unusable = targetProblem(target) ?? (inboxProblem ? `inbox: ${inboxProblem}` : undefined)
    ?? (outboxProblem ? `outbox: ${outboxProblem}` : undefined)
  if (unusable) throw new Error(`The remote folder is unusable: ${unusable}`)
  const transport: TransportOptions = { ...options, signal }
  const temporary = join(ctx.deployment.stateDir, 'area', 'remote.tmp', instance.id.replace(/[^A-Za-z0-9._-]+/g, '-'))
  await mkdir(temporary, { recursive: true })
  await clearTemp(temporary)
  await verifyHostKey(target, transport)
  const listing = await listInbox(target, instance.inbox, transport)
  const seen = ctx.state.get(KV.remote.seen(instance.id)) ?? {}
  const nextSeen: Record<string, string> = { ...seen }
  const skipped: RemoteSkip[] = []
  const candidates: string[] = []
  for (const file of [...listing.names].sort()) {
    // `.done` and every other hidden entry are the inbox's own bookkeeping, never a drop.
    if (file.startsWith('.')) continue
    if (remoteNameProblem(file)) { skipped.push({ file, reason: 'invalid-name' }); continue }
    const size = listing.sizes.get(file)
    if (size !== undefined && size > instance.maxFileBytes) { skipped.push({ file, size, reason: 'oversized' }); continue }
    candidates.push(file)
  }
  const deferred = Math.max(0, candidates.length - ROUND_FILE_LIMIT)
  const files = candidates.slice(0, ROUND_FILE_LIMIT)
  const archived: string[] = []
  let received = 0
  for (const file of files) {
    if (signal.aborted) throw new Error('The remote folder Source stopped during the read')
    const local = join(temporary, file)
    try {
      await fetchFile(target, instance.inbox, file, temporary, transport)
      const info = await stat(local)
      if (!info.isFile()) { skipped.push({ file, reason: 'not-a-file' }); continue }
      // `ls -l` may have lied or omitted the size; the downloaded file decides too.
      if (info.size > instance.maxFileBytes) { skipped.push({ file, size: info.size, reason: 'oversized' }); continue }
      const content = await readFile(local)
      const hash = sha(content)
      if (seen[file] === hash) { nextSeen[file] = hash; archived.push(file); continue }
      const text = content.toString('utf8')
      const trigger = remoteTrigger({ file, bytes: info.size, hash, at: new Date().toISOString(),
        text: text.slice(0, TEXT_CHARS), truncated: text.length > TEXT_CHARS }, instance, operator)
      const result = await ctx.receive(trigger)
      nextSeen[file] = hash
      archived.push(file)
      if (result !== 'duplicate') received += 1
      ctx.threads.describe(threadKey(trigger.threads[0]!), { label: file, facts: {
        host: { label: { zh: '主机', en: 'Host' }, value: instance.host },
        size: { label: { zh: '大小', en: 'Size' }, value: `${info.size} bytes` } } })
    } finally {
      await rm(local, { force: true })
    }
  }
  if (archived.length) await archiveFiles(target, instance.inbox, archived, transport)
  ctx.atomic(() => ctx.state.set(KV.remote.seen(instance.id), nextSeen))
  return { read: listing.names.length, received, skipped, deferred }
}

/** One message's receipt file: its message id, which callers generate, checked before it becomes part of a path. */
const MESSAGE_ID = /^[A-Za-z0-9._-]{1,128}$/
/** The connection a stored Channel address names; every field is checked again, as stored data is not trusted. */
function targetOfAddress(address: Record<string, string>): RemoteTarget {
  const port = Number(address.port)
  const target: RemoteTarget = { host: address.host ?? '', port: Number.isInteger(port) ? port : 0,
    username: address.username ?? '', identityFile: address.identityFile ?? '', knownHosts: address.knownHosts ?? '',
    ...address.hostKeySha256 ? { hostKeySha256: address.hostKeySha256 } : {} }
  const problem = targetProblem(target)
  if (problem) throw new Error(`The remote reply target is unusable: ${problem}`)
  return target
}
/**
 * Writes one reply as `<outbox>/<message id>.md` over SFTP. The receipt is a local temporary file only until the transfer
 * ends; a retry of the same message id overwrites the same remote name, so a repeated delivery leaves one file.
 */
export async function sendRemote(message: OutboundMessage, options: TransportOptions = {}): Promise<'sent' | 'gone'> {
  const address = message.channel.address
  const target = targetOfAddress(address)
  const outbox = address.outbox ?? ''
  const problem = remotePathProblem(outbox)
  if (problem) throw new Error(`The remote reply target is unusable: ${problem}`)
  if (!MESSAGE_ID.test(message.id)) throw new Error('The remote reply message id is unusable')
  const file = `${message.id}.md`
  const directory = await mkdtemp(join(tmpdir(), 'dsh-superagentarea-remote-'))
  try {
    await writeFile(join(directory, file), message.text, { mode: 0o600 })
    await verifyHostKey(target, options)
    await putFile(target, outbox, file, directory, options)
    return 'sent'
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const fields: FieldSpec[] = [
  { key: 'host', type: 'text', label: { zh: 'SSH 主机', en: 'SSH host' }, hint: { zh: '主机名或地址，不含用户名与端口', en: 'Host name or address, without the user or the port' } },
  { key: 'port', type: 'number', min: 1, max: 65535, advanced: true, label: { zh: 'SSH 端口', en: 'SSH port' } },
  { key: 'username', type: 'text', label: { zh: 'SSH 用户名', en: 'SSH user' } },
  { key: 'identityFile', type: 'text', label: { zh: '私钥文件', en: 'Private key file' },
    hint: { zh: '本机绝对路径；只交给 sftp 使用，内容不会写入日志或配置', en: 'Absolute local path; handed to sftp alone, its content is never logged or stored' } },
  { key: 'knownHosts', type: 'text', label: { zh: 'known_hosts 文件', en: 'Known hosts file' },
    hint: { zh: '本机绝对路径；里面须是已用带外方式核对过的主机密钥', en: 'Absolute local path of host keys verified out of band' } },
  { key: 'hostKeySha256', type: 'text', advanced: true, label: { zh: '主机密钥指纹（可选）', en: 'Host key fingerprint (optional)' },
    hint: { zh: 'SHA256:…；设置后每轮先比对指纹，不匹配即失败', en: 'SHA256:…; compared before every round, a mismatch fails it' } },
  { key: 'inbox', type: 'text', label: { zh: '远程收件目录', en: 'Remote inbox' },
    hint: { zh: '远端绝对路径，如 /srv/dropbox/inbox；只允许字母、数字、. _ - /', en: 'Absolute path on the host, such as /srv/dropbox/inbox; only letters, digits, . _ - and /' } },
  { key: 'outbox', type: 'text', label: { zh: '远程交付目录', en: 'Remote outbox' },
    hint: { zh: '远端绝对路径；回复写入 <outbox>/<message id>.md', en: 'Absolute path on the host; replies land in <outbox>/<message id>.md' } },
  { key: 'operator', type: 'text', label: { zh: '操作者', en: 'Operator' },
    hint: { zh: '留空用本机用户名；须列入授权名单', en: 'Empty uses the OS user name; list it in the Policy' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  { key: 'maxFileBytes', type: 'number', advanced: true, min: 1024, max: 16 * 1024 * 1024,
    label: { zh: '单文件上限 / 字节', en: 'Largest file / bytes' }, hint: { zh: '超限的文件跳过并在健康详情里说明', en: 'A larger file is skipped and named in the health detail' } },
]
/** The Policy part of a remote folder instance: the operator of its drops, as a local folder's Policy part names its operator. */
const PolicySchema = z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict()

export const remoteKind: SourceKind<RemoteConfig> = {
  kind: 'remote',
  order: 2,
  title: { zh: '远程文件夹', en: 'Remote folder' },
  description: { zh: '通过 SFTP 监听远程主机的收件目录；回复写入远程交付目录，只使用密钥认证。',
    en: 'Watches a remote inbox over SFTP; replies land in its remote outbox, using key authentication only.' },
  schema: ConfigSchema,
  fields,
  health: ['remote'],
  scope({ meta, instance }, config) {
    // A file can only arrive from an inbox this instance names; an incomplete instance listens to nothing. The admission
    // table's row is the instance id, as it is for a local folder.
    if (!config.host || !config.inbox) return { listened: false, reason: 'remote_not_listed' }
    const row = typeof meta.row === 'string' && !meta.row.includes(':') ? meta.row : instance
    return { listened: true, observed: false, row }
  },
  channel: {
    // The instance a Channel resolves to already names the host and its outbox; a reply must go to exactly those.
    allowed: (address, config) => !!config.outbox && address.host === config.host && address.port === String(config.port)
      && address.username === config.username && address.identityFile === config.identityFile
      && address.knownHosts === config.knownHosts && (address.hostKeySha256 ?? '') === config.hostKeySha256
      && address.outbox === config.outbox,
    send: (_host, message) => sendRemote(message),
    // No browser page exists for an SFTP outbox, so the label says where the reply landed and the URL stays empty.
    link: address => ({ url: '', label: { zh: `远程交付 ${address.row}`, en: `Remote outbox ${address.row}` } }),
  },
  // The operator a drop belongs to is a person the instance itself knows, beside the Policy's allowed list.
  people: config => config.operator ? [{ id: config.operator }] : [],
  policy: {
    schema: PolicySchema,
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能投件的操作者', en: 'Operators who may drop work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '操作者', en: 'Operator' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] }],
    explicit: { zh: '操作者把文件放进远程收件目录。', en: 'The operator puts a file into the remote inbox.' },
    // One admission row per instance: the row id the Engine records is the instance id.
    rows: (_stored, instance) => [{ id: instance, label: instance, note: { zh: '投件', en: 'Drops' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
  },
}

/** What one instance's loop has done since startup, for that instance's own health detail. */
interface RemoteLoopRound extends RemoteRound { failures: number; error?: string }
/** The fields an instance needs before it can poll; an enabled instance missing one is reported paused, not failing. */
const REQUIRED_FIELDS = ['host', 'username', 'identityFile', 'knownHosts', 'inbox', 'outbox'] as const
const missingFields = (config: RemoteConfig): string[] => REQUIRED_FIELDS.filter(field => !config[field])
/** Reports one instance's entry: a poll error once it failed three rounds in a row, else what its round read. */
function reportRound(ctx: SourceContext, id: string, round: RemoteLoopRound): void {
  if (round.failures >= 3) {
    ctx.report(id, health('error', 'pollFailures', { count: String(round.failures), error: round.error ?? 'failed' }))
    return
  }
  const skipped = round.skipped.length ? `; skipped ${skippedText(round.skipped)}` : ''
  const deferred = round.deferred ? `; ${round.deferred} more wait for the next round` : ''
  ctx.report(id, { state: 'ready', detail: `${round.read} entries, ${round.received} new drops${skipped}${deferred}`,
    at: new Date().toISOString() })
}
/**
 * The polling loop: waits for setup, follows the switch, polls each configured instance on its own interval, reports each
 * instance's own health, and stops at once on abort. An enabled instance whose connection fields are still empty is paused
 * with what it waits for, rather than counted as a failed poll.
 */
export async function watchRemote(ctx: SourceContext, signal: AbortSignal, options: TransportOptions = {}): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    for (const instance of ctx.instances('remote')) ctx.report(instance.id, health('paused', 'setupPending'))
    return
  }
  const rounds = new Map<string, RemoteLoopRound>()
  const due = new Map<string, number>()
  while (!signal.aborted) {
    const instances = ctx.instances<RemoteConfig>('remote')
    const enabled = instances.filter(instance => instance.enabled)
    const active = enabled.filter(instance => missingFields(instance.config).length === 0)
    if (!enabled.length) for (const instance of instances) ctx.report(instance.id, health('paused', 'sourceOff'))
    else if (!active.length) {
      for (const instance of enabled) ctx.report(instance.id, { state: 'paused',
        detail: `The remote folder is not configured: ${missingFields(instance.config).join(', ')}`, at: new Date().toISOString() })
    } else {
      const now = Date.now()
      for (const instance of active) {
        if ((due.get(instance.id) ?? 0) > now) continue
        due.set(instance.id, now + instance.config.pollSeconds * 1000)
        const round = rounds.get(instance.id) ?? { failures: 0, read: 0, received: 0, skipped: [], deferred: 0 }
        rounds.set(instance.id, round)
        round.read = 0; round.received = 0; round.skipped = []; round.deferred = 0
        try {
          const operator = instance.config.operator || userInfo().username
          const polled = await pollRemote(ctx, remoteInstanceOf(instance.id, instance.config), operator, signal, options)
          round.failures = 0; round.error = undefined
          round.read = polled.read; round.received = polled.received; round.skipped = polled.skipped; round.deferred = polled.deferred
        } catch (error) {
          round.failures += 1; round.error = clip(String(error), 500)
        }
        reportRound(ctx, instance.id, round)
      }
    }
    const seconds = active.length ? Math.min(...active.map(instance => instance.config.pollSeconds)) : 30
    await delay(seconds * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagentarea-remote'
export const inject = ['orchestrator']
/** Registers the kind and starts its loop. `options` carries a stand-in transport in tests; production takes sftp from PATH. */
export function apply(ctx: Context, options: TransportOptions = {}): void {
  ctx.effect(() => ctx.orchestrator.sources.register(remoteKind), 'remote: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, remoteKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchRemote(source, controller.signal, options)
      .catch((error: unknown) => { reportFailure(source, remoteKind.kind, error) })
    return async () => { controller.abort(); await running }
  })
}
