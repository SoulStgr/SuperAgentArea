/**
 * Local folder Source: a file or task folder dropped into an inbox becomes a Trigger; replies and artifacts are
 * written to the row's outbox. A task folder carries its instruction in `TASK.md`; a lone file is named by the
 * Trigger and read by the worker through `DSH_SUPERAGENT_FOLDER_TASK`. Drops are explicit requests of the operator.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const ConfigSchema = z.object({
  folders: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    inbox: z.string().min(1),
    outbox: z.string().min(1),
  }).strict()).default([]),
  /** Actor id of the local operator; empty resolves to the OS user name. The Policy's allowed list names it. */
  operator: z.string().trim().default(''),
  pollSeconds: z.number().int().min(2).max(3600).default(10),
}).strict()
export type FolderConfig = z.infer<typeof ConfigSchema>

/** One mature drop: a lone file, or a task folder whose instruction is `TASK.md`. */
export interface FolderDrop {
  /** Path relative to the inbox, with forward slashes; the task key of its Thread. */
  rel: string
  kind: 'file' | 'task'
  /** Content fingerprint; a changed drop is a new event, an unchanged reread is a duplicate. */
  hash: string
  at: string
  text: string
  /** Files of a task folder, relative to it; a lone file lists itself. */
  files: string[]
}

