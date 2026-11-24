/** The folder Source on a real Store: drop translation, write-completeness, cursors, outbox replies, and the plugin entry. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { folderKind, folderTrigger, pollFolder, readDrop, sendFolder, watchFolder } from '../src/sources/folder.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

let dir: string, inbox: string, outbox: string
// Windows keeps SQLite files locked until close; close every store before removing its directory, also after a failed assertion.
const stores: Store[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'folder-'))
  inbox = join(dir, 'inbox'); outbox = join(dir, 'outbox')
  mkdirSync(inbox); mkdirSync(outbox)
})
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

const row = () => ({ id: 'ops', inbox, outbox })
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(dir, 'db.sqlite'))
  stores.push(store)
  store.saveSettings(SettingsSchema.parse({
    sources: { folder: { enabled: true, config: { folders: [row()], operator: 'alice', pollSeconds: 2 } } },
    policy: { sources: { folder: { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(folderKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...parts, store, engine, receive, health: board.all, ctx: sourceContextOf(parts, folderKind) }
}
const drop = (name: string, content: string) => writeFileSync(join(inbox, name), content)

describe('translation', () => {
  it('names a stable id, the task thread, the operator as a human direct request, and the outbox address', async () => {
    drop('report.txt', 'numbers')
    const item = await readDrop(inbox, 'report.txt', 'file')
    // A text file's instruction travels in the Trigger, so the assessment needs no shell read (Windows code pages mangle UTF-8).
    expect(item!.text).toContain('numbers')
    expect(item!.text).toContain('New file dropped: report.txt (7 bytes).')
    const trigger = folderTrigger(item!, row(), 'alice')
    expect(trigger.id).toBe(key('folder', 'ops', 'report.txt', item!.hash))
    expect(trigger.threads).toEqual([{ source: 'folder', id: 'ops:report.txt' }])
    expect(trigger.actor).toEqual({ source: 'folder', id: 'alice' })
    expect(trigger).toMatchObject({ human: true, addressed: 'direct', source: 'folder' })
    expect(trigger.channel!.address).toEqual({ row: 'ops', outbox, rel: 'report.txt' })
    expect(trigger.meta).toMatchObject({ row: 'ops', rel: 'report.txt', kind: 'file', files: ['report.txt'] })
  })
  it('reads a task folder by its TASK.md and lists its files; an empty folder is no drop', async () => {
    mkdirSync(join(inbox, 'fix-bug'))
    expect(await readDrop(inbox, 'fix-bug', 'dir')).toBeUndefined()
    writeFileSync(join(inbox, 'fix-bug', 'TASK.md'), 'Fix the login bug.\n')
    writeFileSync(join(inbox, 'fix-bug', 'trace.log'), 'stack')
    const item = await readDrop(inbox, 'fix-bug', 'dir')
    expect(item).toMatchObject({ rel: 'fix-bug', kind: 'task', text: 'Fix the login bug.', files: ['TASK.md', 'trace.log'] })
  })
})

describe('poll rounds', () => {
  it('takes a drop only once two rounds agree it is complete, stores it once, and treats an edit as a new event', async () => {
    const h = host()
    drop('report.txt', 'one')
    expect(await pollFolder(h.ctx, row(), 'alice', new AbortController().signal)).toEqual({ read: 1, received: 0 })
    expect(await pollFolder(h.ctx, row(), 'alice', new AbortController().signal)).toEqual({ read: 1, received: 1 })
    expect(h.receive.mock.results[0]!.value).toBe('stored')
    // An unchanged reread is a duplicate: the seen hash skips it before receive.
    expect(await pollFolder(h.ctx, row(), 'alice', new AbortController().signal)).toEqual({ read: 1, received: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    // An edit changes the fingerprint, then the hash: a new Trigger on the same thread.
    drop('report.txt', 'two — longer')
    await pollFolder(h.ctx, row(), 'alice', new AbortController().signal)
    expect(await pollFolder(h.ctx, row(), 'alice', new AbortController().signal)).toEqual({ read: 1, received: 1 })
    expect(h.receive).toHaveBeenCalledTimes(2)
    const ids = h.receive.mock.calls.map(call => call[0].id)
    expect(new Set(ids).size).toBe(2)
    expect(h.receive.mock.calls[1]![0].threads).toEqual(h.receive.mock.calls[0]![0].threads)
  })
  it('moves the cursor only after the receive, and an allowed operator’s drop is an explicit candidate', async () => {
    const h = host()
    drop('task.txt', 'work')
    const controller = new AbortController()
    await pollFolder(h.ctx, row(), 'alice', controller.signal)
    expect(h.store.get(KV.folder.seen('ops'))).toEqual({})
    await pollFolder(h.ctx, row(), 'alice', controller.signal)
    const trigger = h.receive.mock.calls[0]![0]
    const item = await readDrop(inbox, 'task.txt', 'file')
    expect(h.store.get(KV.folder.seen('ops'))).toEqual({ 'task.txt': item!.hash })
    expect(h.engine.candidate(trigger.id)?.strength).toBe('explicit')
  })
  it('filters a drop whose row the configuration no longer lists', async () => {
    const h = host()
    drop('x.txt', 'data')
    const trigger = folderTrigger((await readDrop(inbox, 'x.txt', 'file'))!, { id: 'gone', inbox, outbox }, 'alice')
    expect(h.engine.receive(trigger)).toBe('filtered')
  })
})

describe('outbox replies', () => {
  const message = (id: string, text: string) => ({ id, channel: { source: 'folder', thread: 'folder:ops:x', address: { row: 'ops', outbox, rel: 'x' } }, text, kind: 'reply' as const, ticketId: 't1' })
  it('writes one file per message id and never duplicates a retry', async () => {
    expect(await sendFolder(message('m1', 'Done.'))).toBe('sent')
    expect(readFileSync(join(outbox, 't1', 'm1.md'), 'utf8')).toBe('Done.')
    expect(await sendFolder(message('m1', 'Different retry text'))).toBe('sent')
    expect(readFileSync(join(outbox, 't1', 'm1.md'), 'utf8')).toBe('Done.')
  })
  it('answers gone when the outbox root no longer exists, and the channel allows only listed rows', async () => {
    rmSync(outbox, { recursive: true, force: true })
    expect(await sendFolder(message('m2', 'Lost'))).toBe('gone')
    const config = { folders: [row()], operator: 'alice', pollSeconds: 2 }
    expect(folderKind.channel!.allowed!({ row: 'ops', outbox }, config)).toBe(true)
    expect(folderKind.channel!.allowed!({ row: 'ops', outbox: join(dir, 'elsewhere') }, config)).toBe(false)
    expect(folderKind.channel!.allowed!({ row: 'other', outbox }, config)).toBe(false)
  })
})

describe('the plugin loop', () => {
  it('waits for setup, reports ready rounds, and stops at once on abort', async () => {
    const waiting = host({ configured: () => false })
    await watchFolder(waiting.ctx, new AbortController().signal)
    expect(waiting.health.folder).toMatchObject({ state: 'paused', code: 'setupPending' })
    const h = host()
    const controller = new AbortController()
    const running = watchFolder(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.health.folder).toMatchObject({ state: 'ready' }))
    controller.abort()
    await running
  })
  // Real timers: node:timers/promises delay is not intercepted by fake timers; three 2-second rounds fit the timeout.
  it('reports an error only after three consecutive failed rounds', async () => {
    const h = host()
    rmSync(inbox, { recursive: true, force: true })
    const controller = new AbortController()
    const running = watchFolder(h.ctx, controller.signal)
    await vi.waitFor(() => expect(h.health.folder).toMatchObject({ state: 'error', code: 'pollFailures' }), { timeout: 12_000 })
    controller.abort()
    await running
  }, 15_000)
})
