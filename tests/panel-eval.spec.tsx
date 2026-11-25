// @vitest-environment jsdom
// The latest Decisions page and one Source's Policy: its rules, lists, admission matrix and sync.
import { act } from 'react'
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, at, find, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
/** Opens one instance's Policy and prompts page, which opens at the Policy part. */
const openPolicy = (id = 'feishu') => at({ page: 'governance', id })
const part = (name: string) => find(name, '.dt-governance-parts [role="tab"]')

it('opens the Decisions from the flow line with their reasons, Decisions that start work first, filterable by kind', async () => {
  await mount()
  await click(all('.dt-stat button')[1]!)
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.decisionsTitle)
  // The Decisions page has no tab of its own: it opened from the overview's accepted count.
  expect(document.querySelector('.dt-tabs [aria-selected="true"]')).toBeNull()
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=accept,reopen&window=24h')).toBe(true)
  expect(text()).toContain(zh['reason.explicitRouted'])
  await click(zh.stop)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  expect(text()).toContain('@bot 修一下')
  await click(zh['decision.ignore'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore&window=24h')).toBe(true)
  expect(text()).toContain(zh.none)
  await click(zh.lastDayOnly)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore')).toBe(true)
})

it('says on the Decisions that processing is paused, and offers where to resume it', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  await click(all('.dt-stat button')[1]!)
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(document.querySelector('.dt-tabs [aria-selected="true"]')).toBeNull()
})

it('keeps the installation\'s rules for a Source until the first save, then edits and saves its own rules as policy:<id>', async () => {
  openPolicy('feishu')
  await mount()
  // Until it saves, the instance inherits the installation's rules, and says so.
  expect(text()).toContain(zh.sourceRulesInherited)
  expect(all('.dt-rule [data-disclosure-row]').map(title => title.textContent)).toEqual([expect.stringContaining('文案修改')])
  // A new rule and an edited one are saved as this Source's own rules.
  await click(zh.addRule)
  await type(field<HTMLInputElement>(zh.ruleName), '文档')
  await type(field<HTMLTextAreaElement>(zh.ruleInstruction), '修复失效链接')
  await act(async () => { all('.dt-rule [data-disclosure-row]')[0]!.click() }); await settle()
  await type(all('.dt-rule input')[0] as HTMLInputElement, '文案')
  await click(zh.save)
  expect(server.requests.find(item => item.path === 'settings/policy:feishu')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: expect.objectContaining({ allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team',
      rules: [{ id: 'copy', name: '文案', enabled: true, instruction: '修正明确的文案错误' },
        { id: expect.any(String), name: '文档', enabled: true, instruction: '修复失效链接' }] }) } })
  expect(server.settings.policy.sources.feishu!.rules).toHaveLength(2)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
  // Its own rules are now what applies, so the inheritance hint is gone.
  expect(text()).not.toContain(zh.sourceRulesInherited)
})

it('keeps a Source policy draft across remounts and rebases it onto another save of the same Source', async () => {
  openPolicy('feishu')
  await mount()
  await click([...all('.dt-part button')].find(button => button.textContent === '添加')!)
  const row = all('.dt-part .dt-rows-item').at(-1)!
  await type(row.querySelector<HTMLInputElement>('input[aria-label="open_id"]')!, 'ou_newperson')
  await type(row.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '新人')
  expect(text()).toContain(zh.draftKept)
  await remount()
  expect(text()).toContain(zh.draftRestored)
  expect(all('.dt-part .dt-rows-item')).toHaveLength(2)
  // Another save writes its own rules meanwhile; this draft moves onto that revision and keeps its own sender.
  const stored = server.settings.policy.sources.feishu!
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { ...server.settings.policy.sources,
    feishu: { ...stored, rules: [{ id: 'copy', name: '文案', enabled: true, instruction: '修正明确的文案错误' }] } } } }
  server.revisions['policy:feishu'] = 1
  await click(zh.save)
  expect(text()).toContain(zh.saveMerged)
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' },
    { id: 'ou_newperson', name: '新人' }])
  expect(sessionStorage.getItem('dsh-superagent/draft/master/policy:feishu')).toBeNull()
})

