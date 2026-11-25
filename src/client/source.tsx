/** 工单源 page: one card per Source instance with its last day and execution state, adding Sources, an instance's page with its configuration, and Project answer dialogs. */
import { useEffect, useState } from 'react'
import type { AnswerProject } from '../app/api.ts'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type PendingProject, type SourceDetailView, type SourceKindRow, type SourceStatusRow,
  type TicketRow } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Modal, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { setupPage, type Route } from './route.ts'
import { ConfigHistory, Fields, SettingsProvider, SourceField } from './settings-kit.tsx'
import { actorName, errorText, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, Hint, LabelValue, LoadState, PageHead, Section, SetupMessage, StatusHead, When } from './widgets.tsx'

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}

/** The last day's flow of one Source instance, in the Overview's wording. */
function SourceStats({ source }: { source: Pick<SourceStatusRow, 'stats24h'> }) {
  const { t } = usePanel()
  const { arrived, filtered, judged, accepted } = source.stats24h
  return <div className="dt-source-kpis">
    <LabelValue label={t('flowReceivedLabel')} value={arrived} /><LabelValue label={t('flowFilteredLabel')} value={filtered} />
    <LabelValue label={t('flowJudgedLabel')} value={judged} /><LabelValue label={t('sourceAcceptedLabel')} value={accepted} />
  </div>
}
/** What the instance's Tickets are doing: working, queued for a slot, or idle until a follow-up Trigger. */
function SourceExec({ source }: { source: Pick<SourceStatusRow, 'exec'> }) {
  const { t } = usePanel()
  const { working, queued, waiting } = source.exec
  return <div className="dt-source-kpis">
    <LabelValue label={t('sourceExecWorking')} value={working} /><LabelValue label={t('sourceExecQueued')} value={queued} />
    <LabelValue label={t('sourceExecWaiting')} value={waiting} />
  </div>
}
/** One Source instance's card: its title and switch, pending Tickets, the last day, the execution buckets, and Project questions. */
function SourceInstanceCard({ source, onOpen, onAnswer, onReload }: {
  source: SourceStatusRow; onOpen: () => void; onAnswer: (question: PendingProject) => void; onReload: () => Promise<unknown>
}) {
  const { t, call, notify, navigate } = usePanel()
  const { setup } = usePanelData()
  const { dot, label } = sourceMark(t, source.state)
  const [busy, setBusy] = useState(false)
  // Omit healthy parts and per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !source.problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try { await call('PATCH sources/:id', { id: source.id, body: { enabled } }); await onReload() }
    catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const title = localized(t, source.title)
  return <section className="dt-card dt-source-card" data-state={dot} aria-label={title}>
    <div className="dt-card-head">
      <div className="dt-row-main">
        <div className="dt-row-title">
          <Dot state={dot} label={label} />
          <button type="button" className="dt-textlink dt-source-title" onClick={onOpen}>{title}</button>
          <Tag tone="neutral">{source.kind}</Tag>
          {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
        </div>
        <div className="dt-row-meta"><span className="dt-status-text" data-state={dot}>{label}</span>
          {source.lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(source.lastAt, t('lang'))} />}</div>
      </div>
      {source.installed && <Switch checked={source.enabled} onChange={toggle} label={t('sourceEnable', { name: title })} />}
    </div>
    {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
    {source.problem && <p className="dt-error"><SetupMessage problem={source.problem} lead /> <button type="button"
      className="dt-textlink" onClick={() => navigate({ page: 'source', id: source.id })}>{t('sourceOpenSettings')}</button></p>}
    {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
      {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
        item)}</span>
    </p>)}
    <p className="dt-source-pending">{source.pending === 0 ? t('sourcePendingNone') : t('sourcePendingCount', { count: source.pending })}</p>
    <div className="dt-source-block">
      <h3 className="dt-source-label">{t('sourceLastDay')}</h3><SourceStats source={source} />
    </div>
    <div className="dt-source-block">
      <h3 className="dt-source-label">{t('sourceExecTitle')}</h3><SourceExec source={source} />
    </div>
    {source.pendingProjects.length > 0 && <div className="dt-source-unassigned">
      <button type="button" className="dt-textlink" onClick={() => onAnswer(source.pendingProjects[0]!)}>
        {t('sourceUnassigned', { count: source.pendingProjects.length })}
      </button>
      <span className="dt-hint dt-clamp">{readableMarkers(t, source.pendingProjects[0]!.preview) || t('empty')}</span>
    </div>}
    {source.filtered.length > 0 && <SourceFiltered items={source.filtered} />}
    {source.dropped.length > 0 && <DroppedReplies items={source.dropped} />}
    <div className="dt-row-buttons">
      <Button variant="outline" size="sm" onClick={onOpen}>{t('sourceOpen')}</Button>
      {busy && <span className="dt-hint" role="status">{t('loading')}</span>}
    </div>
  </section>
}

