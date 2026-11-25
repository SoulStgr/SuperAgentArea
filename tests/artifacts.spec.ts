/** Artifact delivery and its index: collecting `deliver/` files, promoting them into the workspace, outbox copies, and artifact rows. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artifactRecordId, type ArtifactRecord, type Ticket, type Trigger } from '../src/core/index.ts'
import { artifactNotice, collectDeliverables, conflictName, copyArtifacts, deliverArtifacts, promoteArtifacts, type Artifact }
  from '../src/app/artifacts.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

let dir: string, outbox: string, work: string, target: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-'))
  outbox = join(dir, 'outbox'); work = join(dir, 'work'); target = join(dir, 'area', 'workspace')
  mkdirSync(outbox); mkdirSync(join(work, 'deliver', 'nested'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const write = (name: string, content: string) => writeFileSync(join(work, 'deliver', name), content)

describe('collection', () => {
  it('reads every file under deliver/ recursively, with forward-slash names, sizes and content hashes', async () => {
    expect(await collectDeliverables(join(dir, 'none'))).toEqual([])
    write('report.md', 'done')
    write('nested/data.csv', 'a,b')
    const artifacts = await collectDeliverables(work)
    expect(artifacts.map(artifact => artifact.name)).toEqual(['nested/data.csv', 'report.md'])
    expect(artifacts.find(artifact => artifact.name === 'report.md')).toMatchObject({ size: 4 })
    expect(artifacts[0]!.hash).not.toBe(artifacts[1]!.hash)
    expect(artifacts[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('copies', () => {
  it('copies once and skips a file already present with the same content, rewriting a changed one', async () => {
    write('report.md', 'done')
    const artifacts = await collectDeliverables(work)
    const copied = join(outbox, 't1', 'artifacts')
    expect(await copyArtifacts(work, artifacts, copied)).toEqual(['report.md'])
    expect(readFileSync(join(copied, 'report.md'), 'utf8')).toBe('done')
    expect(await copyArtifacts(work, artifacts, copied)).toEqual([])
    write('report.md', 'done again')
    const changed = await collectDeliverables(work)
    expect(await copyArtifacts(work, changed, copied)).toEqual(['report.md'])
    expect(readFileSync(join(copied, 'report.md'), 'utf8')).toBe('done again')
  })
})

describe('promotion', () => {
  it('writes a Project\'s output directory, leaving a file already there with the same content and renaming one whose name holds other content', async () => {
    write('report.md', 'done')
    const artifacts = await collectDeliverables(work)
    expect(await promoteArtifacts(work, artifacts, target, 'abcdef12')).toEqual(['report.md'])
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done')
    // The same content again is already there.
    expect(await promoteArtifacts(work, artifacts, target, 'abcdef12')).toEqual([])
    // Other content under a name the Project already holds takes the ticket's short id.
    write('report.md', 'changed')
    expect(await promoteArtifacts(work, await collectDeliverables(work), target, '12345678')).toEqual(['report.12345678.md'])
    expect(readFileSync(join(target, 'report.12345678.md'), 'utf8')).toBe('changed')
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done')
  })
  it('puts the conflict suffix before the extension, also for a nested path or a name without one', () => {
    expect(conflictName('report.md', 'abcdef12')).toBe('report.abcdef12.md')
    expect(conflictName('nested/data.csv', 'abcdef12')).toBe('nested/data.abcdef12.csv')
    expect(conflictName('NOTES', 'abcdef12')).toBe('NOTES.abcdef12')
  })
})

describe('delivery', () => {
  const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
    id: 't1', title: 't1', projectId: 'prj_workspace', sourceId: 'folder', origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
    execution: { name: 'fix-t1', directory: work, assignment: '' }, ...overrides } as unknown as Ticket)
  const trigger = (folderOutbox?: string): Trigger => ({ id: 'trig-1', source: 'folder', threads: [], actor: { source: 'folder', id: 'alice' },
    human: true, at: new Date().toISOString(), text: 'x', meta: folderOutbox ? { outbox: folderOutbox } : {} })
  const host = (stored = ticket(), storedTrigger = trigger(outbox)) => {
    const rows: ArtifactRecord[] = []
    return { store: { tickets: { get: () => stored }, triggers: { get: () => storedTrigger },
      artifacts: { add: (artifact: ArtifactRecord) => { rows.push(artifact) } }, set: vi.fn() }, engine: { reply: vi.fn() }, targetRoot: target,
    rows }
  }
  it('records the deliverables, promotes them to the workspace, copies them to the origin outbox, indexes them, and replies', async () => {
    write('report.md', 'done')
    const h = host()
    expect(await deliverArtifacts(h, 't1')).toBe(1)
    expect(h.store.set).toHaveBeenCalledWith(KV.artifacts('t1'), await collectDeliverables(work))
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done')
    expect(readFileSync(join(outbox, 't1', 'artifacts', 'report.md'), 'utf8')).toBe('done')
    expect(h.rows).toEqual([{ id: artifactRecordId('t1', 'report.md'), ticket: 't1', project: 'prj_workspace', source: 'folder', name: 'report.md',
      value: { hash: expect.stringMatching(/^[0-9a-f]{16}$/), size: 4, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        targetRoot: target, deliveredTo: join(outbox, 't1', 'artifacts') }, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }])
    // The reply names the workspace, where people find the deliverables.
    expect(h.engine.reply).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'result', ticketId: 't1',
      text: artifactNotice(await collectDeliverables(work), target) }))
  })
  it('promotes and indexes a file whose name the workspace already holds under the ticket\'s short id, and replaces its row', async () => {
    write('report.md', 'done')
    expect(await deliverArtifacts(host(), 't1')).toBe(1)
    write('report.md', 'done again')
    const again = host()
    expect(await deliverArtifacts(again, 't1')).toBe(1)
    expect(readFileSync(join(target, 'report.t1.md'), 'utf8')).toBe('done again')
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done')
    expect(again.rows[0]!.value.hash).toBe((await collectDeliverables(work))[0]!.hash)
  })
  it('promotes and indexes without an outbox copy when the origin Source names none', async () => {
    write('report.md', 'done')
    const h = host(ticket(), trigger())
    expect(await deliverArtifacts(h, 't1')).toBe(1)
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done')
    expect(existsSync(join(outbox, 't1'))).toBe(false)
    expect(h.rows[0]!.value).toMatchObject({ targetRoot: target })
    expect(h.rows[0]!.value).not.toHaveProperty('deliveredTo')
  })
  it('falls back to the workspace Project and the origin Trigger\'s Source on a ticket stored without them', async () => {
    write('report.md', 'done')
    const h = host(ticket({ projectId: undefined, sourceId: undefined }))
    expect(await deliverArtifacts(h, 't1')).toBe(1)
    expect(h.rows[0]).toMatchObject({ project: 'prj_workspace', source: 'folder' })
  })
  it('does nothing for an unknown ticket, an unset directory, or no deliverables', async () => {
    expect(await deliverArtifacts(host(undefined as unknown as Ticket), 't1')).toBe(0)
    expect(await deliverArtifacts(host(ticket({ execution: undefined })), 't1')).toBe(0)
    const empty = host()
    expect(await deliverArtifacts(empty, 't1')).toBe(0)
    expect(empty.store.set).not.toHaveBeenCalled()
    expect(empty.rows).toEqual([])
    expect(empty.engine.reply).not.toHaveBeenCalled()
  })
  it('names the target directory in the notice', () => {
    const artifacts: Artifact[] = [{ name: 'a.md', hash: '0123456789abcdef', size: 3, at: '2026-11-24T00:00:00.000Z' }]
    expect(artifactNotice(artifacts, '/tmp/out')).toBe('Artifacts delivered:\n- a.md (3 bytes, sha256:0123456789abcdef)\nDelivered to: /tmp/out')
    expect(artifactNotice(artifacts)).not.toContain('Delivered to:')
  })
})

describe('the artifact index', () => {
  const row = (id: string, ticket: string, project: string | undefined, source: string, name: string, at: string, hash = 'hash'): ArtifactRecord => ({
    id, ticket, ...project === undefined ? {} : { project }, source, name, value: { hash, size: 1, at, targetRoot: '/area/workspace' }, at })
  it('stores a delivered file by Ticket, Project, Source and time, and replaces it when the same name is delivered again', () => {
    const store = new Store(join(dir, 'index.sqlite'))
    store.artifacts.add(row('a', 't1', 'prj_workspace', 'folder', 'report.md', '2026-11-24T00:00:00.000Z'))
    store.artifacts.add(row('b', 't1', 'prj_workspace', 'folder', 'notes.txt', '2026-11-24T01:00:00.000Z'))
    store.artifacts.add(row('c', 't2', 'prj_other', 'github', 'report.md', '2026-11-23T00:00:00.000Z'))
    store.artifacts.add(row('d', 't3', undefined, 'folder', 'old.md', '2026-11-22T00:00:00.000Z'))
    expect(store.artifacts.get('b')).toEqual(row('b', 't1', 'prj_workspace', 'folder', 'notes.txt', '2026-11-24T01:00:00.000Z'))
    expect(store.artifacts.get('d')).not.toHaveProperty('project')
    // A Ticket's artifacts come oldest collection first.
    expect(store.artifacts.listByTicket('t1').map(artifact => artifact.id)).toEqual(['a', 'b'])
    // The index reads newest first, filtered by Project, Source or Ticket.
    expect(store.artifacts.list().map(artifact => artifact.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(store.artifacts.list({ project: 'prj_workspace' }).map(artifact => artifact.id)).toEqual(['b', 'a'])
    expect(store.artifacts.list({ source: 'folder' }).map(artifact => artifact.id)).toEqual(['b', 'a', 'd'])
    expect(store.artifacts.list({ ticket: 't2' }).map(artifact => artifact.id)).toEqual(['c'])
    expect(store.artifacts.list({ offset: 1, limit: 2 }).map(artifact => artifact.id)).toEqual(['a', 'c'])
    expect(store.artifacts.list({ project: 'none' })).toEqual([])
    // Re-delivering the same name replaces its hash, size and landing.
    store.artifacts.add({ ...row('a', 't1', 'prj_workspace', 'folder', 'report.md', '2026-11-24T02:00:00.000Z', 'newhash'),
      value: { hash: 'newhash', size: 9, at: '2026-11-24T02:00:00.000Z', targetRoot: '/area/workspace' } })
    expect(store.artifacts.get('a')!.value).toMatchObject({ hash: 'newhash', size: 9 })
    expect(store.artifacts.listByTicket('t1').map(artifact => artifact.id)).toEqual(['b', 'a'])
    store.close()
  })
})
