/** 工作站 (workstations) page: one card per Project with its six sections, the new-workstation dialog, and a Project's own page. */
import { useState } from 'react'
import type { NewProject, ProjectPatch } from '../app/api.ts'
import type { ProjectLocation } from '../core/index.ts'
import { usePoll, type DecisionRow, type ProjectDetailView, type ProjectRecord, type ProjectRow,
  type ProjectSourceRow, type ThreadRow, type TicketRow } from './api.ts'
import { Button, Dot, Icon, InfoTip, Modal, Pill, SegmentedControl, Tag } from './controls.tsx'
import { sourceMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { PROJECT_SEGMENTS, type ProjectSegment } from './route.ts'
import { DecisionLine, ThreadLine, TicketLine } from './rows.tsx'
import { actorName, errorText, localized, valueLabel } from './text.ts'
import { ConfirmButton, Hint, KeyValues, LabelValue, LoadMore, LoadState, PageHead, Section, When } from './widgets.tsx'

/** Whether an address names a repository rather than a local folder, by its protocol or scp form. */
const repositoryAddress = (address: string): boolean => /^(?:https|ssh|file):\/\/|^[\w.-]+@[\w.-]+:/.test(address.trim())

/** The address a Project's card names: the tag says which kind it is, and its title the address itself. */
function LocationTag({ location }: { location: ProjectLocation }) {
  const { t } = usePanel()
  const address = location.type === 'folder' ? location.path : location.type === 'repo' ? location.url ?? location.path ?? '' : ''
  return <Tag tone="neutral" title={address || undefined}>{t(`projectLocation.${location.type}`)}</Tag>
}
/** Whether the Project is the built-in workspace, which is fixed in place: it can be neither archived nor renamed. */
const fixedProject = (project: Pick<ProjectRecord, 'value'>): boolean => project.value.kind === 'workspace'

/** One Project's card: its name and address, its counts and latest activity, its sections, and its conversation. */
function ProjectCard({ project, onDeleted }: { project: ProjectRow; onDeleted: () => Promise<unknown> }) {
  const { t, navigate, notify, openProjectConversation, deleteProject } = usePanel()
  const conversation = useAction(() => openProjectConversation({ id: project.id, name: project.name,
    conversationDir: project.conversationDir, conversationGeneration: project.conversationGeneration }))
  const remove = async () => {
    await deleteProject({ id: project.id, name: project.name, conversationDir: project.conversationDir,
      conversationGeneration: project.conversationGeneration })
    notify(t('projectDeleted', { name: project.name }))
    await onDeleted()
  }
  const open = (segment?: ProjectSegment) => navigate({ page: 'workstations', id: project.id, ...segment ? { query: { segment } } : {} })
  return <section className="dt-card dt-project-card" aria-label={project.name}>
    <div className="dt-card-head">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <button type="button" className="dt-textlink dt-project-title" onClick={() => open()}>{project.name}</button>
          <LocationTag location={project.location} />
          {project.kind === 'workspace' && <Tag tone="quiet" title={t('projectWorkspaceFixed')}>{t('projectFixed')}</Tag>}
          {project.status === 'archived' && <Tag tone="neutral">{t('projectArchived')}</Tag>}
        </div>
        <div className="dt-row-meta">
          <LabelValue label={t('projectSources')} value={project.sources.length} />
          <LabelValue label={t('projectOpenTickets')} value={project.openTickets} />
          <LabelValue label={t('projectArtifacts')} value={project.artifacts} />
          {project.lastActivity && <LabelValue label={t('projectActivity')} value={<When at={project.lastActivity} />} />}
        </div>
      </div>
      {project.kind !== 'workspace' && <ConfirmButton variant="ghost" icon="trash" label="" ariaLabel={t('projectDelete')}
        title={t('projectDeleteTitle')} message={t('projectDeleteConfirm', { name: project.name })}
        onConfirm={remove} />}
    </div>
    {project.reporter && <p className="dt-row-meta"><LabelValue label={t('projectReporter')} value={actorName(t, project.reporter)} /></p>}
    <div className="dt-project-segments">
      {PROJECT_SEGMENTS.map(segment => <Button key={segment} variant="outline" size="sm"
        onClick={() => open(segment)}>{t(`projectSegment.${segment}`)}</Button>)}
      <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={conversation.busy}
        onClick={() => { void conversation.run() }}>{t('projectConversation')}</Button>
    </div>
  </section>
}

/** The form a person creates a workstation with: a name and the kind of address its deliverables live at. */
function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void
  onCreated: (project: ProjectRecord) => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [name, setName] = useState('')
  const [type, setType] = useState<NewProject['location']['type']>('managed')
  const [address, setAddress] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const reset = () => { setName(''); setType('managed'); setAddress(''); setBranch(''); setError(undefined) }
  const close = () => { reset(); onClose() }
  const location = (): NewProject['location'] => type === 'managed' ? { type: 'managed' }
    : type === 'folder' ? { type: 'folder', path: address.trim() }
    : repositoryAddress(address) ? { type: 'repo', url: address.trim(), ...branch.trim() ? { branch: branch.trim() } : {} }
    : { type: 'repo', path: address.trim(), ...branch.trim() ? { branch: branch.trim() } : {} }
  const complete = !!name.trim() && (type === 'managed' || !!address.trim())
  const submit = async () => {
    setBusy(true); setError(undefined)
    try {
      const { project } = await call('POST projects', { body: { name: name.trim(), location: location() } })
      notify(t('projectCreated', { name: project.value.name }))
      reset()
      await onCreated(project)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <Modal open={open} onClose={close} title={t('projectAddTitle')} closeLabel={t('close')} description={t('projectAddHint')}
    footer={<>
      <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || !complete} onClick={() => { void submit() }}>{t('projectCreate')}</Button>
    </>}>
    <div className="dt-project-form">
      <label className="dt-field"><span className="dt-field-head">{t('projectName')}</span>
        <span className="dt-input"><input aria-label={t('projectName')} value={name} onChange={event => setName(event.target.value)} /></span>
      </label>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={t('projectLocationType')} value={type}
        options={(['managed', 'folder', 'repo'] as const).map(value => ({ value, label: t(`projectLocation.${value}`) }))}
        onChange={next => { setType(next); setError(undefined) }} />
      {type !== 'managed' && <label className="dt-field">
        <span className="dt-field-head">{t(type === 'repo' ? 'projectRepoAddress' : 'projectPath')}<InfoTip text={t('projectAddressHint')} /></span>
        <span className="dt-input"><input aria-label={t(type === 'repo' ? 'projectRepoAddress' : 'projectPath')} value={address}
          spellCheck={false} onChange={event => setAddress(event.target.value)} /></span>
      </label>}
      {type === 'repo' && <label className="dt-field"><span className="dt-field-head">{t('projectBranch')}</span>
        <span className="dt-input"><input aria-label={t('projectBranch')} value={branch} spellCheck={false}
          onChange={event => setBranch(event.target.value)} /></span>
      </label>}
      {error && <p className="dt-error" role="alert">{error}</p>}
    </div>
  </Modal>
}

/** The 工作站 page: every Project as a card, the built-in workspace first, with the actions that create and filter them. */
function ProjectList() {
  const { t, call, navigate } = usePanel()
  const [archived, setArchived] = useState(false)
  const [adding, setAdding] = useState(false)
  const { data, error, reload } = usePoll(async () => {
    const active = await call('GET projects', { query: { status: 'active' } })
    const hidden = archived ? await call('GET projects', { query: { status: 'archived' } }) : []
    return [...active, ...hidden]
  }, [archived])
  const onlyWorkspace = !!data && data.every(project => project.kind === 'workspace')
  return <div className="dt-form">
    <div className="dt-status-head">
      <h2 className="dt-status-title">{t('tab.workstations')}<InfoTip text={t('projectIntro')} /></h2>
      <span className="dt-status-actions">
        <Button variant="ghost" size="sm" onClick={() => setArchived(!archived)}>{t(archived ? 'projectHideArchived' : 'projectShowArchived')}</Button>
        <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setAdding(true)}>{t('projectAdd')}</Button>
      </span>
    </div>
    <LoadState error={error} loading={!data} />
    {data && data.length > 0 && <div className="dt-project-grid">
      {data.map(project => <ProjectCard key={project.id} project={project} onDeleted={reload} />)}
    </div>}
    {onlyWorkspace && <div className="dt-empty">
      <Hint>{t('projectEmpty')}</Hint>
      <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setAdding(true)}>{t('projectAddFirst')}</Button>
    </div>}
    <NewProjectDialog open={adding} onClose={() => setAdding(false)}
      onCreated={async project => { setAdding(false); await reload(); navigate({ page: 'workstations', id: project.id }) }} />
  </div>
}

