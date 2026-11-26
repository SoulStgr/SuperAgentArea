// @vitest-environment jsdom
// The Settings groups, drafts, save bars and history.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Fields } from '../src/client/settings-kit.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
/** Opens the header gear's Settings page at one of its groups; the gear opens the Source types by default. */
async function open_group(name: string = zh['settingsGroup.routing']) {
  await click(find(zh['tab.settings'], '.dt-head button'))
  await click(find(name, '.dt-settings-link'))
}
const dialog = () => document.querySelector('[role="dialog"]')!

it('keeps a person\'s own value where another save changed the same setting, and says so', async () => {
  await mount()
  await open_group(zh['settingsGroup.execution'])
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  server.settings = { ...server.settings, executor: { ...server.settings.executor, maxWorkers: 4 } }
  server.revisions.executor = 1
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.maxWorkers).value).toBe('6')
  await click(zh.save)
  expect(server.settings.executor.maxWorkers).toBe(6)
})

it('saves the Eval block in the Routing and Eval group and the Executor with its execution environment in its own group', async () => {
  await mount()
  await open_group()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.routing'])
  await click(zh['mode.auto'])
  await type(field<HTMLInputElement>(zh.evalTimeout), '180')
  const [provider, model] = all('.dt-model input')
  await type(provider as HTMLInputElement, 'worker-provider'); await type(model as HTMLInputElement, 'worker-model')
  await click(zh.save)
  expect(server.settings.eval).toEqual({ mode: 'auto', timeoutSeconds: 180, model: { provider: 'worker-provider', model: 'worker-model' } })
  await click(find(zh['settingsGroup.execution'], '.dt-settings-link'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  // An empty root uses the default directory, which the field names instead of looking set.
  expect(field<HTMLInputElement>(zh.executionDirectory).closest('.dt-field')!.querySelector('small')?.textContent).toBe('留空时用 /srv/dsh-superagent/work')
  await type(field<HTMLInputElement>(zh.executionDirectory), '/srv/work')
  // A variable picked from the list goes where the caret is in the prepare command.
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3')
  expect(all('.dt-table tbody tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR工单的执行目录执行器', 'DSH_SUPERAGENT_NAME工单短名执行器',
    'DSH_SUPERAGENT_GITHUB_REPOSITORY仓库GitHub · 已关闭'])
  await click('DSH_SUPERAGENT_DIR')
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('git worktree add "$DSH_SUPERAGENT_DIR"')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal  gh.other')
  const [workerProvider, workerModel, effort] = all('.dt-model input')
  await type(workerProvider as HTMLInputElement, 'worker-provider'); await type(workerModel as HTMLInputElement,
    'worker-model'); await type(effort as HTMLInputElement, 'high')
  expect([...document.querySelectorAll('#dt-worker-model-efforts option')].map(option => option.getAttribute('value'))).toEqual(['high'])
  await click(zh.save)
  expect(server.settings.executor).toEqual({ maxWorkers: 5, directory: '/srv/work',
    prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"', blockedCommands: ['gh-personal', 'gh.other'], model: { provider: 'worker-provider',
      model: 'worker-model', reasoningEffort: 'high' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval',
    'settings/executor'])
})

it('loads configuration history on demand in the Routing and Eval group, with localized changes and Source field labels', async () => {
  server.history = { current: 3, policyVersion: 'abcdef1234567890', items: [{ revision: 3, savedAt: '2026-09-22T00:00:00Z',
    source: 'sync', policyVersion: 'abcdef1234567890', policyChanged: true, notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
    changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceRowsAdded', source: 'feishu', field: 'allowed', items: ['Bob'],
      part: true }, { code: 'sourceField', source: 'feishu', field: 'syncChat', from: '', to: 'oc_team', part: true }] }] }
  await mount()
  await open_group()
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['第 3 次保存 · 从群同步', '生成策略版本 abcdef12', '接单模式：关闭 → 仅观察', '飞书 · 能发起工作的飞书用户 新增：Bob', '飞书 · 同步来源群：未设置 → oc_team',
    '因策略变更通知了 1 个进行中的工单：修复回归']) expect(text()).toContain(expected)
})

