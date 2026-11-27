/**
 * Local folder Source: one instance watches one inbox; a file or task folder dropped there becomes a Trigger, and
 * replies and artifacts are written to the instance's outbox. A task folder carries its instruction in `TASK.md`; a
 * lone file is named by the Trigger and read by the worker through `DSH_SUPERAGENTAREA_FOLDER_TASK`. Drops are explicit
 * requests of the operator.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, readsChinese, threadKey, type OutboundMessage, type ProjectHint, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, reportFailure, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const ConfigSchema = z.object({
  inbox: z.string().default(''),
  outbox: z.string().default(''),
  /** Actor id of the local operator; empty resolves to the OS user name. The Policy's allowed list names it. */
  operator: z.string().trim().default(''),
  pollSeconds: z.number().int().min(2).max(3600).default(10),
}).strict()
export type FolderConfig = z.infer<typeof ConfigSchema>
/** One configured instance's folders, as the polling loop and its Trigger builder read them. */
export interface FolderInstance { id: string; inbox: string; outbox: string }

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
  /** What a task folder's `PROJECT.md` first line states about its Project, when the drop has one. */
  project?: ProjectHint
}
/** The first non-empty line of `PROJECT.md`: an absolute path, a repository address, or a Project name. */
function projectHintOf(projectFile: string): ProjectHint | undefined {
  const line = projectFile.split(/\r?\n/).map(text => text.trim()).find(Boolean)
  if (!line) return undefined
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(line)) return { path: line }
  if (/^(?:https|ssh|file):\/\/|^[\w.-]+@[\w.-]+:/.test(line)) return { url: line }
  return { name: line }
}
/** The names a drop itself may call its Project: a `[project]rest` prefix, and the folder's or file's own base name. */
export function projectNamesOf(rel: string, kind: 'file' | 'task'): string[] {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const bracketed = /^[[【]([^\]】]+)[\]】]/.exec(name)?.[1]?.trim()
  const base = kind === 'file' ? name.replace(/\.[^.]+$/, '') : name
  return [...new Set([bracketed, base].filter((value): value is string => !!value))]
}
/** The Project a drop's own name states outright: a `[project]rest` or `【project】rest` prefix, which asks when it fits none. */
export function bracketedProjectName(rel: string): string | undefined {
  return /^[[【]([^\]】]+)[\]】]/.exec(rel.slice(rel.lastIndexOf('/') + 1))?.[1]?.trim() || undefined
}
/** The hints a drop's own name states: a bracketed name states a Project, while its plain base name only helps a match. */
const hintsOfName = (rel: string, kind: 'file' | 'task'): ProjectHint[] => {
  const stated = bracketedProjectName(rel)
  return projectNamesOf(rel, kind).map(name => name === stated ? { name, strong: true } : { name })
}
/**
 * The hints an old Trigger's `meta` states, or those its `rel` alone still states (a Trigger stored before hints existed);
 * a stored `strong` is kept, so a Trigger stored before hints carried their strength keeps its hint weak.
 */
function storedHints(meta: Record<string, unknown>): ProjectHint[] {
  const lines = Array.isArray(meta.projectHints) ? meta.projectHints : []
  const hints = lines.flatMap((line): ProjectHint[] => {
    if (!line || typeof line !== 'object') return []
    const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
    const hint = { ...text((line as Record<string, unknown>).name) ? { name: text((line as Record<string, unknown>).name)! } : {},
      ...text((line as Record<string, unknown>).path) ? { path: text((line as Record<string, unknown>).path)! } : {},
      ...text((line as Record<string, unknown>).url) ? { url: text((line as Record<string, unknown>).url)! } : {},
      ...(line as Record<string, unknown>).strong === true ? { strong: true } : {} }
    return Object.keys(hint).length ? [hint] : []
  })
  if (hints.length) return hints
  return typeof meta.rel === 'string' ? hintsOfName(meta.rel, meta.kind === 'task' ? 'task' : 'file') : []
}
/**
 * The Trigger of one drop on `instance`: its source and Thread carry the instance id, so `folder:ops` and
 * `folder:dev` keep separate Threads and the thread key is the same string the old row-based key had.
 * The operator's drop is an explicit, human, direct request. Its `PROJECT.md` states the Project outright, a bracketed
 * name states one too, and the drop's plain name and path only help a match.
 */
