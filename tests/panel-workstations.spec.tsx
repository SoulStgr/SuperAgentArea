// @vitest-environment jsdom
// The 工作站 page: one card per Project with six sections, the new-workstation dialog, a Project's own page, and its settings.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const card = (name: string) => all('.dt-project-card').find(item => item.querySelector('.dt-project-title')?.textContent === name)!
const cards = () => all('.dt-project-card').map(item => item.querySelector('.dt-project-title')?.textContent)
const labels = (scope: Element) => [...scope.querySelectorAll('.dt-lv')].map(item => item.querySelector('.dt-lv-label')?.textContent)
const dialog = () => document.querySelector('[role="dialog"]')!
/** A tab of the page's own section bar; the top-level tab bar is outside the page's main area. */
const segment = (name: string) => find(name, '.dt-main [role="tablist"] [role="tab"]')
/** The row of one configured Source on a workstation's Sources section. */
const sourceRow = (name: string) => all('.dt-section .dt-row').find(row => row.textContent?.includes(name))!

it('shows one card per workstation with its address, counts and latest reporter, the workspace first and fixed', async () => {
  await mount()
  await click(zh['tab.workstations'])
  expect(cards()).toEqual(['workspace', 'aps'])
  // The built-in workspace is marked fixed, and the station's card names its address kind and its reporter.
  expect(card('workspace').textContent).toContain(zh.projectFixed)
  expect(card('workspace').textContent).toContain(zh['projectLocation.managed'])
  expect(card('aps').textContent).toContain(zh['projectLocation.folder'])
  expect(labels(card('aps'))).toEqual([zh.projectSources, zh.projectOpenTickets, zh.projectArtifacts, zh.projectActivity, zh.projectReporter])
  expect(card('aps').textContent).toContain('Alice')
  // A workstation's card opens its sections as well as its page.
  expect([...card('aps').querySelectorAll('.dt-project-segments button')].map(button => button.textContent))
    .toEqual([zh['projectSegment.sources'], zh['projectSegment.triggers'], zh['projectSegment.decisions'], zh['projectSegment.tickets'],
      zh['projectSegment.settings'], zh['projectSegment.agent']])
  // Only the workspace is left: the page says so and offers the action that creates one.
  server.projects = server.projects.filter(project => project.kind === 'workspace')
  await remount()
  await click(zh['tab.workstations'])
  expect(cards()).toEqual(['workspace'])
  expect(text()).toContain(zh.projectEmpty)
  expect(all('.dt-empty button').map(button => button.textContent)).toContain(zh.projectAddFirst)
})

it('keeps archived workstations out of the list until a person asks to see them', async () => {
  await mount()
  await click(zh['tab.workstations'])
  expect(cards()).toEqual(['workspace', 'aps'])
  await click(find(zh.projectShowArchived, '.dt-status-actions button'))
  expect(server.requests.filter(request => request.path === 'projects?status=archived')).toHaveLength(1)
  expect(cards()).toEqual(['workspace', 'aps', 'legacy'])
  expect(card('legacy').textContent).toContain(zh.projectArchived)
  expect(card('legacy').textContent).toContain(zh['projectLocation.repo'])
  await click(find(zh.projectHideArchived, '.dt-status-actions button'))
  expect(cards()).toEqual(['workspace', 'aps'])
})

