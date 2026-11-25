/**
 * Project ownership in the whole application: an acceptance whose Project is not registered is refused with `needsProject`
 * and asked back into its conversation, the panel's answer or a person's confirmation creates the Project, the ticket card
 * and results name the reporter and the people a ticket mentions, and unknown people are dropped.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChannelRef, PersonRef, Ticket } from '../src/core/index.ts'
import { key } from '../src/core/index.ts'
import { ticketCardNotice } from '../src/app/announcements.ts'
import { assessmentOutcome } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { folderKind } from '../src/sources/folder.ts'
import { githubKind } from '../src/sources/github.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Registers a station Project as a panel answer would, returning its id. */
function station(name = 'aps'): string {
  return h.runtime.projects.create({ name, location: { type: 'managed' }, specifiedBy: { source: 'panel', id: 'panel' } }).id
}
/** Makes the Feishu instance default to `id`, as a person's panel answer would for later Triggers too. */
function defaultProject(id: string): void {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...settings.sources.feishu!, defaultProjectId: id } } })
}
/** An acceptance the main Session records for `id`, with every enabled rule judged (`copy` and `visual` by default). */
const decision = (id: string, extra: Record<string, unknown> = {}) => ({ trigger_id: id, decision: 'accept', title: '文案修订',
  worktree_name: 'copy-fix', scope: '改副标题', reason: 'copy change', intent_evidence: 'quoted', acknowledgement: '收到，改好了。',
  rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
  direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'names the text' },
  ...extra })
const decide = async (id: string, extra: Record<string, unknown> = {}) => {
  const result = await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', decision(id, extra))
  // The test host's tool caller does not wait for the pass the decision requests, which accepts and launches the worker.
  await h.runtime.idle()
  return result
}
const evaluate = async (id: string) => await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: id })
/** The Source status view the panel reads, as the API returns it. */
const sourceStatus = async () => (await h.api('GET', 'sources')).body as unknown as { id: string; pendingProjects: { triggerId: string }[] }[]
const larkText = () => vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args.join(' ')).join('\n')

