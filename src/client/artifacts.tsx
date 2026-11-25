/**
 * 产物 (artifacts) page: the global index of delivered files with its Project, Source and text filters, and one artifact's
 * page with its metadata, where it was delivered, and the reverse chain from it back to its Ticket, Assignment and worker
 * Session.
 */
import { useState, type FormEvent } from 'react'
import type { ArtifactDetailView, ArtifactRow } from './api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, InfoTip, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { actorName, errorText, localized, valueLabel, type T } from './text.ts'
import { Hint, KeyValues, LabelValue, LoadMore, LoadState, PageHead, Section, SessionButton, When } from './widgets.tsx'

/** The filters the artifact list keeps in its route, so a filtered page survives a remount and can be linked to. */
export interface ArtifactQuery { project?: string; source?: string; q?: string }
const compact = (query: ArtifactQuery): ArtifactQuery | undefined => {
  const entries = Object.entries(query).filter(([, value]) => !!value)
  return entries.length ? Object.fromEntries(entries) as ArtifactQuery : undefined
}
/** A file size as the panel shows it: bytes, or the next unit up once the number passes a thousand of them. */
export function sizeText(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
/** The stage a Ticket is in, in the panel's words, from the stage and action the artifact page reports. */
function stageText(t: T, ticket: ArtifactDetailView['ticket']): string {
  if (!ticket) return ''
  return ticket.state === 'ended' ? t('ticket.ended') : valueLabel(t, 'stage', ticket.action ?? ticket.stage)
}

/** The artifact list's filters: the Project (the built-in workspace first) and Source instance, and a name or hash search. */
function ArtifactFilters({ query, onFilter }: { query: ArtifactQuery; onFilter: (next: ArtifactQuery) => void }) {
  const { t, call } = usePanel()
  const [search, setSearch] = useState(query.q ?? '')
  const { data } = usePoll(async () => {
    const [projects, sources] = await Promise.all([call('GET projects', { query: { status: 'active' } }), call('GET sources')])
    return { projects, sources }
  }, [])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onFilter({ q: search.trim() || undefined })
  }
  return <form className="dt-filters" role="search" onSubmit={submit}>
    <select className="dt-select dt-inline-select" aria-label={t('artifactFilterProject')} value={query.project ?? ''}
      onChange={event => onFilter({ project: event.target.value || undefined })}>
      <option value="">{t('artifactAllProjects')}</option>
      {data?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    <select className="dt-select dt-inline-select" aria-label={t('artifactFilterSource')} value={query.source ?? ''}
      onChange={event => onFilter({ source: event.target.value || undefined })}>
      <option value="">{t('artifactAllSources')}</option>
      {data?.sources.map(source => <option key={source.id} value={source.id}>{localized(t, source.title)}</option>)}
    </select>
    <Input type="search" value={search} placeholder={t('artifactSearchPlaceholder')} aria-label={t('artifactSearchLabel')}
      onChange={event => setSearch(event.target.value)} />
    {query.q && <Button variant="ghost" size="sm" onClick={() => { setSearch(''); onFilter({ q: undefined }) }}>{t('artifactClearSearch')}</Button>}
  </form>
}

/** One row of the index: its file, the Project, Source and Ticket behind it, and its download. */
function ArtifactLine({ row }: { row: ArtifactRow }) {
  const { t, download, navigate, notify } = usePanel()
  return <li className="dt-row dt-artifact-row">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <button type="button" className="dt-textlink dt-mono" onClick={() => navigate({ page: 'artifacts', id: row.id })}>{row.name}</button>
        {!row.deliverable && <Tag tone="warning">{t('artifactGone')}</Tag>}
      </div>
      <div className="dt-row-meta">
        <LabelValue label={t('artifactProject')} value={<button type="button" className="dt-textlink"
          onClick={() => navigate({ page: 'workstations', id: row.project })}>{row.projectName}</button>} />
        <LabelValue label={t('artifactSource')} value={<button type="button" className="dt-textlink"
          onClick={() => navigate({ page: 'source', id: row.source })}>{localized(t, row.sourceLabel)}</button>} />
        <LabelValue label={t('artifactTicket')} value={<button type="button" className="dt-textlink"
          onClick={() => navigate({ page: 'execution', id: row.ticket })}>{row.ticketTitle}</button>} />
        <span title={row.hash}>{sizeText(row.size)}</span>
        <When at={row.at} />
      </div>
    </div>
    <div className="dt-row-actions">
      <Button variant="outline" size="sm" icon={<Icon name="download" size={14} />} disabled={!row.deliverable}
        onClick={() => { void download({ id: row.id, name: row.name }).catch(failure => notify(errorText(failure))) }}>
        {t('artifactDownload')}
      </Button>
    </div>
  </li>
}

/** The index: total count, the filters, one page of artifacts, and the empty state that explains how artifacts appear. */
function ArtifactList({ query }: { query: ArtifactQuery }) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error } = usePoll(() => call('GET artifacts', {
    query: { project: query.project, source: query.source, q: query.q, limit } }), [query.project, query.source, query.q, limit])
  const filtered = !!(query.project || query.source || query.q)
  const filter = (next: ArtifactQuery) => {
    setLimit(20)
    const merged = compact({ ...query, ...next })
    navigate(merged ? { page: 'artifacts', query: merged } : { page: 'artifacts' }, true)
  }
  const clear = () => { setLimit(20); navigate({ page: 'artifacts' }, true) }
  return <div className="dt-form">
    <div className="dt-status-head">
      <h2 className="dt-status-title">{t('tab.artifacts')}<InfoTip text={t('artifactIntro')} /></h2>
      <span className="dt-status-actions">{data && <span className="dt-count">{t('artifactCount', { count: data.total })}</span>}</span>
    </div>
    <ArtifactFilters key={query.q ?? ''} query={query} onFilter={filter} />
    <LoadState error={error} loading={!data} />
    {data && (data.items.length
      ? <ul className="dt-list">{data.items.map(row => <ArtifactLine key={row.id} row={row} />)}</ul>
      : <div className="dt-empty">
        <Hint>{filtered ? t('artifactFilterNone') : t('artifactEmpty')}</Hint>
        {filtered && <Button variant="outline" size="sm" onClick={clear}>{t('artifactClearFilters')}</Button>}
      </div>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </div>
}

/** What one artifact was delivered from: its file, the reply that carried it, and where it landed. */
function ArtifactDelivery({ data }: { data: ArtifactDetailView }) {
  const { t } = usePanel()
  return <Section title={t('artifactDeliveryTitle')} hint={t('artifactDeliveryHint')}>
    <KeyValues rows={[
      [t('artifactPath'), <span className="dt-mono">{data.delivery.path}</span>],
      [t('artifactReadable'), data.delivery.exists ? t('artifactReadableYes') : t('artifactGone')],
      [t('artifactMessageId'), data.delivery.messageId ? <span className="dt-mono">{data.delivery.messageId}</span> : t('empty')],
    ]} />
  </Section>
}
/** The chain from the artifact back to its Ticket, the Assignment that ran, and that Ticket's worker Session. */
function ArtifactChain({ data }: { data: ArtifactDetailView }) {
  const { t, navigate } = usePanel()
  const { ticket, assignment, links } = data
  return <Section title={t('artifactChain')} hint={t('artifactChainHint')}>
    {ticket ? <ul className="dt-list">
      <li className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title"><span className="dt-count">1</span>{t('term.ticket')}{t('labelSeparator')}
            <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button>
          </div>
          <div className="dt-row-meta">
            <span>{stageText(t, ticket)}</span>
            <LabelValue label={t('artifactReporter')} value={ticket.reporter ? actorName(t, ticket.reporter) : t('empty')} />
            {ticket.mentions?.length ? <LabelValue label={t('artifactMentions')} value={ticket.mentions.map(person => person.name ?? person.id)
              .join(t('listSeparator'))} /> : null}
            {links.thread && <Button variant="ghost" size="sm" onClick={() => navigate({ page: 'trigger', id: links.thread! })}>
              {t('artifactOpenThread')}</Button>}
          </div>
        </div>
      </li>
      <li className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title"><span className="dt-count">2</span>{t('term.assignment')}{assignment ? t('labelSeparator') + assignment.id : ''}</div>
          {assignment ? <div className="dt-row-meta">
            <span>{valueLabel(t, 'assignment', assignment.state)}</span>
            {assignment.report && <span>{valueLabel(t, 'report', assignment.report.state)}{t('labelSeparator')}{assignment.report.summary}</span>}
            {assignment.startedAt && <LabelValue label={t('artifactStartedAt')} value={<When at={assignment.startedAt} />} />}
          </div> : <Hint>{t('artifactNoAssignment')}</Hint>}
        </div>
      </li>
      <li className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title"><span className="dt-count">3</span>{t('artifactWorkerSession')}{data.workerSessionId
            ? t('labelSeparator') + data.workerSessionId : ''}</div>
          {data.workerSessionId
            ? <div className="dt-row-actions"><SessionButton sessionId={data.workerSessionId} variant="outline" /></div>
            : <Hint>{t('artifactNoWorker')}</Hint>}
        </div>
      </li>
    </ul> : <Hint>{t('artifactNoTicket')}</Hint>}
  </Section>
}

