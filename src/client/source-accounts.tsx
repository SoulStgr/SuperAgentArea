/**
 * The 工单源 settings group: the ten Source types, each with the accounts configured for it, the form that edits one
 * account's configuration, and the dialogs that add an account or a whole Source (a type, then an existing account or a
 * new one). An account is a Source instance of its type; a placeholder type lists accounts that save but receive nothing.
 */
import { useEffect, useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type SourceDetailView, type SourceKindRow, type SourceStatusRow } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Modal, SegmentedControl, Switch, Tag, type IconName } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { governanceRoute, sourceRoute } from './route.ts'
import { ConfigHistory, Fields, SourceField } from './settings-kit.tsx'
import { errorText, localized, type T } from './text.ts'
import { ConfirmButton, Hint, LoadState } from './widgets.tsx'

/** The icon that stands for a Source type in the settings list and the add dialog. */
const KIND_ICONS: Record<string, IconName> = { folder: 'inbox', github: 'hash', gitee: 'hash', feishu: 'message', wechat: 'message',
  dingtalk: 'message', qq: 'message', telegram: 'message', wecom: 'message', email: 'ask' }
const kindIcon = (kind: string): IconName => KIND_ICONS[kind] ?? 'inbox'
/** Fields whose values the account summary only marks as set, so credentials are not shown at a glance. */
const secretField = /(?:secret|token|password|passwd|apikey|aeskey)/i
/** A one-line summary of an account's configuration from its type's fields, credentials marked as set. */
function configSummary(t: T, detail: SourceDetailView): string {
  const parts = detail.fields.flatMap(field => {
    if (field.advanced || field.type === 'fact' || field.type === 'rows') return []
    const value = detail.value.config[field.key]
    if (value === undefined || value === null || value === '') return []
    const shown = typeof value === 'boolean' ? t(value ? 'yes' : 'no')
      : field.type === 'select' ? localized(t, field.options.find(option => option.value === value)?.label ?? field.options[0]!.label)
        : secretField.test(field.key) ? '••••' : String(value)
    return [`${localized(t, field.label)}${t('labelSeparator')}${shown.length > 32 ? `${shown.slice(0, 32)}…` : shown}`]
  })
  return parts.slice(0, 3).join(' · ') || t('sourceConfigEmpty')
}

