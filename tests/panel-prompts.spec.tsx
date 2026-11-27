// @vitest-environment jsdom
// One Source instance's Prompts, the prompts part of its Policy and prompts page.
import { act } from 'react'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, promptVersion, type PromptScope } from './fixtures/panel-server.ts'

usePanel()
const governancePart = (name: string) => all('.dt-governance-parts [role="tab"]').find(item => item.textContent === name)!
/** Opens one instance's Policy and prompts page at its prompts part: the page reads them at once. */
async function openPrompts(id = 'feishu') {
  expect(governancePart(zh.sourceGovernancePrompts).getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path === `sources/${id}/prompts`)).toBe(true)
}
const sourceScope = (id = 'feishu'): PromptScope => server.promptScopes[id]!
const builtInItem = (name: string) => all('.dt-prompt-nav .dt-nav-item').find(item => item.querySelector('span')!.firstChild?.textContent === name)!

it('lists the team sections and the built-in parts without source skill parts, edits and saves one Source\'s prompts, and resets a section',
  async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  const names = all('.dt-prompt-nav .dt-nav-item > span').map(item => item.textContent)
  expect(names.slice(0, 3)).toEqual(['沟通方式', '工单范围', '交付要求'])
  const parts = Object.keys(builtInParts())
  expect(names.slice(3, 3 + parts.length)).toEqual(parts.map(key => zh[`promptPart.${key}` as keyof typeof zh]))
  // A Source's skills are its kind's default skill (read-only, by its bare name) and the team's own; the old source skills are no longer parts.
  expect(all('.dt-prompt-nav .dt-nav-item')).toHaveLength(3 + parts.length + 1)
  expect(all('.dt-prompt-nav .dt-nav-item').at(-1)!.textContent).toBe(`feishu${zh.promptDefaultSkill}`)
  expect(parts).not.toContain('skill/feishu')
  expect(parts).not.toContain('skill/github')
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Custom communication rule')
  expect(text()).toContain('1 处修改')
  await click(tab(zh.promptViewFull))
  // The full prompt shows every part, team or built in, as editable, in the order the Session reads them.
  const shown = all('.dt-preview-part').map(part => [part.querySelector('b')?.textContent, part.hasAttribute('data-editable')])
  expect(shown.slice(0, 5)).toEqual([['共享约定', true], ['主 Session 角色', true], ['沟通方式', true], ['工单范围', true], ['交付要求', true]])
  expect(text()).toContain('Custom communication rule')
  await click(all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === '沟通方式')!.querySelector('button')!)
  await click(zh.promptResetSection)
  expect(text()).not.toContain('处修改')
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Second rule')
  await click(zh.save)
  expect(sourceScope().current.config.communication).toBe('Second rule')
  // The save went to this Source's prompts, not to its settings or to the installation's prompts.
  expect(server.requests.some(request => request.method === 'PUT' && request.path === 'sources/feishu/prompts')).toBe(true)
  expect(server.requests.some(request => request.path.startsWith('settings/'))).toBe(false)
  expect(server.requests.some(request => request.method === 'PUT' && request.path === 'prompts')).toBe(false)
})

it('keeps a conflicting prompt draft, rebases it onto the newer version and saves on retry', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Mine')
  server.promptScopes.feishu = { revision: 1, current: { ...promptVersion(1, { ...defaultPrompts(), scope: 'Theirs' }), source: 'panel' },
    revisions: [{ ...promptVersion(1, { ...defaultPrompts(), scope: 'Theirs' }), changed: [] }], next_offset: null }
  await click(zh.save)
  expect(document.querySelector('.dt-savebar')?.textContent).toContain('提示词已被修改到版本 1。已保留你的草稿')
  await click(zh.save)
  // The other save's section stays: the draft moved onto version 1 section by section, not as a whole.
  expect(sourceScope().current.config).toMatchObject({ communication: 'Mine', scope: 'Theirs' })
})