it('shows save and discard only while a settings block has edits, at the end of that block', async () => {
  await mount()
  await open_group(zh['settingsGroup.execution'])
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  expect(all('.dt-savebar')).toHaveLength(1)
  await type(field<HTMLInputElement>(zh.maxWorkers), '3')
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
  // A save submitted from a field keeps the focus there; one from the bar hands it to the block when the bar closes.
  const workers = field<HTMLInputElement>(zh.maxWorkers)
  await type(workers, '5')
  workers.focus()
  await act(async () => { workers.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.executor.maxWorkers).toBe(5)
  expect(document.activeElement).toBe(workers)
  await type(workers, '4')
  const save = find(zh.save)
  save.focus()
  await click(save)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.activeElement).toBe(workers.form)
})

it('gives the focus back to the field that had it once a block\'s save ends', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = (disabled: boolean) => act(async () => { root.render(<Fields disabled={disabled}><input aria-label="value" /></Fields>) })
  await render(false)
  const input = container.querySelector('input')!
  input.focus()
  await render(true)
  // jsdom does not blur a control when it becomes disabled; move focus away manually.
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
  expect(document.activeElement).toBe(document.body)
  await render(false)
  expect(document.activeElement).toBe(input)
})

it('opens Settings from the gear with the Source types, Routing and Eval, Executor and Deployment groups, and returns to the last group opened',
  async () => {
  await mount()
  await click(find(zh['tab.settings'], '.dt-head button'))
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual([zh['settingsGroup.sources'], zh['settingsGroup.routing'],
    zh['settingsGroup.execution'], zh['settingsGroup.deployment']])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.sources'])
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  await click(tab(zh['tab.overview']))
  await click(find(zh['tab.settings'], '.dt-head button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  await click(tab(zh['tab.overview']))
  await remount()
  await click(find(zh['tab.settings'], '.dt-head button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
})

it('lists the twelve Source types with their account counts and coming-soon marks, and adds an account of a placeholder type',
  async () => {
  await mount()
  await open_group(zh['settingsGroup.sources'])
  expect(all('.dt-source-kind .dt-source-kind-name').map(item => item.textContent)).toEqual(['飞书', 'GitHub', '本地文件夹', '远程文件夹',
    '网页/地址', 'QQ', '钉钉', '微信', 'Gitee', 'Telegram', '企业微信应用', '邮箱'])
  // The two configured accounts are counted under their types; the four types still being built carry the mark.
  expect(all('.dt-source-kind').map(button => button.querySelector('.dt-count')?.textContent)).toEqual(['1', '1', '0', '0', '0', '0',
    '0', '0', '0', '0', '0', '0'])
  expect(all('.dt-source-kind .dt-tag').map(tag => tag.textContent)).toEqual(Array(4).fill(zh.sourceComingSoonTag))
  // The selected type is Feishu: its account shows its settings summary, and an implemented type offers its Policy and prompts.
  expect(all('.dt-source-account')).toHaveLength(1)
  expect(all('.dt-source-account')[0]!.textContent).toContain(zh.sourceAccountOn)
  expect(all('.dt-source-account')[0]!.querySelector('.dt-account-summary')?.textContent).toContain('机器人的 lark-cli：lark-bot')
  expect(find(zh.sourcePolicyPrompts, '.dt-source-account button')).toBeTruthy()
  // A placeholder type explains the coming-soon state and creates its account anyway.
  await click(all('.dt-source-kind').find(button => button.textContent?.includes('Gitee'))!)
  expect(text()).toContain(zh.sourceComingSoonHint)
  expect(text()).toContain(zh.sourceAccountsEmpty)
  await click(find(zh.sourceAddAccount, '.dt-source-kind-body button'))
  expect(dialog().textContent).toContain(zh.sourceComingSoonHint)
  await type(field<HTMLInputElement>(zh.sourceLabel), '发布机器人')
  await type(field<HTMLInputElement>('私人令牌'), 'gitee-token')
  await click(find(zh.sourceCreateAccount, '[role="dialog"] button'))
  expect(server.requests.filter(request => request.path === 'sources' && request.method === 'POST').at(-1))
    .toMatchObject({ method: 'POST', body: { kind: 'gitee', label: '发布机器人', config: expect.objectContaining({ token: 'gitee-token' }) } })
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceAdded.replace('{name}', '发布机器人'))
  // The new account is listed under its type, marked as coming soon and without a Policy and prompts entry.
  expect(all('.dt-source-account')).toHaveLength(1)
  expect(all('.dt-source-account')[0]!.textContent).toContain(zh.sourceComingSoonTag)
  expect(all('.dt-source-account')[0]!.textContent).toContain(zh.sourceAccountOn)
  expect([...all('.dt-source-account')[0]!.querySelectorAll('button')].every(button => button.textContent !== zh.sourcePolicyPrompts))
    .toBe(true)
  expect(all('.dt-source-kind').find(button => button.textContent?.includes('Gitee'))?.querySelector('.dt-count')?.textContent).toBe('1')
})

/** Opens the Sources settings group and selects one Source type's accounts. */
async function select_kind(name: string) {
  await click(find(zh['tab.settings'], '.dt-head button'))
  await click(find(zh['settingsGroup.sources'], '.dt-settings-link'))
  await click(all('.dt-source-kind').find(button => button.textContent?.includes(name))!)
}

it('signs a WeChat account in by QR code: start, poll waiting then scanned, confirm and show the account', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.settings = { ...server.settings, sources: { ...server.settings.sources,
    wechat: { kind: 'wechat', enabled: true, config: { botType: '3' } } } }
  server.wechatPolls = ['wait', 'scaned', 'confirmed']
  await mount()
  await select_kind('微信')
  const account = () => all('.dt-source-account')[0]!
  expect(account().textContent).toContain(zh.sourceWechatNotSignedIn)
  await click(find(zh.sourceWechatSignIn, '.dt-source-account button'))
  expect(server.requests.find(request => request.path === 'sources/wechat/wechat/login')).toMatchObject({ method: 'POST' })
  expect(dialog().textContent).toContain(zh.sourceWechatLoginTitle)
  expect(dialog().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,d2VjaGF0')
  // The dialog polls every two seconds: waiting, then scanned, then signed in.
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(dialog().textContent).toContain(zh.sourceWechatWaiting)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(dialog().textContent).toContain(zh.sourceWechatScanned)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceWechatConfirmed)
  await vi.waitFor(() => expect(account().textContent).toContain(zh.sourceWechatAccount.replace('{id}', 'wx_bot_1')))
  expect(account().textContent).toContain(zh.sourceWechatSignInAgain)
  expect(server.requests.some(request => request.path === 'sources/wechat/wechat/status')).toBe(true)
})

it('offers a refresh when a WeChat QR code expired, then signs in on the new code', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.settings = { ...server.settings, sources: { ...server.settings.sources,
    wechat: { kind: 'wechat', enabled: true, config: {} } } }
  server.wechatPolls = ['expired']
  await mount()
  await select_kind('微信')
  await click(find(zh.sourceWechatSignIn, '.dt-source-account button'))
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(dialog().textContent).toContain(zh.sourceWechatExpired)
  // The refresh button starts a new attempt, and its confirmation signs the account in and closes the dialog.
  server.wechatPolls = ['confirmed']
  await click(find(zh.sourceWechatRefresh, '[role="dialog"] button'))
  expect(server.requests.filter(request => request.path === 'sources/wechat/wechat/login' && request.method === 'POST')).toHaveLength(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(server.wechatAccounts.wechat).toMatchObject({ ilinkBotId: 'wx_bot_1' })
})

it('adds a WeChat account without blocking on its sign-in, and says to scan its QR code', async () => {
  await mount()
  await open_group(zh['settingsGroup.sources'])
  await click(all('.dt-source-kind').find(button => button.textContent?.includes('微信'))!)
  expect(text()).toContain(zh.sourceAccountsEmpty)
  await click(find(zh.sourceAddAccount, '.dt-source-kind-body button'))
  await type(field<HTMLInputElement>(zh.sourceLabel), '客服微信')
  await click(find(zh.sourceCreateAccount, '[role="dialog"] button'))
  expect(server.settings.sources.wechat).toBeDefined()
  // The save is not blocked; its hint says the account still needs its QR sign-in.
  expect([...document.querySelectorAll('.dt-toast')].map(toast => toast.textContent))
    .toContain(zh.sourceWechatLoginHintAfterSave)
})

it('creates a DingTalk account by QR scan: starts, shows the code, polls and lists the created account', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.dingtalkPolls = ['waiting', 'confirmed']
  await mount()
  await select_kind('钉钉')
  await click(find(zh.sourceAddAccount, '.dt-source-kind-body button'))
  // The dialog opens on the scan tab, which asks the person to start the device sign-in explicitly.
  expect(dialog().textContent).toContain(zh.sourceDingtalkScanHint)
  expect(all('[role="dialog"] [role="tab"]').map(item => item.textContent)).toEqual([zh.sourceScanTab, zh.sourceManualTab])
  await click(find(zh.sourceDingtalkScanStart, '[role="dialog"] button'))
  expect(server.requests.find(request => request.path === 'sources/dingtalk/login')).toMatchObject({ method: 'POST' })
  expect(dialog().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,ZGluZ3RhbGs=')
  // The dialog polls every two seconds: waiting for the scan, then the host has created the account.
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(dialog().textContent).toContain(zh.sourceDingtalkWaiting)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceDingtalkConnected)
  await vi.waitFor(() => expect(all('.dt-source-account')).toHaveLength(1))
  expect(all('.dt-source-account')[0]!.textContent).toContain('钉钉（扫码）')
  expect(all('.dt-source-account')[0]!.textContent).toContain(zh.sourceAccountOn)
  expect(server.settings.sources.dingtalk).toMatchObject({ kind: 'dingtalk', enabled: true,
    config: { clientId: 'ding-client', robotCode: 'ding-client' } })
})

it('adds a DingTalk account by hand, with the create-bot entry and steps beside its three credentials', async () => {
  await mount()
  await select_kind('钉钉')
  await click(find(zh.sourceAddAccount, '.dt-source-kind-body button'))
  await click(find(zh.sourceManualTab, '[role="dialog"] [role="tab"]'))
  // The manual tab links the DingTalk open platform and lists the steps that produce the three fields.
  expect(dialog().querySelector('a[href="https://open.dingtalk.com/"]')).toBeTruthy()
  expect(dialog().textContent).toContain(zh.sourceDingtalkCreateStepApp)
  expect(dialog().textContent).toContain(zh.sourceDingtalkCreateStepRobot)
  expect(dialog().textContent).toContain(zh.sourceDingtalkCreateStepCredentials)
  await type(field<HTMLInputElement>('Client ID（AppKey）'), 'ding-client')
  await type(field<HTMLInputElement>('Client Secret（AppSecret）'), 'ding-secret')
  await type(field<HTMLInputElement>('Robot Code'), 'ding-robot')
  await click(find(zh.sourceCreateAccount, '[role="dialog"] button'))
  expect(server.settings.sources.dingtalk).toMatchObject({ kind: 'dingtalk', config: { clientId: 'ding-client',
    clientSecret: 'ding-secret', robotCode: 'ding-robot' } })
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceAdded.replace('{name}', '钉钉'))
})

