/**
 * Settings page (its own tab and the header gear): the Source types and their accounts, Routing and Eval, the Executor
 * with its environment, and Deployment.
 */
import type { StateView } from './api.ts'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { ConfigHistory, SettingsProvider } from './settings-kit.tsx'
import { SourceAccountsSettings } from './source-accounts.tsx'

/** The Routing and Eval group: the installation's Eval settings and the Policy and Eval saves. */
function RoutingSettings() {
  return <>
    <EvalSettings />
    <ConfigHistory blocks={['eval', 'policy']} versions />
  </>
}
export function SettingsPage({ group, state, deploymentForm }: {
  group: SettingsGroup; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = group === 'sources' ? <SettingsProvider><SourceAccountsSettings /></SettingsProvider>
    : group === 'routing' ? <SettingsProvider><RoutingSettings /></SettingsProvider>
      : group === 'execution' ? <SettingsProvider><ExecutionSettings /></SettingsProvider>
        : <DeploymentPage setup={state.setup} form={deploymentForm} />
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {SETTINGS_GROUPS.map(value => <button key={value} type="button" className="dt-settings-link"
        aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value), true)}>
        {t(`settingsGroup.${value}`)}</button>)}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
      {content}
    </div>
  </div>
}