it('refuses an acceptance whose Project is not registered, asks its conversation, and creates the ticket after the panel answers', async () => {
  const project = station()
  const trigger = feishu('30', '把副标题改成“浏览网页”', { mentions: [] })
  h.runtime.receive(trigger); await h.runtime.idle()
  // The assessment sees the candidates a person may choose, and no resolved Project.
  expect(await evaluate(trigger.id)).toMatchObject({ project: { candidates: [{ id: project, name: 'aps', kind: 'station' }] } })
  const refused = await decide(trigger.id)
  expect(refused).toMatchObject({ decision: 'stop', reason: expect.stringContaining('Project is not registered') })
  expect(h.runtime.store.tickets.list()).toEqual([])
  const recorded = h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_30`).at(-1)!
  expect(recorded).toMatchObject({ kind: 'stop' })
  expect(recorded.reason).toContainEqual(expect.objectContaining({ code: 'needsProject',
    values: expect.objectContaining({ candidates: [expect.objectContaining({ id: project, name: 'aps' })] }) }))
  // One question for the Trigger, queued idempotently and naming the person and a candidate.
  const question = key('question', trigger.id)
  expect(h.runtime.store.replyStatus(question)).toBeDefined()
  expect(h.runtime.engine.reply({ purpose: 'question', triggerId: trigger.id, text: 'again' })).toMatchObject({ id: question, reused: true })
  await h.runtime.sendReplies()
  expect(larkText()).toContain('这单还没有归属的工作站')
  expect(larkText()).toContain('aps')
  expect(larkText()).toContain('<at id=ou_alice></at>')
  // The Source status offers the unanswered question to the panel.
  expect((await sourceStatus()).find(item => item.id === 'feishu')!.pendingProjects).toContainEqual(expect.objectContaining({ triggerId: trigger.id }))
  // The panel answers with the existing station; the fresh Eval resolves it and the acceptance creates the ticket there.
  expect((await h.api('POST', `triggers/${trigger.id}/answer-project`, { projectId: project })).body).toEqual({ resolved: project })
  await h.runtime.idle()
  await evaluate(trigger.id)
  const accepted = await decide(trigger.id)
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket).toMatchObject({ projectId: project, sourceId: 'feishu' })
  expect(ticket.execution!.directory).toBe(join(h.directory, 'area', 'aps.work', ticket.execution!.name))
  expect((await sourceStatus())).toContainEqual(expect.objectContaining({ id: 'feishu', pendingProjects: [] }))
  // An answer to a Trigger that is not waiting is refused, as is an unknown Project.
  const quiet = feishu('31', '谢谢', { mentions: [] })
  h.runtime.receive(quiet); await h.runtime.idle()
  expect((await h.api('POST', `triggers/${quiet.id}/answer-project`, { projectId: project })).status).toBe(400)
  expect((await h.api('POST', 'triggers/unknown/answer-project', { projectId: project })).status).toBe(404)
})

it('creates the station an assessment proposed only after a person confirms it in the conversation', async () => {
  const trigger = feishu('40', '把导出也做一下', { mentions: [] })
  h.runtime.receive(trigger); await h.runtime.idle()
  await evaluate(trigger.id)
  const path = join(h.directory, 'work', 'aps')
  expect(await decide(trigger.id, { decision: 'needsProject', proposal: { name: 'aps 填报', address: path } }))
    .toMatchObject({ decision: 'stop' })
  // Nothing is created on the assessment's word alone; the proposal waits in the Decision.
  expect(h.runtime.store.projects.list().filter(project => project.value.kind !== 'workspace')).toEqual([])
  expect(existsSync(path)).toBe(false)
  const recorded = h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_40`).at(-1)!
  expect(recorded.reason[0]!.values).toMatchObject({ proposal: { name: 'aps 填报', location: { type: 'folder', path } } })
  // The person confirms in the same conversation: the explicit candidate's card carries the pending proposal, and its accept
  // creates the station before the ticket.
  const confirm = feishu('41', '确认这个建议', { root_id: 'om_40' })
  h.runtime.receive(confirm); await h.runtime.idle()
  const card = h.relays(h.runtime.masterId).find(item => item.kind === 'candidate' && item.trigger_id === confirm.id)!
  expect(card).toMatchObject({ pending_project: { trigger_id: trigger.id, proposal: { name: 'aps 填报' } } })
  const routed = await h.route({ kind: 'accept', trigger_id: confirm.id, title: '导出', worktree_name: 'export-files',
    acknowledgement: '好的。', confirm_proposal: true })
  const ticket = h.runtime.store.tickets.get((routed.ticket as { ticket_id: string }).ticket_id)!
  const created = h.runtime.store.projects.get(ticket.projectId!)!
  expect(created.value).toMatchObject({ name: 'aps 填报', kind: 'station', location: { type: 'folder', path },
    specifiedBy: { source: 'orchestrator', id: 'orchestrator' }, confirmedBy: { source: 'feishu', id: MEMBER } })
  expect(existsSync(path)).toBe(true)
  // A confirmation with no waiting proposal creates nothing and leaves the request in the workspace.
  const late = feishu('42', '确认', { root_id: 'om_41' })
  h.runtime.receive(late); await h.runtime.idle()
  const plain = await h.route({ kind: 'accept', trigger_id: late.id, title: '其他', worktree_name: 'other-change', acknowledgement: '好。' })
  expect(h.runtime.store.tickets.get((plain.ticket as { ticket_id: string }).ticket_id)!.projectId).toBe('prj_workspace')
})