it('creates a QQ account by QR scan: starts, shows the code, polls and lists the created account', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.qqPolls = ['waiting', 'confirmed']
  await mount()
  await select_kind('QQ')
  await click(find(zh.sourceAddAccount, '.dt-source-kind-body button'))
  // The dialog opens on the now-enabled scan tab, which asks the person to start the QR bind explicitly.
  expect(dialog().textContent).toContain(zh.sourceQqScanHint)
  expect(all('[role="dialog"] [role="tab"]').map(item => item.textContent)).toEqual([zh.sourceScanTab, zh.sourceManualTab])
  expect((all('[role="dialog"] [role="tab"]')[0] as HTMLButtonElement).disabled).toBe(false)
  await click(find(zh.sourceQqScanStart, '[role="dialog"] button'))
  expect(server.requests.find(request => request.path === 'sources/qq/login')).toMatchObject({ method: 'POST' })
  expect(dialog().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,cXE=')
  // The dialog polls every two seconds: waiting for the scan, then the host has created the account.
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(dialog().textContent).toContain(zh.sourceQqWaiting)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) }); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceQqConnected)
  await vi.waitFor(() => expect(all('.dt-source-account')).toHaveLength(1))
  expect(all('.dt-source-account')[0]!.textContent).toContain('QQ（扫码）')
  expect(all('.dt-source-account')[0]!.textContent).toContain(zh.sourceAccountOn)
  expect(server.settings.sources.qq).toMatchObject({ kind: 'qq', enabled: true,
    config: { appId: 'qq-app-1', allowedUserIds: 'qq-openid-1' } })
})

