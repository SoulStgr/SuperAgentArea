/** Artifact delivery: collecting `deliver/` files, idempotent outbox copies, and the ready-report handler. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { artifactNotice, collectDeliverables, copyArtifacts, deliverArtifacts, type Artifact } from '../src/app/artifacts.ts'
import { KV } from '../src/kv.ts'

let dir: string, outbox: string, work: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-'))
  outbox = join(dir, 'outbox'); work = join(dir, 'work')
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
    const target = join(outbox, 't1', 'artifacts')
    expect(await copyArtifacts(work, artifacts, target)).toEqual(['report.md'])
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done')
    expect(await copyArtifacts(work, artifacts, target)).toEqual([])
    write('report.md', 'done again')
    const changed = await collectDeliverables(work)
    expect(await copyArtifacts(work, changed, target)).toEqual(['report.md'])
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('done again')
  })
})

describe('delivery', () => {
  const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
    id: 't1', title: 't1', origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] }, execution: { directory: work },
    ...overrides } as unknown as Ticket)
  const trigger = (outbox?: string): Trigger => ({ id: 'trig-1', source: 'folder', threads: [], actor: { source: 'folder', id: 'alice' },
    human: true, at: new Date().toISOString(), text: 'x', meta: outbox ? { outbox } : {} })
  const host = (stored = ticket(), storedTrigger = trigger(outbox)) => ({
    store: { tickets: { get: () => stored }, triggers: { get: () => storedTrigger }, set: vi.fn() },
    engine: { reply: vi.fn() },
  })
  it('records the deliverables, copies them to the origin outbox, and posts the result reply naming them', async () => {
    write('report.md', 'done')
    const h = host()
    expect(await deliverArtifacts(h, 't1')).toBe(1)
    const artifacts = h.store.set.mock.calls[0]![1] as Artifact[]
    expect(h.store.set).toHaveBeenCalledWith(KV.artifacts('t1'), artifacts)
    expect(existsSync(join(outbox, 't1', 'artifacts', 'report.md'))).toBe(true)
    expect(h.engine.reply).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'result', ticketId: 't1',
      text: expect.stringContaining('report.md') }))
  })
  it('records and replies without a copy when the origin Source names no outbox', async () => {
    write('report.md', 'done')
    const h = host(ticket(), trigger())
    expect(await deliverArtifacts(h, 't1')).toBe(1)
    expect(h.store.set).toHaveBeenCalledTimes(1)
    expect(h.engine.reply).toHaveBeenCalledTimes(1)
    expect(existsSync(join(outbox, 't1'))).toBe(false)
  })
  it('does nothing for an unknown ticket, an unset directory, or no deliverables', async () => {
    const unknown = host(undefined as unknown as Ticket)
    expect(await deliverArtifacts(unknown, 't1')).toBe(0)
    const bare = host(ticket({ execution: undefined }))
    expect(await deliverArtifacts(bare, 't1')).toBe(0)
    const empty = host()
    expect(await deliverArtifacts(empty, 't1')).toBe(0)
    expect(empty.engine.reply).not.toHaveBeenCalled()
  })
  it('names the target directory in the notice', async () => {
    const artifacts: Artifact[] = [{ name: 'a.md', hash: '0123456789abcdef', size: 3, at: '2026-11-24T00:00:00.000Z' }]
    expect(artifactNotice(artifacts, '/tmp/out')).toBe('Artifacts delivered:\n- a.md (3 bytes, sha256:0123456789abcdef)\nDelivered to: /tmp/out')
    expect(artifactNotice(artifacts)).not.toContain('Delivered to:')
  })
})