it('shows a bundled default skill read-only in the full prompt, and adds a team skill but no skill under a default or invalid name',
  async () => {
  at({ page: 'governance', id: 'github', query: { part: 'prompts' } })
  await mount()
  await openPrompts('github')
  // The default skill is this Source kind's own, named by its bare name; its Sessions register it by name.
  await click(all('.dt-prompt-nav .dt-nav-item').find(item => item.textContent?.includes('github'))!)
  expect(text()).toContain(zh['promptReadBy.defaultSkill'])
  expect(all('.dt-prompt-nav .dt-nav-item[aria-current="true"] .dt-default-tag').map(tag => tag.textContent)).toEqual([zh.promptDefaultSkill])
  await click(tab(zh.promptViewFull))
  await act(async () => { const select = field<HTMLSelectElement>(zh.promptPreviewTarget); select.value = 'skill/github'
    select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  expect(text()).toContain('## CLI usage')
  // A default skill is not a part of the configuration: the editor offers none of them as editable.
  expect(all('.dt-preview-part[data-editable]')).toHaveLength(0)
  await click(tab(zh.promptViewEdit))
  for (const name of ['Bad Name', 'github']) {
    await type(field<HTMLInputElement>(zh.promptAddSkill), name)
    await click(zh.promptAddSkillAction)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.promptSkillNameInvalid)
  }
  await type(field<HTMLInputElement>(zh.promptAddSkill), 'testing')
  await click(zh.promptAddSkillAction)
  expect(all('.dt-nav-item').map(item => item.textContent)).toContain('dsh-superagentarea-testing')
})

it('loads all defaults into the draft from the history without saving them', async () => {
  server.prompts.current = promptVersion(0, { ...defaultPrompts(), scope: 'Old scope' })
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await click(tab(zh.promptViewHistory))
  const first = `版本 0 · ${zh.promptHistoryInitial} · ${zh['historySource.defaults']}`
  expect(all('.dt-row-title').map(title => title.textContent)).toContain(first)
  await click(zh.promptDefaults)
  expect(text()).toContain(zh.promptDraftFromDefaults)
  expect(server.requests.some(request => request.path === 'sources/feishu/prompts' && request.method === 'PUT')).toBe(false)
})

it('keeps the save bar hidden while a preview loads for an unchanged draft', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  let shown = false
  const watch = new MutationObserver(() => { if (document.querySelector('.dt-savebar')) shown = true })
  watch.observe(document.body, { childList: true, subtree: true })
  await click(tab(zh.promptViewFull))
  await settle()
  watch.disconnect()
  expect(shown).toBe(false)
})

it('marks team sections that differ from the defaults, and shows a draft as a diff against the saved version or the defaults', async () => {
  server.prompts.revision = 1
  server.prompts.current = promptVersion(1, { ...defaultPrompts(), delivery: `${defaultPrompts().delivery}\nCommit as the bot account.` })
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  expect(all('.dt-prompt-nav .dt-nav-item').filter(item => item.querySelector('.dt-changed-tag:not(.dt-default-tag)'))
    .map(item => item.querySelector('span')!.firstChild?.textContent)).toEqual(['交付要求'])
  await type(field<HTMLTextAreaElement>(zh.promptBody), `${defaultPrompts().communication}\nSign as the agent.`)
  await click(tab(zh.promptViewFull))
  // A draft opens against the saved version: only its change shows, and the parts it leaves as they were fold.
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n'])
  expect(all('.dt-preview-part del')).toHaveLength(0)
  expect(text()).toContain(zh.promptSameAsSaved)
  await click(zh.promptCompareDefault)
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toEqual(['Sign as the agent.\n', 'Commit as the bot account.\n'])
})

it('discards a prompt draft by reading the saved version again', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Mine')
  server.prompts.revision = 1
  server.prompts.current = promptVersion(1, { ...defaultPrompts(), communication: 'Theirs' })
  await click(zh.discard)
  await settle()
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('Theirs')
  expect(all('.dt-savebar')).toHaveLength(0)
})

it('edits a built-in part as an override of its built-in text, marks it changed, and resets it to the built-in text', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  const shared = builtInParts()['runtime/shared']!
  await click(builtInItem(zh['promptPart.runtime/shared']))
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(shared.text)
  expect(text()).toContain(zh['promptReadBy.both'])
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Shared, the team way.')
  expect(builtInItem(zh['promptPart.runtime/shared']).querySelector('.dt-changed-tag')?.textContent).toBe(zh.promptChanged)
  await click(zh.save)
  // The override records the built-in text it was edited from.
  expect(sourceScope().current.config.overrides).toEqual({ 'runtime/shared': { text: 'Shared, the team way.', base: builtInBase(shared.text) } })
  // The full prompt reads the override in place of the built-in text, compared with the defaults.
  await click(tab(zh.promptViewFull))
  expect(all('.dt-preview-part ins').map(line => line.textContent)).toContain('Shared, the team way.\n')
  await click(all('.dt-preview-part[data-editable] button')[0]!)
  await click(zh.promptResetSection)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(shared.text)
  await click(zh.save)
  expect(sourceScope().current.config).not.toHaveProperty('overrides')
})

it('says which placeholders a template keeps', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await click(builtInItem(zh['promptPart.runtime/policy']))
  expect(text()).toContain('这是模板：保留占位符 {version}、{mode}、{rules}，由系统填入内容。')
  expect(text()).toContain(zh['promptReadBy.orchestrator'])
})