it('adds a QQ account by hand, with the open-platform entry and steps beside its two credentials', async () => {
  await mount()
  await select_kind('QQ')
  await click(find(zh.sourceAddAccount, '.dt-source-kind-body button'))
  await click(find(zh.sourceManualTab, '[role="dialog"] [role="tab"]'))
  // The manual tab links the QQ open platform and lists the steps that produce the two fields.
  expect(dialog().querySelector('a[href="https://q.qq.com/"]')).toBeTruthy()
  expect(dialog().textContent).toContain(zh.sourceQqCreateStepBot)
  expect(dialog().textContent).toContain(zh.sourceQqCreateStepCredentials)
  expect(dialog().textContent).toContain(zh.sourceQqCreateStepSandbox)
  await type(field<HTMLInputElement>('AppID'), 'qq-app-2')
  await type(field<HTMLInputElement>('AppSecret'), 'qq-secret-2')
  await click(find(zh.sourceCreateAccount, '[role="dialog"] button'))
  expect(server.settings.sources.qq).toMatchObject({ kind: 'qq', config: { appId: 'qq-app-2', appSecret: 'qq-secret-2' } })
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceAdded.replace('{name}', 'QQ'))
})

it('edits an account\'s own settings and switches it off from the Sources settings group', async () => {
  await mount()
  await open_group(zh['settingsGroup.sources'])
  const row = () => all('.dt-source-account')[0]!
  await click(find(zh.sourceEditConfig, '.dt-source-account button'))
  expect(all('.dt-source-account form.dt-card')).toHaveLength(1)
  // The form starts with the account's display name, empty until a person gives it one.
  const name = field<HTMLInputElement>(zh.sourceLabel)
  expect(name.value).toBe('')
  expect(name.placeholder).toBe('飞书')
  await click(find('仅 @', '.dt-source-account .dt-field-segmented [role="tab"]'))
  await click(find(zh.save, '.dt-source-account button'))
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT',
    body: { revision: 0, value: { enabled: true, config: expect.objectContaining({ otherChats: 'mentions' }) } } })
  expect(server.settings.sources.feishu!.config).toMatchObject({ otherChats: 'mentions' })
  // The account form carries its own configuration history, listing the saves of its `source:<id>` block.
  await click(find(zh.configHistory, '.dt-source-account [data-disclosure-row]'))
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(true)
  expect(text()).toContain('第 4 次保存 · 管理页')
  expect(text()).toContain('飞书 · 接收的群 新增：团队群')
  await click(find(zh.sourceEnable.replace('{name}', '飞书'), '.dt-source-account [role="switch"]'))
  expect(server.requests.find(request => request.path === 'sources/feishu' && request.method === 'PATCH'))
    .toMatchObject({ body: { enabled: false } })
  expect(row().textContent).toContain(zh.sourceAccountOff)
  // The account's Policy and prompts stay a page of their own, reached from the account.
  await click(find(zh.sourcePolicyPrompts, '.dt-source-account button'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('飞书')
  expect(all('.dt-governance-parts [role="tab"]').map(item => item.textContent)).toEqual([zh.sourceGovernancePolicy,
    zh.sourceGovernancePrompts])
})