it('keeps each Source\'s Policy in its own identities: people, bots, sync chat and the admission matrix', async () => {
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { kind: 'feishu', enabled: true, config: {
    cli: 'lark-bot', chats: [{ chatId: 'oc_team', listen: 'all' }, { chatId: 'oc_other', listen: 'mentions' }], directMessages: true,
    otherChats: 'none' } } } }
  openPolicy('feishu')
  await mount()
  // The list fields come from the kind, with the Source's own labels.
  const lists = () => all('.dt-part > .dt-field .dt-subhead .dt-field-head').map(head => head.firstChild?.textContent)
  expect(lists()).toEqual(['能发起工作的飞书用户', '消息可以成为候选的机器人'])
  expect(text()).toContain('名单内的人 @ 机器人或私聊机器人，总是明确的请求')
  await click(all('.dt-part > .dt-field')[1]!.querySelectorAll('button')[0]!)
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['不同步', '另一个群', '团队群'])
  // The admission table is this Source's own, row by row.
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  expect(rows).toEqual([['团队群', 3], ['另一个群', 1], ['其他群', 0], ['私聊', 1]])
  const cell = field<HTMLSelectElement>('团队群 · 名单外 · 点名智能体')
  expect(cell.value).toBe('ignore')
  await type(cell, 'explicit')
  expect(document.querySelector('.dt-admission .dt-info-warn')?.getAttribute('aria-label')).toBe(zh.admissionAnyoneWarning)
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.admission).toEqual({ oc_team: { unlistedAddressed: 'explicit' } })
})

it('syncs a Source\'s list from where the Source keeps it, but not while its Policy draft is unsaved', async () => {
  openPolicy('feishu')
  await mount()
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['不同步', '另一个群', '团队群'])
  await click(find('立即同步', '.dt-part button'))
  expect(server.requests.some(request => request.path === 'policy-sync/feishu' && request.method === 'POST')).toBe(true)
  await type(all('.dt-part select')[0] as HTMLSelectElement, 'oc_other')
  const before = server.requests.length
  await click(find('立即同步', '.dt-part button'))
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.syncNeedsSave)
  expect(server.requests.slice(before).some(request => request.path.startsWith('policy-sync'))).toBe(false)
})

it('shows the GitHub admission rows its receiving switches open', async () => {
  server.settings = { ...server.settings, sources: { ...server.settings.sources,
    github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent', observeIssues: true,
      observeComments: true, observeCi: true } } } }
  openPolicy('github')
  await mount()
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  expect(rows).toEqual([['新 Issue', 3], ['新 PR', 1], ['评论', 3], ['默认分支的 CI', 1]])
  // CI has no sender: its one cell is that of a message off the list that does not mention the agent.
  expect(field('默认分支的 CI · 名单外 · 未 @')).toBeTruthy()
})

it('opens a Ticket\'s Policy version in the Routing and Eval settings, where the Policy history lists every save', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click('abcdef12')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.routing'])
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['生成策略版本 abcdef12', '生成策略版本 98765432']) expect(text()).toContain(expected)
})

it('opens a Source\'s Policy and prompts page with only its two parts, each loading what it edits', async () => {
  openPolicy('feishu')
  await mount()
  // The page is not a Source section and has no tab of its own; it names the Source and offers its two parts.
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('飞书')
  expect(document.querySelector('.dt-tabs [aria-selected="true"]')).toBeNull()
  expect(all('.dt-governance-parts [role="tab"]').map(item => item.textContent))
    .toEqual([zh.sourceGovernancePolicy, zh.sourceGovernancePrompts])
  expect(part(zh.sourceGovernancePolicy).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-rule').length).toBe(1)
  expect(server.requests.some(request => request.path === 'sources/feishu/prompts')).toBe(false)
  await click(part(zh.sourceGovernancePrompts))
  expect(part(zh.sourceGovernancePrompts).getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path === 'sources/feishu/prompts')).toBe(true)
  expect(server.requests.some(request => request.path === 'sources/feishu/prompts/preview' && request.method === 'POST')).toBe(false)
  // The route keeps the part, so a reload opens the same one.
  await remount()
  expect(part(zh.sourceGovernancePrompts).getAttribute('aria-selected')).toBe('true')
})
