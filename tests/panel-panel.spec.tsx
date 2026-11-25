// @vitest-environment jsdom
// Panel search, glossary, route persistence, and host-down fallback.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, at, click, type, text, field, find, tab } from './fixtures/panel.tsx'
import { server, found } from './fixtures/panel-server.ts'

usePanel()
it('states why a filtered search result has no Thread instead of opening an empty one', async () => {
  server.search = { items: [found('e9', '2026-09-20T00:00:00Z', { source: 'github', actor: { source: 'github', id: 'someone' },
    preview: 'issue text', threads: ['github:7'],
    filtered: 'source_disabled' })], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'issue')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('被来源过滤：来源已停用')
  expect(all('.dt-search-results button').some(button => button.textContent === 'issue text')).toBe(false)
})

it('opens a search result older than the newest page around its Trigger', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z')], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'message')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('找到 0 个工单、0 个线程、1 条触发')
  await click(all('.dt-search-results button').find(button => button.textContent === 'message e1')!)
  expect(server.requests.some(request => request.path.includes('around=e1'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e1')
})

it('explains what can be searched when nothing matches', async () => {
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'nothing')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('没有找到。可以输入触发文字')
})

it('returns to the exact page after a remount of the main panel', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('keeps six tabs, opens the Prompts and Policy pages from them, and reaches Settings through the header gear', async () => {
  await mount()
  expect(all('.dt-tabs [role="tab"]').map(item => item.textContent)).toEqual(['概览', '工单源', '工作站', '产物', '提示词', '策略'])
  // The Trigger, Eval, Execution and Settings tabs are gone; their pages are reached from links or the gear.
  expect(all('.dt-tabs [role="tab"]').map(item => item.getAttribute('id'))).toEqual(['dt-tab-overview', 'dt-tab-source', 'dt-tab-workstations',
    'dt-tab-artifacts', 'dt-tab-prompts', 'dt-tab-policy'])
  await click(tab(zh['tab.prompts']))
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.prompts'])
  await click(tab(zh['tab.policy']))
  expect(all('.dt-policy-segments [role="tab"]').map(item => item.textContent)).toEqual([zh['policySegment.rules'], zh['policySegment.eval'],
    zh['policySegment.decisions']])
  // The gear opens Settings with only the Executor/environment and Deployment groups.
  const gear = find(zh['tab.settings'], '.dt-head button')
  await click(gear)
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual([zh['settingsGroup.execution'], zh['settingsGroup.deployment']])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.execution'])
})

it('reopens the last Settings group from the gear, and falls back to Execution for a group that moved or no longer exists', async () => {
  await mount()
  await click(find(zh['tab.settings'], '.dt-head button'))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  await click(tab(zh['tab.overview']))
  await click(find(zh['tab.settings'], '.dt-head button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  // A route saved under a removed group opens Execution settings.
  at({ page: 'settings', query: { group: 'prompts' } })
  await remount()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.execution'])
})

it('restores the removed tabs\' pages from an old route, and the Policy page for an old Eval route', async () => {
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await mount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('这个文案好奇怪')
  expect(document.querySelector('.dt-tabs [aria-selected="true"]')).toBeNull()
  at({ page: 'eval', query: { filter: 'stop', window: '24h' } })
  await remount()
  expect(tab(zh['tab.policy']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-policy-segments [aria-selected="true"]')?.textContent).toBe(zh['policySegment.decisions'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  at({ page: 'settings', query: { group: 'source' } })
  await remount()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.execution'])
})

it('navigates to a workstation page from its card section, and remembers the section', async () => {
  await mount()
  await click(zh['tab.workstations'])
  const aps = all('.dt-project-card').find(card => card.querySelector('.dt-project-title')?.textContent === 'aps')!
  const sections = [...aps.querySelectorAll<HTMLElement>('.dt-project-segments button')]
  expect(sections.map(button => button.textContent)).toEqual(['来源', '触发', '评估', '执行', '设置', 'agent'])
  await click(sections[3]!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps')
  expect(document.querySelector('.dt-main [role="tablist"] [role="tab"][aria-selected="true"]')?.textContent).toBe('执行 1')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps')
  expect(document.querySelector('.dt-main [role="tablist"] [role="tab"][aria-selected="true"]')?.textContent).toBe('执行 1')
})

it('shows domain terms in the interface language only and lists both languages in the (?) glossary', async () => {
  await mount(en)
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Overview', 'Sources', 'Workstations', 'Artifacts', 'Prompts', 'Policy & Eval'])
  await click('Glossary')
  const dialog = document.querySelector('[role="dialog"]')!
  const row = [...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Ticket'))!
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Ticket', '工单', 'An authorized unit of work'])
  expect(dialog.textContent).toContain('Accept 接单')
  // Terms are grouped the way the tabs follow the flow, after the roles that act in it.
  expect([...dialog.querySelectorAll('th.dt-glossary-group')].map(cell => cell.textContent)).toEqual(['Roles', 'Sources', 'Trigger', 'Eval',
    'Execution'])
  expect([...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Main Session'))!.textContent).toContain('prompts call it the orchestrator')
})

it('says dsh-superagent is not answering when its routes are gone, as while it restarts', async () => {
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
  expect(text()).not.toContain('404')
})

it('closes search results on Escape and on a click outside the search', async () => {
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  const submit = async () => { await type(search,
    'nothing'); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  await submit()
  expect(document.querySelector('.dt-search-results')).not.toBeNull()
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
  await submit()
  await act(async () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
})

it('shows the answer to the latest search only', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z', { preview: 'old message' }), found('e2', '2026-09-21T00:00:00Z',
    { preview: 'new message' })], threads: [] }
  let release = () => {}
  server.searching = async query => { if (query === 'old') await new Promise<void>(resolve => { release = resolve }) }
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  for (const query of ['old', 'new']) { await type(search,
    query); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
  await act(async () => { release() }); await settle()
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
})