it('renames an account in its configuration form and saves the display name with the block', async () => {
  await mount()
  await open_group(zh['settingsGroup.sources'])
  const row = () => all('.dt-source-account')[0]!
  await click(find(zh.sourceEditConfig, '.dt-source-account button'))
  await type(field<HTMLInputElement>(zh.sourceLabel), '飞书主号')
  await click(find(zh.save, '.dt-source-account button'))
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT',
    body: { value: expect.objectContaining({ label: '飞书主号' }) } })
  expect(server.settings.sources.feishu!.label).toBe('飞书主号')
  await vi.waitFor(() => expect(row().textContent).toContain('飞书主号'))
})

it('shows a credential change in the configuration history without its value', async () => {
  server.settings = { ...server.settings, sources: { ...server.settings.sources,
    qq: { kind: 'qq', enabled: true, config: { appId: 'qq-app', appSecret: 'qq-secret-1', sandbox: false } } } }
  server.history = { current: 5, policyVersion: 'abcdef1234567890', items: [{ revision: 5, savedAt: '2026-09-23T00:00:00Z',
    source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: false, notified: [], block: 'source:qq',
    changes: [{ code: 'sourceSecretChanged', source: 'qq', field: 'appSecret' }] }] }
  await mount()
  await select_kind('QQ')
  await click(find(zh.sourceEditConfig, '.dt-source-account button'))
  await click(find(zh.configHistory, '.dt-source-account [data-disclosure-row]'))
  expect(text()).toContain('QQ · AppSecret：已更换（内容不记录）')
  expect(text()).not.toContain('qq-secret-1')
})