/** The folded list of Triggers one Source filtered out in the last day. */
function SourceFiltered({ items }: { items: SourceStatusRow['filtered'] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return <DisclosureRow icon={<Icon name="filter" />} title={<>{t('sourceFilteredTitle')} <span className="dt-count">{items.length}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <ul className="dt-list">{items.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
        className="dt-row-main">
        <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
          || t('empty')}</div>
        <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
      </div></li>)}</ul>
    </div>
  </DisclosureRow>
}

/** The newest Triggers one instance received. */
function SourceRecent({ source }: { source: Pick<SourceStatusRow, 'recent'> }) {
  const { t } = usePanel()
  if (!source.recent.length) return <Hint>{t('sourceRecentNone')}</Hint>
  return <ul className="dt-list">{source.recent.map(item => <li key={item.id} className="dt-row"><Dot state="idle" />
    <div className="dt-row-main">
      <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview) || t('empty')}</div>
      <div className="dt-row-meta"><When at={item.at} />{item.filtered && <Tag tone="neutral">{reasonLabel(t, item.filtered)}</Tag>}</div>
    </div></li>)}</ul>
}

const repositoryAddress = (address: string): boolean => /^(?:https|ssh|file):\/\/|^[\w.-]+@[\w.-]+:/.test(address.trim())

