// @vitest-environment jsdom
// The 工作站 page: one card per Project with six sections, the new-workstation dialog, a Project's own page, and its settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, click, type, text, field } from './fixtures/panel.tsx'
import { artifactDetail, server, type ProjectFixture } from './fixtures/panel-server.ts'

usePanel()

const card = (name: string) => all('.dt-project-card').find(item => item.querySelector('.dt-project-title')?.textContent === name)!
const cards = () => all('.dt-project-card').map(item => item.querySelector('.dt-project-title')?.textContent)
const labels = (scope: Element) => [...scope.querySelectorAll('.dt-lv')].map(item => item.querySelector('.dt-lv-label')?.textContent)
const dialog = () => document.querySelector('[role="dialog"]')!
/** A tab of the page's own section bar; the top-level tab bar is outside the page's main area. */
const segment = (name: string) => find(name, '.dt-main [role="tablist"] [role="tab"]')
/** The row of one configured Source on a workstation's Sources section. */
const sourceRow = (name: string) => all('.dt-section .dt-row').find(row => row.textContent?.includes(name))!
/** The section of a workstation's page whose title it names, such as one of the agent history lists. */
const section = (name: string) => all('.dt-main .dt-section').find(item =>
  item.querySelector('.dt-section-name')?.textContent === name)!
/** A workstation that owns no Tickets or artifacts, so a person may delete it. */
const cleanProject = (id: string, name: string): ProjectFixture => ({ id, key: name, name, kind: 'station',
  location: { type: 'folder', path: `/srv/${id}` }, status: 'active', sourceIds: [], aliases: [], outputDir: `/srv/${id}`,
  scratchDir: `/srv/dsh-superagent/area/${id}.work`, rulesDir: `/srv/dsh-superagent/area/${id}.work/rules`,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
/** The worded refusal of deleting a workstation that still owns work. */
const hasWork = (name: string, tickets: number, artifacts: number) => zh['userError.projectHasWork']
  .replace('{project}', name).replace('{tickets}', String(tickets)).replace('{artifacts}', String(artifacts))

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
  // A workstation's card opens its sections, and its own button opens its conversation.
  expect([...card('aps').querySelectorAll('.dt-project-segments button')].map(button => button.textContent))
    .toEqual([zh['projectSegment.sources'], zh['projectSegment.triggers'], zh['projectSegment.decisions'], zh['projectSegment.tickets'],
      zh['projectSegment.settings'], zh['projectSegment.agent'], zh.projectConversation])
  // Only a non-workspace card offers deletion, at the top-right of its head.
  expect(card('workspace').querySelector(`[aria-label="${zh.projectDelete}"]`)).toBeNull()
  expect(card('aps').querySelector(`[aria-label="${zh.projectDelete}"]`)).not.toBeNull()
  // Only the workspace is left: the page says so and offers the action that creates one.
  server.projects = server.projects.filter(project => project.kind === 'workspace')
  await remount()
  await click(zh['tab.workstations'])
  expect(cards()).toEqual(['workspace'])
  expect(text()).toContain(zh.projectEmpty)
  expect(all('.dt-empty button').map(button => button.textContent)).toContain(zh.projectAddFirst)
})