/** One instance's configuration form, saved as its own settings block against the revision the page read. */
export function SourceConfigForm({ source, reload }: { source: SourceDetailView; reload: () => Promise<unknown> }) {
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

/** The key, label and type fields a person configures a new account with. */
function AccountFields({ kind, keyText, labelText, config, onKey, onLabel, onConfig }: {
  kind: SourceKindRow; keyText: string; labelText: string; config: Record<string, unknown>
  onKey: (next: string) => void; onLabel: (next: string) => void; onConfig: (next: Record<string, unknown>) => void
}) {
  const { t } = usePanel()
  return <>
    <label className="dt-field"><span className="dt-field-head">{t('sourceKey')}<InfoTip text={t('sourceKeyHint')} /></span>
      <span className="dt-input"><input aria-label={t('sourceKey')} value={keyText} placeholder="ops" spellCheck={false}
        onChange={event => onKey(event.target.value)} /></span></label>
    <label className="dt-field"><span className="dt-field-head">{t('sourceLabel')}</span>
      <span className="dt-input"><input aria-label={t('sourceLabel')} value={labelText}
        onChange={event => onLabel(event.target.value)} /></span></label>
    {kind.fields.map(field => <SourceField key={field.key} field={field} value={config[field.key]}
      saved={kind.defaults[field.key]} labels={{}} fact={undefined}
      onChange={next => onConfig({ ...config, [field.key]: next })} />)}
  </>
}

/** The dialog that adds one account to the chosen Source type. */
function AddAccountDialog({ kind, open, onClose, onCreated }: {
  kind: SourceKindRow; open: boolean; onClose: () => void; onCreated: () => Promise<unknown>
}) {
  const { t, call, notify } = usePanel()
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setKey(''); setLabel(''); setConfig(kind.defaults)
  }, [open, kind])
  const submit = async () => {
    setBusy(true)
    try {
      await call('POST sources', { body: { kind: kind.kind, ...key.trim() ? { key: key.trim() } : {},
        ...label.trim() ? { label: label.trim() } : {}, config } })
      notify(t('sourceAdded', { name: label.trim() || key.trim() || localized(t, kind.title) }))
      await onCreated()
      onClose()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <Modal open={open} onClose={onClose} className="dt-modal-mid"
    title={`${t('sourceAddAccount')} · ${localized(t, kind.title)}`} closeLabel={t('close')}
    description={t('sourceAddAccountHint')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{t('sourceCreateAccount')}</Button>
    </>}>
    <div className="dt-source-answer">
      {kind.placeholder && <p className="dt-banner">{t('sourceComingSoonHint')}</p>}
      <AccountFields kind={kind} keyText={key} labelText={label} config={config} onKey={setKey} onLabel={setLabel} onConfig={setConfig} />
    </div>
  </Modal>
}

/** One account of the selected Source type: its status, configuration summary, and the actions that change it. */
function SourceAccountRow({ source, placeholder, onChanged }: {
  source: SourceStatusRow; placeholder: boolean; onChanged: () => Promise<unknown>
}) {
  const { t, call, navigate, notify } = usePanel()
  const { data: detail, error, reload } = usePoll(() => call('GET sources/:id', { id: source.id }), [source.id])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = localized(t, source.title)
  const { dot } = sourceMark(t, source.state)
  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try { await call('PATCH sources/:id', { id: source.id, body: { enabled } }); await Promise.all([reload(), onChanged()]) }
    catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const remove = async () => {
    await call('DELETE sources/:id', { id: source.id })
    notify(t('sourceDeleted', { name }))
    await onChanged()
  }
  return <li className="dt-row dt-source-account">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <Dot state={dot} />
        <span className="dt-row-label">{name}</span>
        <span className="dt-mono">{source.id}</span>
        <Tag tone={source.enabled ? 'success' : 'neutral'}>{t(source.enabled ? 'sourceAccountOn' : 'sourceAccountOff')}</Tag>
        {placeholder && <Tag tone="warning">{t('sourceComingSoonTag')}</Tag>}
      </div>
      {detail && <div className="dt-row-meta"><span className="dt-account-summary">{configSummary(t, detail)}</span></div>}
      {error && <p className="dt-error">{error.message}</p>}
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" aria-expanded={editing} disabled={!detail}
          onClick={() => setEditing(!editing)}>{t('sourceEditConfig')}</Button>
        {!placeholder && <Button variant="ghost" size="sm" icon={<Icon name="shield" size={14} />}
          onClick={() => navigate(governanceRoute(source.id))}>{t('sourcePolicyPrompts')}</Button>}
        <ConfirmButton label={t('sourceDeleteAccount')} title={t('sourceDeleteTitle')}
          message={t('sourceDeleteMessage', { name })} icon="trash" onConfirm={remove} />
        {busy && <span className="dt-hint" role="status">{t('loading')}</span>}
      </div>
      {editing && detail && <div className="dt-account-edit">
        <SourceConfigForm source={detail} reload={async () => { await reload(); await onChanged() }} />
        <ConfigHistory blocks={[`source:${source.id}`]} />
      </div>}
    </div>
    <Switch checked={source.enabled} onChange={enabled => { void toggle(enabled) }}
      label={t('sourceEnable', { name })} />
  </li>
}

/**
 * The 工单源 group of Settings: every installed Source type on the left with its account count and coming-soon mark, and
 * the selected type's description and accounts on the right.
 */
export function SourceAccountsSettings() {
  const { t, call } = usePanel()
  const kinds = usePoll(() => call('GET source-kinds'), [])
  const sources = usePoll(() => call('GET sources'), [])
  const [selected, setSelected] = useState<string>()
  const [adding, setAdding] = useState(false)
  const list = kinds.data ?? []
  const current = list.find(kind => kind.kind === selected) ?? list[0]
  const accountsOf = (kind: SourceKindRow) => (sources.data ?? []).filter(source => source.kind === kind.kind)
  const changed = () => sources.reload()
  if (!current) return <LoadState error={kinds.error ?? sources.error} loading />
  return <div className="dt-source-settings">
    <nav className="dt-source-kinds" aria-label={t('sourceKindsLabel')}>
      {list.map(kind => <button key={kind.kind} type="button" className="dt-source-kind"
        aria-current={kind === current ? 'true' : undefined} onClick={() => setSelected(kind.kind)}>
        <Icon name={kindIcon(kind.kind)} size={14} />
        <span className="dt-source-kind-name">{localized(t, kind.title)}</span>
        {kind.placeholder && <Tag tone="warning">{t('sourceComingSoonTag')}</Tag>}
        <span className="dt-count">{accountsOf(kind).length}</span>
      </button>)}
    </nav>
    <div className="dt-source-kind-body">
      <div className="dt-source-kind-head">
        <span className="dt-field-head">{localized(t, current.title)}{current.placeholder
          && <Tag tone="warning">{t('sourceComingSoonTag')}</Tag>}</span>
        <Button variant="primary" size="sm" icon={<Icon name="plus" />} onClick={() => setAdding(true)}>
          {t('sourceAddAccount')}</Button>
      </div>
      <p className="dt-hint">{localized(t, current.description)}</p>
      {current.placeholder && <p className="dt-banner">{t('sourceComingSoonHint')}</p>}
      <p className="dt-hint">{t('sourceAccountsIntro')}</p>
      {accountsOf(current).length ? <ul className="dt-list">{accountsOf(current).map(source => <SourceAccountRow key={source.id}
        source={source} placeholder={current.placeholder} onChanged={changed} />)}</ul>
        : <Hint>{t('sourceAccountsEmpty')}</Hint>}
      <AddAccountDialog kind={current} open={adding} onClose={() => setAdding(false)} onCreated={changed} />
    </div>
  </div>
}

/**
 * The dialog that adds a Source to the 工单源 page in two steps: choose one of the ten Source types, then an existing
 * account (a disabled one is enabled and becomes a card) or a new account, created enabled.
 */
export function AddSourceDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: () => Promise<unknown>
}) {
  const { t, call, notify, navigate } = usePanel()
  const [kinds, setKinds] = useState<SourceKindRow[]>()
  const [sources, setSources] = useState<SourceStatusRow[]>()
  const [step, setStep] = useState<1 | 2>(1)
  const [kind, setKind] = useState<string>()
  const [mode, setMode] = useState<'existing' | 'new'>('new')
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [already, setAlready] = useState<SourceStatusRow>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setStep(1); setKind(undefined); setAlready(undefined); setKey(''); setLabel(''); setConfig({})
    Promise.all([call('GET source-kinds'), call('GET sources')]).then(([listed, instances]) => {
      setKinds(listed); setSources(instances)
    }, failure => notify(errorText(failure)))
  }, [open, call, notify])
  const selected = kinds?.find(item => item.kind === kind)
  const accounts = (sources ?? []).filter(source => source.kind === kind)
  const count = (name: string) => (sources ?? []).filter(source => source.kind === name).length
  /** Opens step two of one type; the account mode starts at the one the type has accounts for. */
  const pick = (next: SourceKindRow) => {
    setKind(next.kind); setConfig(next.defaults); setAlready(undefined); setKey(''); setLabel('')
    setMode(count(next.kind) ? 'existing' : 'new'); setStep(2)
  }
  const choose = async (account: SourceStatusRow) => {
    if (account.enabled) { setAlready(account); return }
    setBusy(true)
    try {
      await call('PATCH sources/:id', { id: account.id, body: { enabled: true } })
      notify(t('sourceAccountEnabledToast', { name: localized(t, account.title) }))
      await onCreated()
      onClose()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const submit = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await call('POST sources', { body: { kind: selected.kind, ...key.trim() ? { key: key.trim() } : {},
        ...label.trim() ? { label: label.trim() } : {}, config } })
      notify(t('sourceAdded', { name: label.trim() || key.trim() || localized(t, selected.title) }))
      await onCreated()
      onClose()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const openDetail = () => {
    if (!already) return
    const id = already.id
    onClose()
    navigate(sourceRoute(id))
  }
  return <Modal open={open} onClose={onClose} title={t('sourceAddTitle')} closeLabel={t('close')}
    className={step === 1 ? 'dt-modal-wide' : 'dt-modal-mid'}
    description={step === 1 ? t('sourceAddHint') : t('sourceAddAccountHint')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      {step === 2 && mode === 'new' && <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>
        {t('sourceCreateAccount')}</Button>}
    </>}>
    <div className="dt-source-answer">
      {step === 1 && <div className="dt-source-picks">
        {(kinds ?? []).map(item => <button key={item.kind} type="button" className="dt-source-pick" onClick={() => pick(item)}>
          <span className="dt-source-pick-title"><Icon name={kindIcon(item.kind)} size={14} />{localized(t, item.title)}
            {item.placeholder && <Tag tone="warning">{t('sourceComingSoonTag')}</Tag>}</span>
          <span className="dt-hint">{localized(t, item.description)}</span>
          <span className="dt-count">{t('sourceAccountCount', { count: count(item.kind) })}</span>
        </button>)}
      </div>}
      {step === 2 && selected && <>
        <div className="dt-source-kind-head">
          <span className="dt-field-head"><Icon name={kindIcon(selected.kind)} size={14} />{localized(t, selected.title)}
            {selected.placeholder && <Tag tone="warning">{t('sourceComingSoonTag')}</Tag>}</span>
          <Button variant="ghost" size="sm" onClick={() => { setStep(1); setAlready(undefined) }}>{t('sourceBack')}</Button>
        </div>
        <p className="dt-hint">{localized(t, selected.description)}</p>
        {selected.placeholder && <p className="dt-banner">{t('sourceComingSoonHint')}</p>}
        <SegmentedControl className="dt-segmented dt-account-modes" label={t('sourceAccountMode')} value={mode}
          options={[{ value: 'existing', label: t('sourceExistingAccount') }, { value: 'new', label: t('sourceNewAccount') }]}
          onChange={setMode} />
        {mode === 'existing' && (accounts.length ? <ul className="dt-list">{accounts.map(account => <li key={account.id}
          className="dt-row"><div className="dt-row-main"><div className="dt-row-title">
            <button type="button" className="dt-textlink" onClick={() => { void choose(account) }}>
              {localized(t, account.title)}</button>
            <span className="dt-mono">{account.id}</span>
            <Tag tone={account.enabled ? 'success' : 'neutral'}>{t(account.enabled ? 'sourceAccountOn' : 'sourceAccountOff')}</Tag>
          </div></div></li>)}</ul> : <Hint>{t('sourceAccountsEmpty')}</Hint>)}
        {mode === 'existing' && already && <div className="dt-banner dt-banner-actions">
          <p>{t('sourceAlreadyInHint', { name: localized(t, already.title) })}</p>
          <Button variant="outline" size="sm" onClick={openDetail}>{t('sourceOpen')}</Button>
        </div>}
        {mode === 'new' && <AccountFields kind={selected} keyText={key} labelText={label} config={config} onKey={setKey}
          onLabel={setLabel} onConfig={setConfig} />}
      </>}
    </div>
  </Modal>
}