/** The rows of a section's first page plus the further pages a person asked for. */
function useMore<T>(first: { items: T[]; next_offset: number | null },
  load: (offset: number) => Promise<{ items: T[]; next_offset: number | null }>) {
  const [more, setMore] = useState<{ items: T[]; next: number | null }>()
  const next = more ? more.next : first.next_offset
  const loadMore = async () => {
    if (next === null) return
    const page = await load(next)
    setMore(current => ({ items: [...current?.items ?? [], ...page.items], next: page.next_offset }))
  }
  return { items: [...first.items, ...(more?.items ?? [])], next, loadMore }
}

/** The Sources of a Project: the ones it names, the latest Trigger of each, and the toggle that links or unlinks one. */
function ProjectSources({ data, reload }: { data: ProjectDetailView; reload: () => Promise<unknown> }) {
  const { t, call, notify, navigate } = usePanel()
  const [busy, setBusy] = useState<string>()
  const linked = data.sources.filter(source => source.linked)
  const toggle = async (source: ProjectSourceRow) => {
    const sourceIds = data.sources.filter(item => item.id === source.id ? !source.linked : item.linked).map(item => item.id)
    setBusy(source.id)
    try { await call('PATCH projects/:id', { id: data.project.id, body: { sourceIds } }); notify(t('saved')); await reload() }
    catch (failure) { notify(errorText(failure)) } finally { setBusy(undefined) }
  }
  return <Section title={t('projectSegment.sources')} count={linked.length} hint={t('projectLinkHint')}>
    {data.sources.length ? <ul className="dt-list">{data.sources.map(source => {
      const mark = sourceMark(t, source.state)
      return <li key={source.id} className="dt-row"><Dot state={mark.dot} label={mark.label} /><div className="dt-row-main">
        <div className="dt-row-title">
          <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'source', id: source.id })}>
            {localized(t, source.title)}
          </button>
          {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
        </div>
        <div className="dt-row-meta">
          <span className="dt-status-text" data-state={mark.dot}>{mark.label}</span>
          {source.lastAt && <LabelValue label={t('projectSourceLast')} value={<When at={source.lastAt} />} />}
          <Pill active={source.linked} onClick={() => { if (busy !== source.id) void toggle(source) }}>
            {t(source.linked ? 'projectSourceLinked' : 'projectSourceLink')}
          </Pill>
        </div>
      </div></li>
    })}</ul> : <Hint>{t('projectSourceNone')}</Hint>}
  </Section>
}