export function folderTrigger(drop: FolderDrop, instance: FolderInstance, operator: string): Trigger {
  const thread = `${instance.id}:${drop.rel}`
  const hints = [...drop.project ? [{ ...drop.project, strong: true }] : [], ...hintsOfName(drop.rel, drop.kind),
    ...instance.inbox ? [{ path: join(instance.inbox, drop.rel) }] : []]
  const projectHints = hints.filter((hint, index) => hints.findIndex(other => JSON.stringify(other) === JSON.stringify(hint)) === index)
  return {
    id: key('folder', instance.id, drop.rel, drop.hash),
    source: instance.id,
    threads: [{ source: instance.id, id: drop.rel }],
    actor: { source: instance.id, id: operator },
    human: true,
    addressed: 'direct',
    at: drop.at,
    text: drop.text,
    channel: { source: instance.id, thread, address: { row: instance.id, outbox: instance.outbox, rel: drop.rel } },
    meta: { row: instance.id, rel: drop.rel, kind: drop.kind, files: drop.files, inbox: instance.inbox, outbox: instance.outbox, projectHints },
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Names a file whose UTF-8 text carries the instruction, so the Trigger text needs no shell read (Windows code pages mangle it). */
const TEXT_FILE = /\.(?:md|markdown|txt|log|json|ya?ml|csv|ps1|sh)$/i
/** How much of a text file the Trigger carries before the worker reads the rest at `DSH_SUPERAGENTAREA_FOLDER_TASK`. */
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
        ? `New file dropped: ${name} (${content.length} bytes).\n\n${instruction.slice(0, TEXT_CHARS)}${instruction.length > TEXT_CHARS ? '\n\n[Truncated; read the rest at DSH_SUPERAGENTAREA_FOLDER_TASK.]' : ''}`
        : `New file dropped: ${name} (${content.length} bytes). Read it at DSH_SUPERAGENTAREA_FOLDER_TASK and do what its name and content ask.`,
      files: [name] }
  }
  const entries = (await readdir(path, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort()
  if (!entries.length) return undefined
  const instruction = entries.includes('TASK.md') ? await readFile(join(path, 'TASK.md'), 'utf8') : ''
  // A task folder's PROJECT.md names the Project its work belongs to; its first line is a name, a path or a repository.
  const project = entries.includes('PROJECT.md') ? projectHintOf(await readFile(join(path, 'PROJECT.md'), 'utf8')) : undefined
  const sizes = await Promise.all(entries.map(async entry => `${entry}:${(await stat(join(path, entry))).size}`))
  const info = await stat(path)
  return { rel: name, kind: 'task', hash: sha(`${instruction}\n${sizes.join('\n')}`), at: info.mtime.toISOString(),
    text: instruction.trim() || `New task folder dropped: ${name}. Files: ${entries.join(', ')}. Read them under DSH_SUPERAGENTAREA_FOLDER_TASK.`,
    files: entries, ...project ? { project } : {} }
}

/**
 * The file a folder Source writes for the host's Project question: what is missing, the candidates and any proposal the
 * question names, and the two ways a person answers it — `PROJECT.md` and a new drop, or the panel's `answer-project`.
 */
function questionFile(message: OutboundMessage): string {
  const chinese = readsChinese(message.text)
  const rel = message.channel.address.rel
  const lines = chinese
    ? ['# 项目未归属', '', ...rel ? [`投件：${rel}`, ''] : [], message.text, '', '## 回答方式', '',
      '1. 在该任务文件夹里写 `PROJECT.md`（首行：工作站名称、本地路径或仓库地址），然后重新投递；内容变化就是新投件，会重新解析归属并直接建单。',
      '2. 或者由人在面板回答这条未归属问题（`POST /triggers/:id/answer-project`）。']
    : ['# No workstation for this request', '', ...rel ? [`Drop: ${rel}`, ''] : [], message.text, '', '## How to answer', '',
      '1. Write `PROJECT.md` in the task folder (first line: a workstation name, a local folder, or a repository address), then drop it again; changed content is a new drop, which resolves the Project and starts the ticket there.',
      '2. Or a person answers this question in the panel (`POST /triggers/:id/answer-project`).']
  return `${lines.join('\n')}\n`
}

/**
 * Writes one reply as a markdown file under `<outbox>/<ticket>/<message id>.md`, once per message id. The host's Project
 * question (`purpose: 'question'`) is written to `<outbox>/QUESTION.md` instead, replacing the question it asked before,
 * since its answer is the operator's next drop rather than a reply in a ticket's folder.
 */
export async function sendFolder(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { outbox, row } = message.channel.address
  if (!outbox || !row) throw new Error('Missing folder reply target')
  const question = message.purpose === 'question'
  const directory = question ? outbox : join(outbox, message.ticketId ?? 'unticketed')
  const file = join(directory, question ? 'QUESTION.md' : `${message.id}.md`)
  try {
    // A recursive mkdir would recreate a deleted outbox; a missing root means delivery is permanently impossible.
    try { await stat(outbox) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error }
    await mkdir(directory, { recursive: true })
    // A retry of the same message id must not duplicate the reply; the first write wins, while a question is rewritten.
    if (question) await writeFile(file, questionFile(message))
    else {
      try { await writeFile(file, message.text, { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    return 'sent'
  } catch (error) {
    // The outbox root no longer exists: delivery is permanently impossible, as a deleted conversation.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw error
  }
}

export const folderKind: SourceKind<FolderConfig> = {
  kind: 'folder',
  order: 1,
  title: { zh: '本地文件夹', en: 'Local folder' },
  description: { zh: '监听收件目录的投件；回复与产物写入交付目录。', en: 'Watches an inbox for drops; replies and artifacts land in its outbox.' },
  schema: ConfigSchema,
  fields: [
    { key: 'inbox', type: 'text', label: { zh: '收件目录', en: 'Inbox' } },
    { key: 'outbox', type: 'text', label: { zh: '交付目录', en: 'Outbox' } },
    { key: 'operator', type: 'text', label: { zh: '操作者', en: 'Operator' }, hint: { zh: '留空用本机用户名；须列入授权名单', en: 'Empty uses the OS user name; list it in the Policy' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['folder'],
  scope({ meta, instance }, config) {
    // An old Trigger keeps its row id in `meta.row`; a new one carries the instance id.
    if (!config.inbox) return { listened: false, reason: 'folder_not_listed' }
    const row = typeof meta.row === 'string' && !meta.row.includes(':') ? meta.row : instance
    return { listened: true, observed: false, row }
  },
  channel: {
    // The instance a Channel resolves to already names the row; its outbox must be the one the drop came from.
    allowed: (address, config) => !!config.outbox && config.outbox === address.outbox,
    send: (_host, message) => sendFolder(message),
    link: address => ({ url: '', label: { zh: `文件夹交付 ${address.row}`, en: `Folder outbox ${address.row}` } }),
    // A folder writes plain names: there is no chat to @, and the operator reads the file.
    mention: person => person.name || person.id,
  },
  // The operator a drop belongs to is a person the instance itself knows, beside the Policy's allowed list.
  people: config => config.operator ? [{ id: config.operator }] : [],
  projectHints: trigger => storedHints(trigger.meta),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能投件的操作者', en: 'Operators who may drop work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '操作者', en: 'Operator' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] }],
    explicit: { zh: '操作者把文件或任务文件夹放进收件目录。', en: 'The operator drops a file or task folder into an inbox.' },
    // One admission row per instance: the row id the Engine records is the instance id.
    rows: (_stored, instance) => [{ id: instance, label: instance, note: { zh: '投件', en: 'Drops' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENTAREA_FOLDER_INBOX', description: { zh: '接下工单的收件目录；工单不是从这个来源来的时为空', en: 'The inbox that started the ticket; empty when the ticket did not start on this Source' } },
      { key: 'DSH_SUPERAGENTAREA_FOLDER_OUTBOX', description: { zh: '工单交付目录；产物与回复写入其下', en: 'The ticket outbox; artifacts and replies land under it' } },
      { key: 'DSH_SUPERAGENTAREA_FOLDER_TASK', description: { zh: '投件文件或任务文件夹的绝对路径', en: 'Absolute path of the dropped file or task folder' } },
    ],
    values: ({ trigger, config }) => {
      // Only the instance that received the Trigger fills these; the registry narrows a Trigger to its own instance.
      if (!trigger || !(trigger.source === 'folder' || trigger.source.startsWith('folder:'))) {
        return { DSH_SUPERAGENTAREA_FOLDER_INBOX: '', DSH_SUPERAGENTAREA_FOLDER_OUTBOX: '', DSH_SUPERAGENTAREA_FOLDER_TASK: '' }
      }
      return { DSH_SUPERAGENTAREA_FOLDER_INBOX: config.inbox, DSH_SUPERAGENTAREA_FOLDER_OUTBOX: config.outbox,
        DSH_SUPERAGENTAREA_FOLDER_TASK: config.inbox ? join(config.inbox, String(trigger.meta.rel)) : '' }
    },
  },
}

/** Scans one instance's inbox round: mature drops are received once, cursors move only after every covered Trigger is stored. */
export async function pollFolder(ctx: SourceContext, instance: FolderInstance, operator: string,
  signal: AbortSignal): Promise<{ read: number; received: number }> {
  const entries = await readdir(instance.inbox, { withFileTypes: true })
  const pending = ctx.state.get(KV.folder.pending(instance.id)) ?? {}
  const seen = ctx.state.get(KV.folder.seen(instance.id)) ?? {}
  const nextPending: Record<string, { size: number; mtime: number }> = {}
  let received = 0
  for (const entry of entries) {
    if (signal.aborted) throw new Error('The folder Source stopped during the read')
    if (!entry.isFile() && !entry.isDirectory()) continue
    const path = join(instance.inbox, entry.name)
    const info = await stat(path)
    const fingerprint = { size: info.size, mtime: info.mtimeMs }
    const earlier = pending[entry.name]
    nextPending[entry.name] = fingerprint
    // A drop still being written changes between rounds; take it only once two rounds agree.
    if (!earlier || earlier.size !== fingerprint.size || earlier.mtime !== fingerprint.mtime) continue
    const drop = await readDrop(instance.inbox, entry.name, entry.isDirectory() ? 'dir' : 'file').catch(() => undefined)
    if (!drop) continue
    if (seen[drop.rel] === drop.hash) continue
    const trigger = folderTrigger(drop, instance, operator)
    await ctx.receive(trigger)
    received += 1
    seen[drop.rel] = drop.hash
    ctx.threads.describe(threadKey(trigger.threads[0]!), { label: drop.rel, facts: { kind: { label: { zh: '类型', en: 'Kind' }, value: drop.kind } } })
  }
  ctx.atomic(() => {
    ctx.state.set(KV.folder.pending(instance.id), nextPending)
    ctx.state.set(KV.folder.seen(instance.id), seen)
  })
  return { read: entries.length, received }
}

/** What one instance's loop has done since startup, for that instance's own health detail. */
interface FolderRound { failures: number; read: number; received: number; error?: string }
/** Reports one instance's entry: a poll error once it failed three rounds in a row, else what its round read. */
function reportRound(ctx: SourceContext, id: string, round: FolderRound): void {
  if (round.failures >= 3) {
    ctx.report(id, health('error', 'pollFailures', { count: String(round.failures), error: round.error ?? 'failed' }))
    return
  }
  ctx.report(id, { state: 'ready', detail: `${round.read} entries, ${round.received} new drops`, at: new Date().toISOString() })
}

/**
 * The polling loop: waits for setup, follows the switch, polls each enabled instance on its own interval, reports each
 * instance's own health, and stops at once on abort.
 */
export async function watchFolder(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    for (const instance of ctx.instances('folder')) ctx.report(instance.id, health('paused', 'setupPending'))
    return
  }
  const rounds = new Map<string, FolderRound>()
  const due = new Map<string, number>()
  while (!signal.aborted) {
    const instances = ctx.instances<FolderConfig>('folder')
    const enabled = instances.filter(instance => instance.enabled)
    const active = enabled.filter(instance => instance.config.inbox)
    if (!enabled.length) for (const instance of instances) ctx.report(instance.id, health('paused', 'sourceOff'))
    else if (!active.length) {
      // An instance with no inbox configured yet runs nothing; the Source is on, so it is not reported off.
      for (const instance of enabled) ctx.report(instance.id, { state: 'ready', detail: '0 entries, 0 new drops', at: new Date().toISOString() })
    } else {
      const now = Date.now()
      for (const instance of active) {
        if ((due.get(instance.id) ?? 0) > now) continue
        due.set(instance.id, now + instance.config.pollSeconds * 1000)
        const round = rounds.get(instance.id) ?? { failures: 0, read: 0, received: 0 }
        rounds.set(instance.id, round)
        round.read = 0; round.received = 0
        try {
          const operator = instance.config.operator || userInfo().username
          const polled = await pollFolder(ctx, { id: instance.id, inbox: instance.config.inbox, outbox: instance.config.outbox },
            operator, signal)
          round.failures = 0; round.error = undefined; round.read = polled.read; round.received = polled.received
        } catch (error) {
          round.failures += 1; round.error = String(error)
        }
        reportRound(ctx, instance.id, round)
      }
    }
    const seconds = active.length ? Math.min(...active.map(instance => instance.config.pollSeconds)) : 10
    await delay(seconds * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagentarea-folder'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(folderKind), 'folder: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, folderKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchFolder(source, controller.signal)
      .catch((error: unknown) => { reportFailure(source, folderKind.kind, error) })
    return async () => { controller.abort(); await running }
  })
}