/** The dialog that answers a Trigger's Project question: an existing station, the agent's proposal, or a new station. */
function AnswerProjectDialog({ question, onClose, onAnswered }: {
  question: PendingProject; onClose: () => void; onAnswered: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  type Mode = 'existing' | 'proposal' | 'new'
  const modes: { value: Mode; label: string }[] = [
    ...question.candidates.length ? [{ value: 'existing' as const, label: t('sourceAnswerExisting') }] : [],
    ...question.proposal ? [{ value: 'proposal' as const, label: t('sourceAnswerProposal') }] : [],
    { value: 'new' as const, label: t('sourceAnswerNew') },
  ]
  const [mode, setMode] = useState<Mode>(question.proposal ? 'proposal' : question.candidates.length ? 'existing' : 'new')
  const [projectId, setProjectId] = useState(question.candidates[0]?.id ?? '')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const location = !address.trim() ? { type: 'managed' as const }
        : repositoryAddress(address) ? { type: 'repo' as const, url: address.trim() } : { type: 'folder' as const, path: address.trim() }
      const body: AnswerProject = mode === 'existing' ? { projectId }
        : mode === 'proposal' ? { confirmProposal: true } : { new: { name: name.trim(), location } }
      await call('POST triggers/:id/answer-project', { id: question.triggerId, body })
      notify(t('sourceAnswerDone'))
      await onAnswered()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const canSubmit = !busy && (mode !== 'existing' || !!projectId) && (mode !== 'new' || !!name.trim())
  return <Modal open onClose={onClose} title={t('sourceAnswerTitle')} closeLabel={t('close')} description={t('sourceAnswerHint')}
    footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={!canSubmit} onClick={() => { void submit() }}>{t('sourceAnswerSubmit')}</Button>
    </>}>
    <div className="dt-source-answer">
      <p className="dt-hint dt-clamp">{readableMarkers(t, question.preview) || question.thread}</p>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={t('sourceAnswerMode')} value={mode}
        options={modes} onChange={next => setMode(next)} />
      {mode === 'existing' && <label className="dt-field"><span className="dt-field-head">{t('sourceAnswerProject')}</span>
        <select className="dt-select" value={projectId} onChange={event => setProjectId(event.target.value)}>
          {question.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select></label>}
      {mode === 'proposal' && question.proposal && <p className="dt-hint">{t('sourceAnswerProposalText', { name: question.proposal.name,
        location: question.proposal.location.type === 'folder' ? question.proposal.location.path
          : question.proposal.location.type === 'repo' ? question.proposal.location.url ?? '' : t('sourceAnswerManaged') })}</p>}
      {mode === 'new' && <>
        <label className="dt-field"><span className="dt-field-head">{t('sourceAnswerName')}</span>
          <span className="dt-input"><input aria-label={t('sourceAnswerName')} value={name}
            onChange={event => setName(event.target.value)} /></span></label>
        <label className="dt-field"><span className="dt-field-head">{t('sourceAnswerAddress')}<InfoTip text={t('sourceAnswerAddressHint')} />
        </span><span className="dt-input"><input aria-label={t('sourceAnswerAddress')} value={address}
          onChange={event => setAddress(event.target.value)} /></span></label>
      </>}
    </div>
  </Modal>
}

/** One instance's own page: its configuration, last day, Tickets, filtered and dropped messages, recent Triggers, and Project questions. */
function SourceDetailPage({ id }: { id: string }) {
  const { t, call, navigate, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET sources/:id', { id }), [id])
  const [question, setQuestion] = useState<PendingProject>()
  const [extra, setExtra] = useState<{ items: TicketRow[]; next: number | null }>({ items: [], next: null })
  if (!data) return <div className="dt-form"><PageHead title={id} /><LoadState error={error} loading={!error} /></div>
  const { dot, label } = sourceMark(t, data.state)
  const toggle = (enabled: boolean) => {
    void call('PATCH sources/:id', { id, body: { enabled } }).then(reload, failure => notify(errorText(failure)))
  }
  const tickets = [...data.tickets.items, ...extra.items]
  const next = extra.next ?? data.tickets.next_offset
  const loadMore = async () => {
    if (next === null) return
    const page = await call('GET tickets', { query: { source: id, state: 'open', offset: next } })
    setExtra(current => ({ items: [...current.items, ...page.items], next: page.next_offset }))
  }
  return <div className="dt-form">
    <PageHead title={localized(t, data.title)}>
      <span className="dt-status-text" data-state={dot}>{label}</span>
      {data.installed
        ? <Switch checked={data.enabled} onChange={toggle} label={t('sourceEnable', { name: localized(t, data.title) })} />
        : <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
    </PageHead>
    {data.problem && <p className="dt-error"><SetupMessage problem={data.problem} lead /> {data.problem.place === 'deployment'
      && <button type="button" className="dt-textlink" onClick={() => navigate(setupPage(data.problem!.place))}>{t('setupFixLink')}</button>}
      <CheckSetupButton /></p>}
    {data.installed && <SourceConfigForm source={data} reload={reload} />}
    {data.installed && <SettingsProvider><ConfigHistory blocks={[`source:${id}`]} /></SettingsProvider>}
    <Section title={t('sourceLastDay')}><SourceStats source={data} /></Section>
    <Section title={t('sourceExecTitle')}><SourceExec source={data} /></Section>
    <Section title={t('sourceTickets')} count={data.tickets.total}>
      {tickets.length ? <ul className="dt-list">{tickets.map(ticket => <TicketLine key={ticket.id} ticket={ticket} />)}</ul>
        : <Hint>{t('sourceTicketsNone')}</Hint>}
      {next !== null && <Button variant="outline" size="sm" onClick={() => { void loadMore() }}>{t('loadMore')}</Button>}
    </Section>
    <SourceFiltered items={data.filtered} />
    {data.dropped.length > 0 && <DroppedReplies items={data.dropped} />}
    <Section title={t('sourceRecent')}><SourceRecent source={data} /></Section>
    {data.pendingProjects.length > 0 && <Section title={t('sourceUnassignedTitle')} count={data.pendingProjects.length}>
      <ul className="dt-list">{data.pendingProjects.map(item => <li key={item.triggerId} className="dt-row">
        <Dot state="warning" /><div className="dt-row-main">
          <div className="dt-row-title">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta"><When at={item.at} />
            <Button variant="outline" size="sm" onClick={() => setQuestion(item)}>{t('sourceAnswer')}</Button></div>
        </div></li>)}</ul>
    </Section>}
    {question && <AnswerProjectDialog question={question} onClose={() => setQuestion(undefined)}
      onAnswered={async () => { setQuestion(undefined); setExtra({ items: [], next: null }); await reload() }} />}
  </div>
}

/** One instance's configuration form, saved as its own settings block against the revision the page read. */
function SourceConfigForm({ source, reload }: { source: SourceDetailView; reload: () => Promise<unknown> }) {
  const { t, call, notify } = usePanel()
  const { running, state } = usePanelData()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const refreshLabels = async () => {
    const { added } = await call('POST sources/:id/labels', { id: source.id }); await reload(); return added
  }
  const draft = useDraft({
    key: `dsh-superagent/draft/${state?.masterId ?? ''}/source:${source.id}`,
    saved: source.value, revision: source.revision, reload,
    save: async (value, from) => {
      const result = await call('PUT settings/:block', { block: `source:${source.id}`, body: { value, revision: from } })
      notify(t(result.restarting ? 'savedRestarting' : 'saved'))
      return result
    },
  })
  const value = draft.value
  const changed = (key: string) => String(value.config[key] ?? '') !== String(source.value.config[key] ?? '')
  const restarts = draft.dirty && source.restarts.some(changed)
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]}
    saved={source.value.config[spec.key]} labels={source.labels} refreshLabels={refreshLabels}
    fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const advanced = source.fields.filter(spec => spec.advanced)
  return <form className="dt-card" id={`dt-source-${source.id}`} onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">
        <span className="dt-card-title">{t('sourceConfigTitle')}</span>
        <InfoTip text={localized(t, source.description)} />
      </div></div></div>
      {source.fields.filter(spec => !spec.advanced).map(field)}
      {advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}><div className="dt-disclosure-body">{advanced.map(field)}</div></DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

/** The form a person adds a Source with: its kind, an optional key and label, and the kind's fields. */
function AddSourceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [kinds, setKinds] = useState<SourceKindRow[]>()
  const [kind, setKind] = useState('')
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setKind(''); setKey(''); setLabel(''); setConfig({})
    call('GET source-kinds').then(setKinds, failure => notify(errorText(failure)))
  }, [open, call, notify])
  const selected = kinds?.find(item => item.kind === kind)
  const submit = async () => {
    setBusy(true)
    try {
      await call('POST sources', { body: { kind, ...key.trim() ? { key: key.trim() } : {}, ...label.trim() ? { label: label.trim() } : {},
        config } })
      notify(t('sourceAdded', { name: label.trim() || key.trim() || kind }))
      await onCreated()
      onClose()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <Modal open={open} onClose={onClose} title={t('sourceAddTitle')} closeLabel={t('close')} description={t('sourceAddHint')}
    footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || !selected} onClick={() => { void submit() }}>{t('sourceAdd')}</Button>
    </>}>
    <div className="dt-source-answer">
      <label className="dt-field"><span className="dt-field-head">{t('sourceKind')}</span>
        <select className="dt-select" aria-label={t('sourceKind')} value={kind}
          onChange={event => { setKind(event.target.value); setConfig(kinds?.find(item => item.kind === event.target.value)?.defaults ?? {}) }}>
          <option value="" disabled>{t('sourceKindChoose')}</option>
          {(kinds ?? []).map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
        </select></label>
      <label className="dt-field"><span className="dt-field-head">{t('sourceKey')}<InfoTip text={t('sourceKeyHint')} /></span>
        <span className="dt-input"><input aria-label={t('sourceKey')} value={key} placeholder="ops" spellCheck={false}
          onChange={event => setKey(event.target.value)} /></span></label>
      <label className="dt-field"><span className="dt-field-head">{t('sourceLabel')}</span>
        <span className="dt-input"><input aria-label={t('sourceLabel')} value={label}
          onChange={event => setLabel(event.target.value)} /></span></label>
      {selected?.fields.map(field => <SourceField key={field.key} field={field} value={config[field.key]}
        saved={selected.defaults[field.key]} labels={{}} fact={undefined}
        onChange={next => setConfig(current => ({ ...current, [field.key]: next }))} />)}
    </div>
  </Modal>
}

