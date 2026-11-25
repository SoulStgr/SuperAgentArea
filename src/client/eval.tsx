/** The latest Decisions page (reached from the overview) and the installation-level Eval settings its Routing and Eval group shows. */
import { useState } from 'react'
import { LIMITS } from '../limits.ts'
import { DECISION_FILTERS, DECISION_KINDS, usePoll, type DecisionFilter } from './api.ts'
import { InfoTip, Input, Pill, SegmentedControl } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { DecisionLine } from './rows.tsx'
import { decisionsRoute } from './route.ts'
import { Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { valueLabel } from './text.ts'
import { Hint, LoadMore, LoadState, Section } from './widgets.tsx'

/** The latest Decisions the Policy produced, filterable by kind and to the last day. */
function DecisionLog({ filter, window, paused }: { filter: DecisionFilter; window: '24h' | undefined; paused: boolean }) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(30)
  const { data, error } = usePoll(() => call('GET decisions', { query: { limit, kind: DECISION_KINDS[filter],
    ...window ? { window } : {} } }), [filter, limit, window])
  const show = (key: DecisionFilter, last24h: boolean) => navigate(decisionsRoute({
    ...key === 'work' ? {} : { filter: key }, ...last24h ? { window: '24h' } : {} }), true)
  return <>
    <p className="dt-hint">{t('evalStatusIntro')}</p>
    {paused && <p className="dt-banner">
      {t('evalRecordsPaused')} <button type="button" className="dt-textlink"
        onClick={() => navigate({ page: 'execution' })}>{t('resumeWhere')}</button>
    </p>}
    <div className="dt-filters">
      {DECISION_FILTERS.map(key => <Pill key={key} active={filter === key} onClick={() => { setLimit(30); show(key, !!window) }}>
        {t(`decisionFilter.${key}`)}
      </Pill>)}
      {window && <><span className="dt-filter-gap" /><Pill active onClick={() => show(filter, false)}>{t('lastDayOnly')}</Pill></>}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(decision => <DecisionLine key={decision.id}
      decision={decision} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 30)} />}
  </>
}

/** The Decisions page: the latest Decisions Eval made, filterable by kind and to the last day; it has no tab of its own. */
export function DecisionsPage({ filter, window, paused }: {
  filter: DecisionFilter; window: '24h' | undefined; paused: boolean
}) {
  const { t } = usePanel()
  return <div className="dt-form">
    <div className="dt-status-head">
      <h2 className="dt-status-title">{t('decisionsTitle')}<InfoTip text={t('decisionsPageIntro')} /></h2>
    </div>
    <DecisionLog filter={filter} window={window} paused={paused} />
  </div>
}

/** The Eval settings: the accept mode, one Eval's time limit and the assessor model. An installation-wide block. */
export function EvalSettings() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.eval
  const saved = { ...block.value, timeoutSeconds: String(block.value.timeoutSeconds) }
  const draft = useBlockDraft('eval', saved, block.revision, value => ({ ...value, timeoutSeconds: numberOf(value.timeoutSeconds) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <h2 className="dt-block-title">{t('evalSettings')}<InfoTip text={t('evalIntro')} /></h2>
      <Section title={t('acceptMode')} hint={t(`modeOption.${value.mode}`)}>
        <SegmentedControl className="dt-segmented" label={t('acceptMode')} value={value.mode} onChange={mode => edit({ mode })}
          options={(['off', 'observe', 'auto'] as const).map(mode => ({ value: mode, label: valueLabel(t, 'mode', mode),
            title: t(`modeOption.${mode}`) }))} />
      </Section>
      <Field label={t('evalTimeout')} hint={t('evalTimeoutHint')}>
        <Input type="number" min={LIMITS.evalTimeoutSeconds.min} max={LIMITS.evalTimeoutSeconds.max} required value={value.timeoutSeconds}
          onChange={event => edit({ timeoutSeconds: event.target.value })} />
      </Field>
      <Section title={t('assessorModel')} hint={t('assessorModelHint')}>
        <ModelField id="dt-eval-model" value={value.model} onChange={model => edit({ model })} />
      </Section>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