/** The Trigger of one drop; the operator's drop is an explicit, human, direct request. */
export function folderTrigger(drop: FolderDrop, row: { id: string; inbox: string; outbox: string }, operator: string): Trigger {
  const thread = `${row.id}:${drop.rel}`
  return {
    id: key('folder', row.id, drop.rel, drop.hash),
    source: 'folder',
    threads: [{ source: 'folder', id: thread }],
    actor: { source: 'folder', id: operator },
    human: true,
    addressed: 'direct',
    at: drop.at,
    text: drop.text,
    channel: { source: 'folder', thread: `folder:${thread}`, address: { row: row.id, outbox: row.outbox, rel: drop.rel } },
    meta: { row: row.id, rel: drop.rel, kind: drop.kind, files: drop.files, inbox: row.inbox, outbox: row.outbox },
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Names a file whose UTF-8 text carries the instruction, so the Trigger text needs no shell read (Windows code pages mangle it). */
const TEXT_FILE = /\.(?:md|markdown|txt|log|json|ya?ml|csv|ps1|sh)$/i
/** How much of a text file the Trigger carries before the worker reads the rest at `DSH_SUPERAGENT_FOLDER_TASK`. */
const TEXT_CHARS = 8000
/** Reads one inbox entry into a drop, or undefined while it is still being written or holds nothing readable. */
export async function readDrop(inbox: string, name: string, type: 'file' | 'dir'): Promise<FolderDrop | undefined> {
  const path = join(inbox, name)
  if (type === 'file') {
    const content = await readFile(path)
    const info = await stat(path)
    const instruction = TEXT_FILE.test(name) ? content.toString('utf8').trim() : ''
    return { rel: name, kind: 'file', hash: sha(content.toString('binary')), at: info.mtime.toISOString(),
      text: instruction
        ? `New file dropped: ${name} (${content.length} bytes).\n\n${instruction.slice(0, TEXT_CHARS)}${instruction.length > TEXT_CHARS ? '\n\n[Truncated; read the rest at DSH_SUPERAGENT_FOLDER_TASK.]' : ''}`
        : `New file dropped: ${name} (${content.length} bytes). Read it at DSH_SUPERAGENT_FOLDER_TASK and do what its name and content ask.`,
      files: [name] }
  }
  const entries = (await readdir(path, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort()
  if (!entries.length) return undefined
  const instruction = entries.includes('TASK.md') ? await readFile(join(path, 'TASK.md'), 'utf8') : ''
  const sizes = await Promise.all(entries.map(async entry => `${entry}:${(await stat(join(path, entry))).size}`))
  const info = await stat(path)
  return { rel: name, kind: 'task', hash: sha(`${instruction}\n${sizes.join('\n')}`), at: info.mtime.toISOString(),
    text: instruction.trim() || `New task folder dropped: ${name}. Files: ${entries.join(', ')}. Read them under DSH_SUPERAGENT_FOLDER_TASK.`,
    files: entries }
}

/** Writes one reply as a markdown file under `<outbox>/<ticket>/<message id>.md`; the message id is the idempotency key. */
export async function sendFolder(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { outbox, row } = message.channel.address
  if (!outbox || !row) throw new Error('Missing folder reply target')
  const directory = join(outbox, message.ticketId ?? 'unticketed')
  const file = join(directory, `${message.id}.md`)
  try {
    // A recursive mkdir would recreate a deleted outbox; a missing root means delivery is permanently impossible.
    try { await stat(outbox) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error }
    await mkdir(directory, { recursive: true })
    // A retry of the same message id must not duplicate the reply; the first write wins.
    try { await writeFile(file, message.text, { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return 'sent'
  } catch (error) {
    // The outbox root no longer exists: delivery is permanently impossible, as a deleted conversation.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw error
  }
}

export const folderKind: SourceKind<FolderConfig> = {
  kind: 'folder',
  title: { zh: '本地文件夹', en: 'Local folders' },
  description: { zh: '监听下列收件目录的投件；回复与产物写入对应的交付目录。', en: 'Watches these inboxes for drops; replies and artifacts land in each outbox.' },
  schema: ConfigSchema,
  fields: [
    { key: 'folders', type: 'rows', label: { zh: '收件目录', en: 'Inboxes' }, columns: [
      { key: 'id', type: 'text', label: { zh: '标识', en: 'Id' }, pattern: '[a-z0-9-]+' },
      { key: 'inbox', type: 'text', label: { zh: '收件目录', en: 'Inbox' } },
      { key: 'outbox', type: 'text', label: { zh: '交付目录', en: 'Outbox' } },
    ] },
    { key: 'operator', type: 'text', label: { zh: '操作者', en: 'Operator' }, hint: { zh: '留空用本机用户名；须列入授权名单', en: 'Empty uses the OS user name; list it in the Policy' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['folder'],
  scope({ meta }, config) {
    const row = config.folders.find(item => item.id === meta.row)
    if (!row) return { listened: false, reason: 'folder_not_listed' }
    return { listened: true, observed: false, row: row.id }
  },
  channel: {
    allowed: (address, config) => config.folders.some(item => item.id === address.row && item.outbox === address.outbox),
    send: (_host, message) => sendFolder(message),
    link: address => ({ url: '', label: { zh: `文件夹交付 ${address.row}`, en: `Folder outbox ${address.row}` } }),
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能投件的操作者', en: 'Operators who may drop work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '操作者', en: 'Operator' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] }],
    explicit: { zh: '操作者把文件或任务文件夹放进收件目录。', en: 'The operator drops a file or task folder into an inbox.' },
    rows: stored => ConfigSchema.parse(stored).folders.map(row => ({ id: row.id, label: row.id, note: { zh: '投件', en: 'Drops' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } })),
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FOLDER_INBOX', description: { zh: '接下工单的收件目录；工单不是从这个来源来的时为空', en: 'The inbox that started the ticket; empty when the ticket did not start on this Source' } },
      { key: 'DSH_SUPERAGENT_FOLDER_OUTBOX', description: { zh: '工单交付目录；产物与回复写入其下', en: 'The ticket outbox; artifacts and replies land under it' } },
      { key: 'DSH_SUPERAGENT_FOLDER_TASK', description: { zh: '投件文件或任务文件夹的绝对路径', en: 'Absolute path of the dropped file or task folder' } },
    ],
    values: ({ trigger, config }) => {
      if (trigger?.source !== 'folder') return { DSH_SUPERAGENT_FOLDER_INBOX: '', DSH_SUPERAGENT_FOLDER_OUTBOX: '', DSH_SUPERAGENT_FOLDER_TASK: '' }
      const row = config.folders.find(item => item.id === trigger.meta.row)
      return { DSH_SUPERAGENT_FOLDER_INBOX: row?.inbox ?? '', DSH_SUPERAGENT_FOLDER_OUTBOX: row?.outbox ?? '',
        DSH_SUPERAGENT_FOLDER_TASK: row ? join(row.inbox, String(trigger.meta.rel)) : '' }
    },
  },
}

/** Scans one inbox round: mature drops are received once, cursors move only after every covered Trigger is stored. */
export async function pollFolder(ctx: SourceContext, row: { id: string; inbox: string; outbox: string }, operator: string, signal: AbortSignal): Promise<{ read: number; received: number }> {
  const entries = await readdir(row.inbox, { withFileTypes: true })
  const pending = ctx.state.get(KV.folder.pending(row.id)) ?? {}
  const seen = ctx.state.get(KV.folder.seen(row.id)) ?? {}
  const nextPending: Record<string, { size: number; mtime: number }> = {}
  let received = 0
  for (const entry of entries) {
    if (signal.aborted) throw new Error('The folder Source stopped during the read')
    if (!entry.isFile() && !entry.isDirectory()) continue
    const path = join(row.inbox, entry.name)
    const info = await stat(path)
    const fingerprint = { size: info.size, mtime: info.mtimeMs }
    const earlier = pending[entry.name]
    nextPending[entry.name] = fingerprint
    // A drop still being written changes between rounds; take it only once two rounds agree.
    if (!earlier || earlier.size !== fingerprint.size || earlier.mtime !== fingerprint.mtime) continue
    const drop = await readDrop(row.inbox, entry.name, entry.isDirectory() ? 'dir' : 'file').catch(() => undefined)
    if (!drop) continue
    if (seen[drop.rel] === drop.hash) continue
    const trigger = folderTrigger(drop, row, operator)
    await ctx.receive(trigger)
    received += 1
    seen[drop.rel] = drop.hash
    ctx.threads.describe(threadKey(trigger.threads[0]!), { label: drop.rel, facts: { kind: { label: { zh: '类型', en: 'Kind' }, value: drop.kind } } })
  }
  ctx.atomic(() => {
    ctx.state.set(KV.folder.pending(row.id), nextPending)
    ctx.state.set(KV.folder.seen(row.id), seen)
  })
  return { read: entries.length, received }
}

/** The polling loop: waits for setup, follows the switch, reports health, and stops at once on abort. */
export async function watchFolder(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('folder', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<FolderConfig>('folder')
    if (!config) ctx.report('folder', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const operator = config.operator || userInfo().username
        let read = 0, received = 0
        for (const row of config.folders) {
          const round = await pollFolder(ctx, row, operator, signal)
          read += round.read; received += round.received
        }
        failures = 0
        ctx.report('folder', { state: 'ready', detail: `${read} entries, ${received} new drops`, at })
      } catch (error) {
        failures += 1
        if (!signal.aborted && failures >= 3) ctx.report('folder', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await delay((config?.pollSeconds ?? 10) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-folder'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(folderKind), 'folder: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, folderKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchFolder(source, controller.signal)
      .catch((error: unknown) => { source.report('folder', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