it('counts the same artifacts on a workstation\'s card and its page', async () => {
  // An artifact saved before Projects existed has no Project column; the workspace counts it everywhere.
  const workspace = server.projects.find(project => project.kind === 'workspace')!
  workspace.artifacts = [{ id: 'a-old', name: 'old.csv', size: 3, at: '2026-09-20T00:00:00Z', ticket: 't0', source: 'github',
    targetRoot: '/tmp/outbox', hash: 'h-old' }]
  await mount()
  await click(zh['tab.workstations'])
  const countOf = (label: string, scope: Element) => [...scope.querySelectorAll('.dt-lv')]
    .find(item => item.querySelector('.dt-lv-label')?.textContent === label)?.querySelector('.dt-lv-value')?.textContent
  expect(countOf(zh.projectArtifacts, card('workspace'))).toBe('1')
  await click(card('workspace').querySelector('.dt-project-title')!)
  expect(countOf(zh.projectArtifacts, document.querySelector('.dt-main')!)).toBe('1')
  // The agent section lists no work history: Tickets, artifacts and reports have their own pages.
  await click(segment(zh['projectSegment.agent']))
  expect(text()).not.toContain(zh.projectAgentChanges)
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

it('deletes a workstation that owns no work from its card, and keeps one that still does', async () => {
  server.projects.push(cleanProject('prj_clean', 'clean'))
  await mount()
  await click(zh['tab.workstations'])
  const deletes = (id: string) => server.requests.filter(request => request.path === `projects/${id}` && request.method === 'DELETE')
  // A station that still owns Tickets or artifacts is refused with the localized reason, and stays.
  await click(card('aps').querySelector<HTMLButtonElement>(`[aria-label="${zh.projectDelete}"]`)!)
  expect(dialog().textContent).toContain(zh.projectDeleteTitle)
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(deletes('prj_aps')).toHaveLength(1)
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(hasWork('aps', 1, 1))
  expect(cards()).toContain('aps')
  // The refused dialog stays open so the archive action can be chosen instead.
  await click(find(zh.cancel, '[role="dialog"] button'))
  // A station with no work is deleted, its conversation archived, and it leaves the list.
  await click(card('clean').querySelector<HTMLButtonElement>(`[aria-label="${zh.projectDelete}"]`)!)
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(deletes('prj_clean')).toHaveLength(1)
  expect(server.projects.some(project => project.id === 'prj_clean')).toBe(false)
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.projectDeleted.replace('{name}', 'clean'))
  expect(cards()).not.toContain('clean')
  expect(server.archivedSessions).toEqual([{ id: 'project-prj_clean', stopActivity: true }])
})

it('deletes a workstation from its page and returns to the list; a refused deletion keeps the page', async () => {
  server.projects.push(cleanProject('prj_clean', 'clean'))
  await openProject('aps')
  await click(find(zh.projectDelete, '.dt-page-title button'))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(hasWork('aps', 1, 1))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps')
  await click(find(zh.cancel, '[role="dialog"] button'))
  // A station with no work deletes from its page, which then shows the list again.
  await click(zh['tab.workstations'])
  await click(card('clean').querySelector('.dt-project-title')!)
  await click(find(zh.projectDelete, '.dt-page-title button'))
  expect(dialog().textContent).toContain(zh.projectDeleteConfirm.replace('{name}', 'clean'))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.workstations'])
  expect(cards()).not.toContain('clean')
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.projectDeleted.replace('{name}', 'clean'))
  expect(server.archivedSessions).toEqual([{ id: 'project-prj_clean', stopActivity: true }])
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
  // agent: only its agent's requirements and rules; the work history lives on the Tickets and artifacts pages.
  await click(segment(zh['projectSegment.agent']))
  expect(all('.dt-main .dt-section-title').map(title => title.textContent)).toEqual([zh.projectAgentRulesTitle])
  expect(text()).toContain(zh.projectAgentRulesIntro)
  expect(text()).toContain(zh.projectAgentRulesNone)
  // The agent section has no conversation block: opening and deleting the conversation live in the page head.
  expect(all('.dt-section button').map(button => button.textContent)).not.toContain(zh.projectConversationOpen)
  expect(all('.dt-section button').map(button => button.textContent)).not.toContain(zh.projectConversationDelete)
  expect(text()).not.toContain(zh.projectAgentTickets)
  expect(text()).not.toContain(zh.projectAgentChanges)
  expect(text()).not.toContain(zh.projectAgentReports)
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

it('keeps the built-in workspace fixed: no archive or delete action, and its name cannot be edited', async () => {
  await openProject('workspace', zh['projectSegment.settings'])
  expect(field<HTMLInputElement>(zh.projectName).matches(':disabled')).toBe(true)
  expect(text()).toContain(zh.projectWorkspaceFixed)
  expect(all('.dt-page-title button').map(button => button.textContent)).not.toContain(zh.projectArchive)
  expect(all('.dt-page-title button').map(button => button.textContent)).not.toContain(zh.projectDelete)
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

/** The page head's conversation buttons; the agent section no longer has a conversation block. */
const conversationButton = (name: string) => find(name, '.dt-page-title button')

it('opens a workstation\'s conversation from its card and its page head, naming its Workspace SAA-<name>', async () => {
  await mount()
  await click(zh['tab.workstations'])
  const apsConversation = () => [...card('aps').querySelectorAll<HTMLButtonElement>('.dt-project-segments button')]
    .find(button => button.textContent === zh.projectConversation)!
  // The card's button creates the Workspace under the station folder, names it SAA-aps, and opens the Session it filed.
  await click(apsConversation())
  expect(server.workspaces).toEqual([{ workspaceId: 'ws:/srv/aps', path: '/srv/aps', title: 'SAA-aps',
    sessionIds: ['project-prj_aps'] }])
  expect(server.created).toEqual([{ sessionId: 'project-prj_aps', workspaceId: 'ws:/srv/aps' }])
  expect(server.opened).toEqual(['project-prj_aps'])
  // The page head opens the same conversation; the listed Session is not created again and its Workspace keeps its title.
  await click(card('aps').querySelector('.dt-project-title')!)
  await click(conversationButton(zh.projectConversationOpen))
  expect(server.created).toHaveLength(1)
  expect(server.opened).toEqual(['project-prj_aps', 'project-prj_aps'])
  expect(server.workspaces[0]!.title).toBe('SAA-aps')
})

it('opens a workstation conversation without a Workspace when it cannot be created', async () => {
  server.workspaceError = 'the directory cannot be owned'
  await openProject('aps')
  await click(conversationButton(zh.projectConversationOpen))
  // The Session falls back to the Project's conversation directory as its cwd, and still opens.
  expect(server.created).toEqual([{ sessionId: 'project-prj_aps', cwd: '/srv/aps' }])
  expect(server.opened).toEqual(['project-prj_aps'])
  expect(server.workspaces).toEqual([])
})

it('starts a conversation its Workspace does not list over with the next generation', async () => {
  // A Session an earlier version created outside its Workspace is listed, but no Workspace carries it.
  server.hostSessions.add('project-prj_aps'); server.sessions.add('project-prj_aps')
  await openProject('aps')
  await click(conversationButton(zh.projectConversationOpen))
  expect(server.requests.some(request => request.path === 'projects/prj_aps/conversation/reset' && request.method === 'POST')).toBe(true)
  expect(server.created.at(-1)).toEqual({ sessionId: 'project-prj_aps-1', workspaceId: 'ws:/srv/aps' })
  expect(server.workspaces[0]!.sessionIds).toEqual(['project-prj_aps-1'])
  expect(server.opened.at(-1)).toBe('project-prj_aps-1')
})

it('shows the conversation button busy while it opens, and reports a failure it cannot recover from', async () => {
  await openProject('aps')
  const button = () => conversationButton(zh.projectConversationOpen)
  // A slow Workspace creation keeps the button disabled until the conversation opens.
  const waiting = Promise.withResolvers<void>()
  server.conversationWait = () => waiting.promise
  await act(async () => { button().click() })
  expect(button().matches(':disabled')).toBe(true)
  waiting.resolve()
  await settle()
  expect(button().matches(':disabled')).toBe(false)
  expect(server.opened).toEqual(['project-prj_aps'])
  // A creation the refreshed catalog does not explain is reported, and the button is usable again.
  server.conversationWait = undefined
  server.hostSessions.delete('project-prj_aps')
  server.sessions.delete('project-prj_aps')
  server.sessionCreateError = 'the session cannot be created'
  await click(button())
  expect(document.querySelector('.dt-toast')?.textContent).toBe('the session cannot be created')
  expect(button().matches(':disabled')).toBe(false)
})

it('deletes a workstation\'s conversation from the page head, archiving the old Session and opening the next generation',
  async () => {
  await openProject('aps')
  const open = () => conversationButton(zh.projectConversationOpen)
  const remove = () => conversationButton(zh.projectConversationDelete)
  // The first conversation is the unnumbered id; deleting it archives it and advances the generation.
  await click(open())
  expect(server.created).toEqual([{ sessionId: 'project-prj_aps', workspaceId: 'ws:/srv/aps' }])
  await click(remove())
  expect(dialog().textContent).toContain(zh.projectConversationDeleteTitle)
  expect(dialog().textContent).toContain(zh.projectConversationDeleteConfirm.replace('{name}', 'aps'))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.requests.some(request => request.path === 'projects/prj_aps/conversation/reset' && request.method === 'POST')).toBe(true)
  expect(server.archivedSessions).toEqual([{ id: 'project-prj_aps', stopActivity: true }])
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.projectConversationDeleted)
  expect(server.projects.find(project => project.id === 'prj_aps')!.conversationGeneration).toBe(1)
  // The next open creates the numbered Session of the generation the page reloaded, which its Workspace then lists.
  await click(open())
  expect(server.created.at(-1)).toEqual({ sessionId: 'project-prj_aps-1', workspaceId: 'ws:/srv/aps' })
  expect(server.workspaces[0]!.sessionIds).toEqual(['project-prj_aps', 'project-prj_aps-1'])
  // Deleting the conversation again archives the numbered Session and opens the next one.
  await click(remove())
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.archivedSessions.at(-1)).toEqual({ id: 'project-prj_aps-1', stopActivity: true })
  await click(open())
  expect(server.created.at(-1)).toEqual({ sessionId: 'project-prj_aps-2', workspaceId: 'ws:/srv/aps' })
})

it('deletes a workstation conversation that was never opened, and a card opens the generation it lists', async () => {
  await openProject('aps')
  await click(conversationButton(zh.projectConversationDelete))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.requests.some(request => request.path === 'projects/prj_aps/conversation/reset' && request.method === 'POST')).toBe(true)
  expect(server.projects.find(project => project.id === 'prj_aps')!.conversationGeneration).toBe(1)
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.projectConversationDeleted)
  // The list's card names the generation too, so its conversation creates the numbered Session and its Workspace.
  server.projects.find(project => project.id === 'prj_aps')!.conversationGeneration = 3
  await click(zh['tab.workstations'])
  await click([...card('aps').querySelectorAll<HTMLButtonElement>('.dt-project-segments button')]
    .find(button => button.textContent === zh.projectConversation)!)
  expect(server.created.at(-1)).toEqual({ sessionId: 'project-prj_aps-3', workspaceId: 'ws:/srv/aps' })
  expect(server.workspaces[0]!.title).toBe('SAA-aps')
})