/** The Threads of a Project, by the rows the Trigger page uses. */
function ProjectThreads({ id, first }: { id: string; first: ProjectDetailView['threads'] }) {
  const { t, call } = usePanel()
  const { items, next, loadMore } = useMore<ThreadRow>(first, offset => call('GET projects/:id/threads', { id, query: { filter: 'all', offset } }))
  return <Section title={t('projectSegment.triggers')} count={first.total}>
    {items.length ? <ul className="dt-list">{items.map(thread => <ThreadLine key={thread.key} thread={thread} />)}</ul>
      : <Hint>{t('projectThreadsNone')}</Hint>}
    {next !== null && <LoadMore onMore={() => { void loadMore() }} />}
  </Section>
}

/** The Decisions of a Project's Threads, by the rows the Eval page uses. */
function ProjectDecisions({ id, first }: { id: string; first: ProjectDetailView['decisions'] }) {
  const { t, call } = usePanel()
  const { items, next, loadMore } = useMore<DecisionRow>(first, offset => call('GET projects/:id/decisions', { id, query: { offset } }))
  return <Section title={t('projectSegment.decisions')}>
    {items.length ? <ul className="dt-list">{items.map(decision => <DecisionLine key={decision.id} decision={decision} detail />)}</ul>
      : <Hint>{t('projectDecisionsNone')}</Hint>}
    {next !== null && <LoadMore onMore={() => { void loadMore() }} />}
  </Section>
}

