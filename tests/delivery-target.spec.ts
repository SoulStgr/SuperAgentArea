/** A monitored Source's Ticket results are delivered to its configured report target, even when it has no reply Channel. */
import { expect, it } from 'vitest'
import { Replies } from '../src/core/replies.ts'
import type { EngineOptions } from '../src/core/part.ts'
import type { ChannelRef, OutboundMessage, Repositories, Ticket } from '../src/core/index.ts'

const at = '2026-09-22T00:00:00Z'
const target: ChannelRef = { source: 'qq', thread: 'qq:group-1',
  address: { row: 'qq', conversationType: 'group', conversationId: 'group-1' } }
const ticket = (channels: ChannelRef[] = []): Ticket => ({
  id: 't1', title: 'report', decisionId: 'd1', channels, undelivered: [], createdAt: at, updatedAt: at, sourceId: 'web',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'web', id: 'site' }, scope: '' },
  origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] }, assignments: [], inputs: [],
  ended: { at, by: 'human', outcome: 'completed' },
})
/** The smallest Engine options `Replies` needs for a result: no threads, no policy and no people. */
function fixture(ticketValue: Ticket, reportTarget: (() => ChannelRef | undefined) | null = () => target):
  { replies: Replies; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = []
  const repo = { tickets: { get: (id: string) => id === ticketValue.id ? ticketValue : undefined, list: () => [ticketValue],
    save: () => undefined }, triggers: { get: () => undefined } } as unknown as Repositories
  const options = { repo, outbox: { send: (message: OutboundMessage) => { sent.push(message) }, status: () => undefined },
    policy: () => ({}), scope: {}, assessor: {}, executor: {},
    ...reportTarget ? { reportTarget } : {} } as unknown as EngineOptions
  return { replies: new Replies(options), sent }
}

it('delivers a result to a monitored Source\'s report target when its own Source has no reply Channel', () => {
  const f = fixture(ticket())
  const reply = f.replies.reply({ purpose: 'result', ticketId: 't1', text: 'Done: report.xlsx',
    attachments: [{ name: 'report.xlsx', path: '/srv/area/report.xlsx' }] })
  expect(reply.status).toBe('pending')
  expect(f.sent).toEqual([{ id: expect.any(String), channel: target, text: 'Done: report.xlsx', kind: 'reply', ticketId: 't1',
    attachments: [{ name: 'report.xlsx', path: '/srv/area/report.xlsx' }] }])
})

it('sends a result once to a target that is also its own Channel', () => {
  const f = fixture(ticket([target]))
  f.replies.reply({ purpose: 'result', ticketId: 't1', text: 'Done', attachments: [] })
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]).toMatchObject({ channel: target, text: 'Done', ticketId: 't1' })
})

it('refuses a result with no reply Channel and no report target', () => {
  const f = fixture(ticket(), null)
  expect(() => f.replies.reply({ purpose: 'result', ticketId: 't1', text: 'Done' })).toThrow('No reply channel')
  expect(f.sent).toEqual([])
})