it('deletes accounts from the Sources settings group, refusing one whose Tickets are still open', async () => {
  await mount()
  await open_group(zh['settingsGroup.sources'])
  // The Feishu account still has an open Ticket, so the host refuses its deletion with the reason the panel words.
  await click(find(zh.sourceDeleteAccount, '.dt-source-account button'))
  expect(dialog().textContent).toContain(zh.sourceDeleteMessage.replace('{name}', '飞书'))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.requests.some(request => request.path === 'sources/feishu' && request.method === 'DELETE')).toBe(true)
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent)
    .toBe(zh['userError.sourceInUse'].replace('{source}', 'feishu').replace('{count}', '1'))
  expect(all('.dt-source-account')).toHaveLength(1)
  await click(find(zh.cancel, '[role="dialog"] button'))
  // A GitHub account with no open Ticket is deleted, and the type then lists no account.
  await click(all('.dt-source-kind').find(button => button.textContent?.includes('GitHub'))!)
  await click(find(zh.sourceDeleteAccount, '.dt-source-account button'))
  await click(find(zh.confirm, '[role="dialog"] button'))
  expect(server.settings.sources.github).toBeUndefined()
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.sourceDeleted.replace('{name}', 'GitHub'))
  expect(all('.dt-source-account')).toHaveLength(0)
  expect(text()).toContain(zh.sourceAccountsEmpty)
})