it('marks an override whose built-in text an upgrade changed, shows how it changed, and keeps or takes the default', async () => {
  const dispatch = builtInParts()['runtime/dispatch']!
  const overrides = { 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: builtInBase('## dispatch\nThe old routing.') } }
  server.prompts.revision = 1
  server.prompts.current = promptVersion(1, { ...defaultPrompts(), overrides })
  server.prompts.defaultChanged = [{ part: 'runtime/dispatch', base: overrides['runtime/dispatch'].base, previous: '## dispatch\nThe old routing.' }]
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  expect(all('.dt-prompt-nav .dt-updated-tag').map(tag => tag.closest('.dt-nav-item')!.querySelector('span')!.firstChild?.textContent))
    .toEqual([zh['promptPart.runtime/dispatch']])
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  // The change of the built-in text, beside the team's text, which stays, in a region named by the mark.
  const box = () => document.querySelector(`section[aria-label="${zh.promptDefaultUpdated}"]`)
  expect(box()!.textContent).toContain('下面是默认内容的变化。')
  expect([...box()!.querySelectorAll('del')].map(line => line.textContent)).toEqual(['The old routing.\n'])
  expect(box()!.querySelectorAll('ins').length).toBeGreaterThan(0)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('## dispatch\nOur routing.')
  // Taking the new built-in text drops the override.
  await click(zh.promptTakeDefault)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(dispatch.text)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(zh.discard)
  await click(builtInItem(zh['promptPart.runtime/dispatch']))
  // Keeping the team's text records the new built-in text as the one it was edited from.
  await click(zh.promptKeepMine)
  expect(all('.dt-default-updated')).toHaveLength(0)
  await click(zh.save)
  expect(sourceScope().current.config.overrides).toEqual({ 'runtime/dispatch': { text: '## dispatch\nOur routing.', base: builtInBase(dispatch.text) } })
})

it('keeps both sides\' first overrides when a draft moves onto a version saved meanwhile', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await click(builtInItem(zh['promptPart.runtime/shared']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Shared, ours.')
  const theirs = { 'runtime/dispatch': { text: '## dispatch\nTheirs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) } }
  server.promptScopes.feishu = { revision: 1, current: promptVersion(1, { ...defaultPrompts(), overrides: theirs }),
    revisions: [], next_offset: null }
  await click(zh.save)
  expect(document.querySelector('.dt-savebar')?.textContent).not.toContain('undefined')
  await click(zh.save)
  expect(sourceScope().current.config.overrides).toEqual({ ...theirs,
    'runtime/shared': { text: 'Shared, ours.', base: builtInBase(builtInParts()['runtime/shared'].text) } })
})

it('shows a draft\'s template of a generated part filled, and names a part by its label when a save is refused', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await click(builtInItem(zh['promptPart.runtime/environment']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Where you work:\n{variables}')
  await click(tab(zh.promptViewFull))
  const environment = all('.dt-preview-part').find(part => part.querySelector('b')?.textContent === zh['promptPart.runtime/environment'])!
  expect(environment.querySelector('pre')?.textContent).toBe('Where you work:\n')
  await click(tab(zh.promptViewEdit))
  await click(builtInItem(zh['promptPart.runtime/policy']))
  await type(field<HTMLTextAreaElement>(zh.promptBody), '## Policy\n{version} {mode}')
  await click(zh.save)
  await settle()
  expect(text()).toContain(`「${zh['promptPart.runtime/policy']}」的模板必须保留占位符 {rules}`)
})

it('lists the overrides of parts this version no longer has, which the next save drops', async () => {
  server.prompts.defaultChanged = [{ part: 'runtime/retired', base: 'b', removed: true }]
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  expect(text()).toContain(zh.promptRemovedParts.replace('{parts}', 'runtime/retired'))
})

it('loads a version from the history without its overrides of parts this version no longer has, so it saves', async () => {
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  await click(tab(zh.promptViewHistory))
  // The version restored overrides a part a later version removed.
  const saved = server.prompts.current
  server.prompts.current = promptVersion(0, { ...defaultPrompts(),
    overrides: { 'runtime/dispatch': dispatch, 'runtime/retired': { text: 'Old.', base: 'b' } } })
  await click(zh.promptRestore)
  server.prompts.current = saved
  await click(zh.save)
  expect(sourceScope().current.config.overrides).toEqual({ 'runtime/dispatch': dispatch })
})

it('keeps the installation\'s prompts for a Source until it saves its own, and shows the source its history inherited', async () => {
  at({ page: 'governance', id: 'feishu', query: { part: 'prompts' } })
  await mount()
  await openPrompts()
  // Revision 0 and the installation's sections until the first save; saving makes this Source's own revision 1.
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Only for Feishu')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'sources/feishu/prompts' && request.method === 'PUT'))
    .toMatchObject({ body: { baseRevision: 0 } })
  expect(sourceScope().revision).toBe(1)
  expect(sourceScope().current.source).toBe('panel')
  expect(server.requests.some(request => request.path === 'sources/feishu/prompts?revision=0')).toBe(false)
  // A second Source keeps the installation's configuration: saving one instance changes no other.
  expect(server.promptScopes.github).toBeUndefined()
})