it('edits a workstation agent\'s requirements and rules, saving them trimmed and without repetitions', async () => {
  await openProject('aps', zh['projectSegment.agent'])
  const ruleField = (number: number) => field<HTMLTextAreaElement>(zh.projectAgentRuleItem.replace('{number}', String(number)))
  const add = () => find(zh.projectAgentRulesAdd, '.dt-section button')
  const save = () => find(zh.save, '.dt-section button')
  // The action row puts adding on the left and saving, primary and only once there is a change, on the right.
  const actions = () => section(zh.projectAgentRulesTitle).querySelector('.dt-rules-actions')!
  expect([...actions().querySelectorAll('button')].map(button => button.textContent)).toEqual([zh.projectAgentRulesAdd, zh.save])
  expect(actions().querySelector('button.dt-btn-primary')?.textContent).toBe(zh.save)
  expect(save().matches(':disabled')).toBe(true)
  expect(text()).toContain(zh.projectAgentRulesNone)
  // Adding without writing anything keeps the save disabled: there is nothing new to save.
  await click(add())
  expect(save().matches(':disabled')).toBe(true)
  await type(ruleField(1), '  回答前先读 README  ')
  await click(add())
  await type(ruleField(2), '回答前先读 README')
  await click(save())
  // The host trims entries and drops repetitions; the page saves what it writes and reloads it.
  expect(server.requests.filter(request => request.path === 'projects/prj_aps' && request.method === 'PATCH').at(-1))
    .toMatchObject({ body: { agentRules: ['回答前先读 README'] } })
  expect(server.projects.find(project => project.id === 'prj_aps')!.agentRules).toEqual(['回答前先读 README'])
  expect(all('.dt-section textarea').length).toBe(1)
  expect(field<HTMLTextAreaElement>(zh.projectAgentRuleItem.replace('{number}', '1')).value).toBe('回答前先读 README')
  // A refused save is reported where the rules are edited, and the draft stays.
  await type(ruleField(1), 'x'.repeat(2001))
  await click(save())
  expect(section(zh.projectAgentRulesTitle).querySelector('[role="alert"]')).not.toBeNull()
  expect(section(zh.projectAgentRulesTitle).textContent).toContain('agentRules')
  // A deleted rule saves as none, which clears the Project's own rules.
  await type(ruleField(1), '简短要求')
  await click(save())
  await click(find(zh.projectAgentRuleRemove.replace('{number}', '1'), '.dt-section button'))
  await click(save())
  expect(server.projects.find(project => project.id === 'prj_aps')!.agentRules).toBeUndefined()
  expect(text()).toContain(zh.projectAgentRulesNone)
})

it('leaves work history to its own pages and still opens a workstation\'s conversation', async () => {
  const aps = server.projects.find(project => project.id === 'prj_aps')!
  aps.tickets = []; aps.artifacts = []; aps.threads = []
  await openProject('aps', zh['projectSegment.agent'])
  // The agent section lists rules only; the empty work history is not part of it.
  expect(text()).not.toContain(zh.projectAgentTickets)
  expect(text()).not.toContain(zh.projectAgentChanges)
  expect(text()).not.toContain(zh.projectAgentReports)
  // The page head still opens the conversation of a workstation without work.
  expect(conversationButton(zh.projectConversationOpen).matches(':disabled')).toBe(false)
})

it('keeps a workstation page and its section after the panel is remounted', async () => {
  await openProject('aps', `${zh['projectSegment.tickets']} 1`)
  await settle()
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps')
  expect(document.querySelector('.dt-main [role="tablist"] [role="tab"][aria-selected="true"]')?.textContent)
    .toBe(`${zh['projectSegment.tickets']} 1`)
})