/** The Tickets of a Project, by the rows the Execution page uses. */
function ProjectTickets({ id, first }: { id: string; first: ProjectDetailView['tickets'] }) {
  const { t, call } = usePanel()
  const { items, next, loadMore } = useMore<TicketRow>(first, offset => call('GET projects/:id/tickets', { id, query: { offset } }))
  return <Section title={t('projectSegment.tickets')} count={first.total}>
    {items.length ? <ul className="dt-list">{items.map(ticket => <TicketLine key={ticket.id} ticket={ticket} />)}</ul>
      : <Hint>{t('projectTicketsNone')}</Hint>}
    {next !== null && <LoadMore onMore={() => { void loadMore() }} />}
  </Section>
}

/** A Project's settings: its name and aliases, the directories fixed when it was created, and its archive state. */
function ProjectSettings({ project, reload }: { project: ProjectRecord; reload: () => Promise<unknown> }) {
  const { t, call, notify } = usePanel()
  const fixed = fixedProject(project)
  const [name, setName] = useState(project.value.name)
  const [aliases, setAliases] = useState(project.value.aliases.join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const save = async () => {
    const body: ProjectPatch = {}
    if (!fixed && name.trim() && name.trim() !== project.value.name) body.name = name.trim()
    const parsed = aliases.split(',').map(alias => alias.trim()).filter(Boolean)
    if (parsed.join('\u0000') !== project.value.aliases.join('\u0000')) body.aliases = parsed
    if (!Object.keys(body).length) return
    setBusy(true); setError(undefined)
    try { await call('PATCH projects/:id', { id: project.id, body }); notify(t('saved')); await reload() }
    catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <Section title={t('projectSegment.settings')} hint={t('projectSettingsHint')}>
    <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="dt-field"><span className="dt-field-head">{t('projectName')}</span>
        <span className="dt-input"><input aria-label={t('projectName')} value={name} disabled={fixed}
          onChange={event => setName(event.target.value)} /></span>
      </label>
      <label className="dt-field"><span className="dt-field-head">{t('projectAliases')}<InfoTip text={t('projectAliasesHint')} /></span>
        <span className="dt-input"><input aria-label={t('projectAliases')} value={aliases}
          onChange={event => setAliases(event.target.value)} /></span>
      </label>
      <Section title={t('projectDirs')} hint={t('projectDirsFixed')}>
        <KeyValues rows={[[t('projectOutputDir'), project.value.outputDir], [t('projectScratchDir'), project.value.scratchDir],
          [t('projectRulesDir'), project.value.rulesDir]]} />
      </Section>
      {fixed && <Hint>{t('projectWorkspaceFixed')}</Hint>}
      {error && <p className="dt-error" role="alert">{error}</p>}
      <div className="dt-row-buttons">
        <Button variant="primary" size="sm" type="submit" disabled={busy}>{t('save')}</Button>
      </div>
    </form>
  </Section>
}

/** Most rules a Project's agent may be given, and the most one may say; the host refuses more. */
const AGENT_RULES_MAX = 50
const AGENT_RULE_MAX_LENGTH = 2000
/**
 * The agent section of a Project: the requirements and rules its conversations and its Tickets' workers follow, edited as a
 * list and saved together. The Tickets, artifacts and reports have their own pages.
 */
function ProjectAgent({ project, reload }: { project: ProjectRecord; reload: () => Promise<unknown> }) {
  const { t, call, notify } = usePanel()
  const saved = project.value.agentRules ?? []
  const [rules, setRules] = useState<string[]>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // The host trims and drops repetitions too; the page compares what it would save with what it read.
  const normalized = [...new Set(rules.map(rule => rule.trim()).filter(Boolean))]
  const dirty = JSON.stringify(normalized) !== JSON.stringify(saved)
  const set = (index: number, text: string) => setRules(rules.map((rule, position) => position === index ? text : rule))
  const save = async () => {
    setBusy(true); setError(undefined)
    try {
      await call('PATCH projects/:id', { id: project.id, body: { agentRules: normalized } })
      setRules(normalized)
      notify(t('saved'))
      await reload()
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <>
    <Section title={t('projectAgentRulesTitle')} hint={t('projectAgentRulesHint')}>
      <p className="dt-hint">{t('projectAgentRulesIntro')}</p>
      {rules.length === 0 ? <Hint>{t('projectAgentRulesNone')}</Hint> : <div className="dt-form" role="list">
        {rules.map((rule, index) => {
          const number = index + 1
          return <div className="dt-field" role="listitem" key={index}>
            <span className="dt-field-head">{t('projectAgentRuleItem', { number })}</span>
            <textarea className="dt-textarea" rows={2} maxLength={AGENT_RULE_MAX_LENGTH} spellCheck={false}
              aria-label={t('projectAgentRuleItem', { number })} value={rule}
              onChange={event => set(index, event.target.value)} />
            <div className="dt-row-buttons">
              <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('projectAgentRuleRemove', { number })}
                onClick={() => setRules(rules.filter((_, position) => position !== index))}>{t('remove')}</Button>
            </div>
          </div>
        })}
      </div>}
      {error && <p className="dt-error" role="alert">{error}</p>}
      <div className="dt-rules-actions">
        <Button variant="outline" size="sm" icon={<Icon name="plus" />} disabled={rules.length >= AGENT_RULES_MAX}
          onClick={() => setRules([...rules, ''])}>{t('projectAgentRulesAdd')}</Button>
        <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => { void save() }}>{t('save')}</Button>
      </div>
    </Section>
  </>
}

/** One Project's page: its counts and archive state, the button that opens its conversation, then the section the route names. */
function ProjectDetailPage({ id, segment = 'sources' }: { id: string; segment?: ProjectSegment }) {
  const { t, call, navigate, notify, openProjectConversation, deleteProject, resetProjectConversation } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET projects/:id', { id }), [id])
  const openConversation = useAction(() => data ? openProjectConversation({ id: data.project.id,
    name: data.project.value.name, conversationDir: data.conversationDir, conversationGeneration: data.conversationGeneration })
    : Promise.resolve(), { reload })
  // Deleting the conversation starts it over: the old Session is archived and the next open names a new one by generation.
  const removeConversation = async () => {
    if (!data) return
    await resetProjectConversation({ id: data.project.id, name: data.project.value.name,
      conversationDir: data.conversationDir, conversationGeneration: data.conversationGeneration })
    notify(t('projectConversationDeleted'))
    await reload()
  }
  // A deleted Project leaves the page for the list; its conversation is archived best effort by the panel entry. A refusal
  // (the Project still owns work) is reported by the confirmation dialog, which stays open so a person can act on it.
  const remove = async () => {
    if (!data) return
    await deleteProject({ id: data.project.id, name: data.project.value.name, conversationDir: data.conversationDir,
      conversationGeneration: data.conversationGeneration })
    notify(t('projectDeleted', { name: data.project.value.name }))
    navigate({ page: 'workstations' })
  }
  if (!data) return <div className="dt-form"><PageHead title={id} /><LoadState error={error} loading={!error} /></div>
  const { project, counts } = data
  const fixed = fixedProject(project)
  const go = (next: ProjectSegment) => navigate({ page: 'workstations', id, ...next !== 'sources' ? { query: { segment: next } } : {} }, true)
  const setArchived = async (archived: boolean) => {
    await call('PATCH projects/:id', { id, body: { archived } })
    notify(t(archived ? 'projectArchivedDone' : 'projectRestoredDone', { name: project.value.name }))
    await reload()
  }
  const segments = PROJECT_SEGMENTS.map(value => ({ value, label: value === 'sources' ? `${t('projectSegment.sources')} ${data.sources.filter(source => source.linked).length}`
    : value === 'triggers' ? `${t('projectSegment.triggers')} ${counts.threads}`
    : value === 'decisions' ? `${t('projectSegment.decisions')} ${counts.decisions}`
    : value === 'tickets' ? `${t('projectSegment.tickets')} ${counts.tickets}` : t(`projectSegment.${value}`) }))
  return <div className="dt-form">
    <PageHead title={project.value.name}>
      <LocationTag location={project.value.location} />
      {project.status === 'archived' && <Tag tone="neutral">{t('projectArchived')}</Tag>}
      <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={openConversation.busy}
        onClick={() => { void openConversation.run() }}>{t('projectConversationOpen')}</Button>
      <ConfirmButton variant="outline" icon="trash" label={t('projectConversationDelete')}
        title={t('projectConversationDeleteTitle')}
        message={t('projectConversationDeleteConfirm', { name: project.value.name })} onConfirm={removeConversation} />
      {!fixed && (project.status === 'archived'
        ? <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
          onClick={() => { void setArchived(false).catch(failure => notify(errorText(failure))) }}>{t('projectRestore')}</Button>
        : <ConfirmButton variant="outline" icon="stop" label={t('projectArchive')} title={t('projectArchiveTitle')}
          message={t('projectArchiveConfirm', { name: project.value.name })} onConfirm={() => setArchived(true)} />)}
      {!fixed && <ConfirmButton variant="outline" icon="trash" label={t('projectDelete')} title={t('projectDeleteTitle')}
        message={t('projectDeleteConfirm', { name: project.value.name })} onConfirm={remove} />}
    </PageHead>
    <div className="dt-row-meta">
      <LabelValue label={t('projectOpenTickets')} value={counts.openTickets} />
      <LabelValue label={t('projectTickets')} value={counts.tickets} />
      <LabelValue label={t('projectArtifacts')} value={<button type="button" className="dt-textlink"
        onClick={() => navigate({ page: 'artifacts', query: { project: project.id } })}>{counts.artifacts}</button>} />
      <InfoTip text={t('projectDetailIntro')} />
    </div>
    <SegmentedControl label={t('projectSegmentLabel')} value={segment} options={segments} onChange={go} />
    {segment === 'sources' && <ProjectSources data={data} reload={reload} />}
    {segment === 'triggers' && <ProjectThreads id={id} first={data.threads} />}
    {segment === 'decisions' && <ProjectDecisions id={id} first={data.decisions} />}
    {segment === 'tickets' && <ProjectTickets id={id} first={data.tickets} />}
    {segment === 'settings' && <ProjectSettings project={project} reload={reload} />}
    {segment === 'agent' && <ProjectAgent project={project} reload={reload} />}
  </div>
}

/** The 工作站 page, or with a Project id, that Project's own page. */
export function ProjectPage({ id, segment }: { id?: string; segment?: ProjectSegment }) {
  return id === undefined ? <ProjectList /> : <ProjectDetailPage id={id} segment={segment} />
}