/** The 工单源 page: every instance as a card, with the action that adds one. */
function SourceList() {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET sources'), [])
  const [adding, setAdding] = useState(false)
  const [question, setQuestion] = useState<PendingProject>()
  const add = <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setAdding(true)}>{t('sourceAdd')}</Button>
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} action={add} />
    {data && data.length > 0 && <div className="dt-source-grid">
      {data.map(source => <SourceInstanceCard key={source.id} source={source} onOpen={() => navigate({ page: 'source', id: source.id })}
        onAnswer={setQuestion} onReload={reload} />)}
    </div>}
    <LoadState error={error} loading={!data} />
    {data && data.length === 0 && <div className="dt-empty">
      <Hint>{t('sourceEmpty')}</Hint>
      <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setAdding(true)}>{t('sourceAddFirst')}</Button>
    </div>}
    <AddSourceDialog open={adding} onClose={() => setAdding(false)} onCreated={reload} />
    {question && <AnswerProjectDialog question={question} onClose={() => setQuestion(undefined)}
      onAnswered={async () => { setQuestion(undefined); await reload() }} />}
  </div>
}

/** The 工单源 page or, with an instance id, that instance's own page. */
export function SourcePage({ id }: { id?: string }) {
  return id === undefined ? <SourceList /> : <SourceDetailPage id={id} />
}
