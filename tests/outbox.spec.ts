/** Outbox delivery when processing is paused or a Source kind registers late, and the folder Source's question file. */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { folderKind } from '../src/sources/folder.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('writes a folder Channel\'s Project question as QUESTION.md, and its replies under the ticket', async () => {
  const inbox = join(h.directory, 'inbox'), outbox = join(h.directory, 'outbox')
  mkdirSync(inbox); mkdirSync(outbox)
  h.runtime.sources.register(folderKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    'folder:ops': { kind: 'folder', enabled: true, config: { inbox, outbox } } },
  policy: { ...settings.policy, sources: { ...settings.policy.sources, 'folder:ops': { allowed: [{ id: 'alice' }] } } } })
  const channel = { source: 'folder:ops', thread: 'folder:ops:x', address: { row: 'folder:ops', outbox, rel: 'x' } }
  // The purpose travels through the receipt, so the Channel still knows this message is a question.
  h.runtime.outbox.send({ id: 'q1', channel, text: '这单还没有归属的工作站。请回复：①归到已有工作站：aps。', kind: 'reply', purpose: 'question' })
  h.runtime.outbox.send({ id: 'r1', channel, text: '已改好。', kind: 'reply', ticketId: 't1' })
  // A folder delivers text only: a message's files are ignored, never written beside the reply, and never fail it.
  h.runtime.outbox.send({ id: 'r2', channel, text: '产物在成果目录里。', kind: 'reply', ticketId: 't1',
    attachments: [{ name: 'report.md', path: join(h.directory, 'report.md'), mime: 'text/markdown', bytes: 4 }] })
  await h.runtime.pump()
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('q1'), h.runtime.outbox.status('r1'), h.runtime.outbox.status('r2')])
    .toEqual(['sent', 'sent', 'sent'])
  expect(readFileSync(join(outbox, 'QUESTION.md'), 'utf8')).toContain('# 项目未归属')
  expect(readFileSync(join(outbox, 'QUESTION.md'), 'utf8')).toContain('aps')
  expect(readFileSync(join(outbox, 't1', 'r1.md'), 'utf8')).toBe('已改好。')
  expect(readFileSync(join(outbox, 't1', 'r2.md'), 'utf8')).toBe('产物在成果目录里。')
  expect(readdirSync(join(outbox, 't1')).sort()).toEqual(['r1.md', 'r2.md'])
})

it('keeps a result reply\'s files in its receipt and passes them to the Source; a receipt saved before files existed still reads', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' },
    health: [], schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.sources.register(probe)
  const channel = { source: 'probe', thread: 'probe:1', address: {} }
  const attachments = [{ name: 'report.md', path: join(h.directory, 'report.md'), mime: 'text/markdown', bytes: 4 }]
  h.runtime.outbox.send({ id: 'files', channel, text: 'Artifacts delivered', kind: 'reply', attachments })
  expect(h.runtime.store.receipts.get('files')?.attachments).toEqual(attachments)
  await h.runtime.sendReplies()
  expect(sent.map(message => [message.id, message.attachments])).toEqual([['files', attachments]])
  expect(h.runtime.outbox.status('files')).toBe('sent')
  // A receipt written before `attachments` existed has no such field and is read and reported by its status alone.
  h.runtime.store.db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('old',
    JSON.stringify({ id: 'old', channel, text: 'old', kind: 'reply', status: 'sent' }))
  expect(h.runtime.store.receipts.get('old')?.status).toBe('sent')
  expect(h.runtime.store.receipts.get('old')).not.toHaveProperty('attachments')
  expect(h.runtime.outbox.status('old')).toBe('sent')
})