/** One artifact's page: its file's metadata, where it landed and the reply that carried it, and its reverse chain. */
function ArtifactDetailPage({ id }: { id: string }) {
  const { t, call, navigate, download, notify } = usePanel()
  const { data, error } = usePoll(() => call('GET artifacts/:id', { id }), [id])
  if (!data) return <div className="dt-form"><PageHead title={t('term.artifact')} /><LoadState error={error} loading={!error} /></div>
  const { artifact, project, source, ticket } = data
  const copy = () => {
    navigator.clipboard.writeText(data.delivery.path).then(() => notify(t('copied')), failure => notify(errorText(failure)))
  }
  return <div className="dt-form">
    <PageHead title={<span className="dt-mono">{artifact.name}</span>}>
      <Button variant="primary" size="sm" icon={<Icon name="download" size={14} />} disabled={!data.delivery.exists}
        onClick={() => { void download({ id: artifact.id, name: artifact.name }).catch(failure => notify(errorText(failure))) }}>
        {t('artifactDownload')}
      </Button>
      <Button variant="outline" size="sm" icon={<Icon name="copy" size={14} />} onClick={copy}>{t('artifactCopyPath')}</Button>
      {ticket && <Button variant="outline" size="sm" onClick={() => navigate({ page: 'execution', id: ticket.id })}>{t('openTicket')}</Button>}
      {project && <Button variant="outline" size="sm"
        onClick={() => navigate({ page: 'workstations', id: project.id })}>{t('artifactOpenProject')}</Button>}
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('artifactFileTitle')}>
      <KeyValues rows={[
        [t('artifactName'), <span className="dt-mono">{artifact.name}</span>],
        [t('artifactSize'), <span className="dt-mono">{sizeText(artifact.value.size)}</span>],
        [t('artifactHash'), <span className="dt-mono">{artifact.value.hash}</span>],
        [t('artifactCollectedAt'), <When at={artifact.at} />],
        [t('artifactProject'), project
          ? <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'workstations', id: project.id })}>{project.name}</button>
          : t('empty')],
        [t('artifactSource'), localized(t, source.label)],
        [t('artifactTicket'), ticket
          ? <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button>
          : t('empty')],
        [t('artifactTargetRoot'), <span className="dt-mono">{artifact.value.targetRoot || t('empty')}</span>],
      ]} />
    </Section>
    <ArtifactDelivery data={data} />
    <ArtifactChain data={data} />
  </div>
}

/** The 产物 page: the index, or with an artifact id, that artifact's own page. */
export function ArtifactsPage({ id, query }: { id?: string; query?: ArtifactQuery }) {
  return id === undefined ? <ArtifactList query={query ?? {}} /> : <ArtifactDetailPage key={id} id={id} />
}