it('creates a workstation from a name and an address, and shows a refusal where the person typed', async () => {
  await mount()
  await click(zh['tab.workstations'])
  await click(find(zh.projectAdd, '.dt-status-actions button'))
  expect(dialog().textContent).toContain(zh.projectAddTitle)
  // A name that is taken is refused in place, leaving the dialog open.
  await type(field<HTMLInputElement>(zh.projectName), 'aps')
  await click(find(zh.projectCreate, '[role="dialog"] button'))
  expect(dialog().querySelector('.dt-error')?.textContent).toBe(zh['userError.projectExists'].replace('{project}', 'aps'))
  expect(server.requests.some(request => request.path === 'projects' && request.method === 'POST')).toBe(true)
  // An address that is not absolute is refused with the host's reason.
  await type(field<HTMLInputElement>(zh.projectName), 'new station')
  await click(find(zh['projectLocation.folder'], '[role="dialog"] [role="tab"]'))
  await type(field<HTMLInputElement>(zh.projectPath), 'relative/path')
  await click(find(zh.projectCreate, '[role="dialog"] button'))
  expect(dialog().querySelector('.dt-error')?.textContent).toBe(zh['userError.projectLocationInvalid']
    .replace('{reason}', 'the folder must be an absolute path'))
  // A usable address creates the station and opens its page.
  await type(field<HTMLInputElement>(zh.projectPath), '/srv/new')
  await click(find(zh.projectCreate, '[role="dialog"] button'))
  expect(server.requests.filter(request => request.path === 'projects' && request.method === 'POST').at(-1))
    .toMatchObject({ body: { name: 'new station', location: { type: 'folder', path: '/srv/new' } } })
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.projectCreated.replace('{name}', 'new station'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('new station')
  expect(server.projects.some(project => project.key === 'new-station')).toBe(true)
})

/** Opens a workstation's page and one of its sections. */
async function openProject(name: string, section?: string) {
  await mount()
  await click(zh['tab.workstations'])
  await click(card(name).querySelector('.dt-project-title')!)
  if (section) await click(segment(section))
}

it('opens a workstation page with its six sections: Sources, Threads, Decisions, Tickets, settings and agent', async () => {
  await openProject('aps')
  // 来源: every configured Source with its state, and the toggle saying whether the workstation names it.
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${zh['projectSegment.sources']}1`])
  const sources = all('.dt-list > .dt-row').map(row => row.textContent)
  expect(sources[0]).toContain('飞书')
  expect(sources[0]).toContain(zh.projectSourceLinked)
  expect(sources[1]).toContain('GitHub')
  expect(sources[1]).toContain(zh.projectSourceLink)
  // 触发: its Threads, by the rows the Trigger page uses.
  await click(segment(`${zh['projectSegment.triggers']} 1`))
  expect(all('.dt-section .dt-ticket .dt-open').map(open => open.textContent)).toEqual(['这个文案好奇怪'])
  // 评估: its Threads' Decisions, with their strength and Policy version.
  await click(segment(`${zh['projectSegment.decisions']} 1`))
  expect(all('.dt-section .dt-ticket').length).toBe(1)
  expect(all('.dt-section .dt-lv-label').map(label => label.textContent)).toEqual(expect.arrayContaining([zh['term.strength'], zh.policyVersion]))
  expect(text()).toContain(zh['strength.explicit'])
  // 执行: its Tickets, by the rows the Execution page uses.
  await click(segment(`${zh['projectSegment.tickets']} 1`))
  expect(all('.dt-section .dt-ticket .dt-open').map(open => open.textContent)).toEqual(['修复回归'])
  // 设置: its name, aliases and the directories fixed when it was created.
  await click(segment(zh['projectSegment.settings']))
  expect(field<HTMLInputElement>(zh.projectName).value).toBe('aps')
  expect(all('.dt-kv dd').map(cell => cell.textContent)).toEqual(['/srv/aps', '/srv/dsh-superagent/area/aps.work',
    '/srv/dsh-superagent/area/aps.work/rules'])
  // agent: only its disabled entry, saying the project Session arrives in P6.
  await click(segment(zh['projectSegment.agent']))
  expect(text()).toContain(zh.projectAgentPending)
  expect(find(zh.projectAgentOpen, '.dt-section button').matches(':disabled')).toBe(true)
})

it('opens the Thread and the Ticket a workstation\'s sections list', async () => {
  await openProject('aps', `${zh['projectSegment.triggers']} 1`)
  await click(find('这个文案好奇怪', '.dt-section .dt-open'))
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  await openProject('aps', `${zh['projectSegment.tickets']} 1`)
  await click(find('修复回归', '.dt-section .dt-open'))
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(true)
})

it('saves a workstation\'s name and aliases, shows its directories read-only, and archives and restores it', async () => {
  await openProject('aps', zh['projectSegment.settings'])
  expect(field<HTMLInputElement>(zh.projectName).value).toBe('aps')
  expect(all('.dt-kv dd').map(cell => cell.textContent)).toEqual(['/srv/aps', '/srv/dsh-superagent/area/aps.work',
    '/srv/dsh-superagent/area/aps.work/rules'])
  // The name and the aliases save together, in one patch.
  await type(field<HTMLInputElement>(zh.projectName), 'aps 填报')
  await type(field<HTMLInputElement>(zh.projectAliases), 'APS, 填报')
  await click(find(zh.save, '.dt-section form button'))
  expect(server.requests.filter(request => request.path === 'projects/prj_aps' && request.method === 'PATCH').at(-1))
    .toMatchObject({ body: { name: 'aps 填报', aliases: ['APS', '填报'] } })
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps 填报')
  // Archiving keeps the page, marks the station archived and offers to restore it.
  await click(find(zh.projectArchive, '.dt-page-title button'))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.requests.filter(request => request.path === 'projects/prj_aps' && request.method === 'PATCH').at(-1))
    .toMatchObject({ body: { archived: true } })
  expect(document.querySelector('.dt-page-title')?.textContent).toContain(zh.projectArchived)
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.projectArchivedDone.replace('{name}', 'aps 填报'))
  await click(find(zh.projectRestore, '.dt-page-title button'))
  expect(server.requests.filter(request => request.path === 'projects/prj_aps' && request.method === 'PATCH').at(-1))
    .toMatchObject({ body: { archived: false } })
  expect(server.projects.find(project => project.id === 'prj_aps')!.status).toBe('active')
})

it('keeps the built-in workspace fixed: no archive action, and its name cannot be edited', async () => {
  await openProject('workspace', zh['projectSegment.settings'])
  expect(field<HTMLInputElement>(zh.projectName).matches(':disabled')).toBe(true)
  expect(text()).toContain(zh.projectWorkspaceFixed)
  expect(all('.dt-page-title button').map(button => button.textContent)).not.toContain(zh.projectArchive)
})

it('links and unlinks a Source from a workstation\'s Sources section', async () => {
  await openProject('aps')
  await click(find(zh.projectSourceLink, '.dt-section .dt-row button'))
  expect(server.requests.filter(request => request.path === 'projects/prj_aps' && request.method === 'PATCH').at(-1))
    .toMatchObject({ body: { sourceIds: ['feishu', 'github'] } })
  expect(server.projects.find(project => project.id === 'prj_aps')!.sourceIds).toEqual(['feishu', 'github'])
  // Unlinking the Source the workstation names leaves the other one, which it still names.
  await click(find(zh.projectSourceLinked, '.dt-section .dt-row button'))
  expect(server.projects.find(project => project.id === 'prj_aps')!.sourceIds).toEqual(['github'])
})

it('opens the Source page a workstation\'s Source names', async () => {
  await openProject('aps')
  await click(find('飞书', '.dt-section .dt-row button'))
  expect(server.requests.some(request => request.path === 'sources/feishu')).toBe(true)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('飞书')
})

it('shows the agent section disabled, saying that the project Session arrives in P6', async () => {
  await openProject('aps', zh['projectSegment.agent'])
  expect(text()).toContain(zh.projectAgentPending)
  const open = find(zh.projectAgentOpen, '.dt-section button')
  expect(open.matches(':disabled')).toBe(true)
})

it('keeps a workstation page and its section after the panel is remounted', async () => {
  await openProject('aps', `${zh['projectSegment.tickets']} 1`)
  await settle()
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps')
  expect(document.querySelector('.dt-main [role="tablist"] [role="tab"][aria-selected="true"]')?.textContent)
    .toBe(`${zh['projectSegment.tickets']} 1`)
})