it('keeps the people the Source knows as reporter and mentions, and drops anyone else with a reason', async () => {
  const project = station()
  defaultProject(project)
  // Bob is on the Feishu list, so the assessment may report work for him and mention him; the ghost is nobody there.
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    feishu: { ...settings.policy.sources.feishu!, allowed: [...settings.policy.sources.feishu!.allowed, { id: 'ou_bob', name: 'Bob' }] } } } })
  const trigger = feishu('50', '这个文案改一下，小C 到时候看看', { mentions: [] })
  h.runtime.receive(trigger); await h.runtime.idle()
  await evaluate(trigger.id)
  expect(await decide(trigger.id, { reporter: 'ou_bob', mentions: ['ou_bob', 'ou_ghost'] })).toMatchObject({ decision: 'accept' })
  const ticket = h.runtime.store.tickets.list().at(-1)!
  expect(ticket.assignments.map(assignment => assignment.state)).toEqual(['running'])
  expect(ticket).toMatchObject({ projectId: project, reporter: { source: 'feishu', id: 'ou_bob', name: 'Bob' },
    mentions: [{ source: 'feishu', id: 'ou_bob', name: 'Bob' }] })
  const recorded = h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_50`).at(-1)!
  expect(recorded.reason).toContainEqual(expect.objectContaining({ code: 'unknownMention', values: { people: 'ou_ghost' } }))
  // The ticket card and a result name both people in Feishu's syntax.
  await h.runtime.sendReplies()
  expect(larkText()).toContain('工单卡')
  expect(larkText()).toContain('汇报人：Bob')
  expect(larkText()).toContain('<at id=ou_bob></at>')
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'ready', summary: '改好了' })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '改好了，待 review。' })
  expect(larkText()).toContain('改好了，待 review。')
  expect(larkText()).toContain('<at id=ou_bob></at>')
})

it('renders the ticket card with each Source\'s mention syntax: GitHub login, Feishu tag, folder name', () => {
  const kinds = { github: githubKind, feishu: feishuKind, folder: folderKind }
  const channelOf = (source: 'github' | 'feishu' | 'folder'): ChannelRef => source === 'github'
    ? { source: 'github', thread: 'github:1', address: { number: '1' } }
    : source === 'feishu' ? { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }
    : { source: 'folder:ops', thread: 'folder:ops:rel', address: { row: 'folder:ops', outbox: join(h.directory, 'outbox') } }
  const hostFor = (source: 'github' | 'feishu' | 'folder') => ({ store: { projects: { get: () => ({ value: { name: 'aps', kind: 'station' } }) },
    triggers: { get: () => undefined } },
    sources: { mention: (person: PersonRef) => kinds[source].channel!.mention!(person) },
    links: () => ({ url: 'https://example.test/1', label: { zh: '链接', en: 'Link' } }) })
  const ticketOf = (channel: ChannelRef): Ticket => ({ id: 't1', title: '导出', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'followup' }, actor: { source: channel.source, id: 'alice' }, scope: 's' }, channels: [channel], assignments: [],
    inputs: [], undelivered: [], createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z', origin: { triggerId: 'x', triggerIds: ['x'] },
    projectId: 'prj_aps', reporter: { source: channel.source, id: 'alice', name: 'Alice' },
    mentions: [{ source: channel.source, id: 'bob', name: 'Bob' }] })
  const card = (source: 'github' | 'feishu' | 'folder') => ticketCardNotice(hostFor(source), ticketOf(channelOf(source)), '改一下')
  // A GitHub card names people by login, a Feishu card by its own tag, and a folder card by plain name.
  expect(card('github')!.text).toBe(['工单卡：导出', '编号：t1', '项目：aps', '汇报人：Alice', '阶段：排队中', '链接：https://example.test/1', '',
    '@alice @bob'].join('\n'))
  expect(card('feishu')!.text).toContain('<at id=alice></at> <at id=bob></at>')
  expect(card('folder')!.text).toContain('Alice Bob')
  expect(card('folder')!.text).not.toContain('<at')
  expect(card('github')!.id).toBe(key('ticket-card', 't1'))
})

it('maps an assessment\'s Project refusal and its people into the outcome the Engine records', () => {
  const settings = h.runtime.store.settings()
  const judged = [{ rule_id: 'copy', matched: true, reason: 'copy' }, { rule_id: 'visual', matched: false, reason: 'no' }]
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'e' }
  const base = { rule_assessments: judged, direction, title: 't', scope: 's', reason: 'r', worktree_name: 'w', intent_evidence: 'e' }
  // A refused Project keeps its proposal's address as a location, and only a person's confirmation turns it into a Project.
  expect(assessmentOutcome({ ...base, decision: 'needsProject', proposal: { name: 'aps', address: '/srv/aps' } }, settings, 'explicit'))
    .toMatchObject({ kind: 'needsProject', proposal: { name: 'aps', location: { type: 'folder', path: '/srv/aps' } } })
  expect(assessmentOutcome({ ...base, decision: 'needsProject', proposal: { name: 'aps', address: 'git@github.com:acme/aps.git' } }, settings, 'explicit'))
    .toMatchObject({ kind: 'needsProject', proposal: { location: { type: 'repo', url: 'git@github.com:acme/aps.git' } } })
  expect(assessmentOutcome({ ...base, decision: 'needsProject' }, settings, 'explicit')).not.toHaveProperty('proposal')
  // People are Source identities: strings become PersonRefs of that Source only when the host names it.
  expect(assessmentOutcome({ ...base, decision: 'accept', reporter: 'ou_bob', mentions: ['ou_bob', 'ou_ghost'] }, settings, 'explicit', 'feishu'))
    .toMatchObject({ kind: 'accept', reporter: { source: 'feishu', id: 'ou_bob' },
      mentions: [{ source: 'feishu', id: 'ou_bob' }, { source: 'feishu', id: 'ou_ghost' }] })
  expect(assessmentOutcome({ ...base, decision: 'accept', reporter: 'ou_bob' }, settings, 'explicit')).not.toHaveProperty('reporter')
})
