/**
 * Placeholder Source kinds for the twelve-kind catalog: Gitee, Telegram, WeCom app and Email are listed so a person can
 * create and keep their accounts now, while each kind only validates and stores its credentials. None of them watches
 * anything, has a Channel, or reports health beyond the fixed paused "coming soon" state the Source views give a
 * placeholder kind's instances.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { FieldSpec, Localized, SourceKind } from './kind.ts'

/** The shared hint of every placeholder credential: the account saves, but nothing is received or sent yet. */
const COMING_SOON: Localized = { zh: '接入开发中：账号可先保存，暂不接收、也不发送消息。', en: 'Coming soon: the account can be saved now, but receives and sends nothing yet.' }
const credential = (key: string, label: Localized, hint: Localized = COMING_SOON): FieldSpec => ({ key, type: 'text', label, hint })
/** A credential field that may be left empty while the kind is a placeholder; required fields arrive with the real connection. */
const secret = z.string().trim().default('')
/** One placeholder kind: its form, its minimal credential schema and its single health entry, named after the kind. */
function placeholderKind(spec: { kind: string; title: Localized; description: Localized
  schema: z.ZodType<Record<string, unknown>>; fields: FieldSpec[]; order?: number }): SourceKind {
  return { ...spec, placeholder: true, health: [spec.kind] }
}

const GiteeConfig = z.object({ token: secret, repository: secret, apiBase: z.string().trim().default('https://gitee.com/api/v5') }).strict()
const giteeKind = placeholderKind({
  kind: 'gitee',
  order: 11,
  title: { zh: 'Gitee', en: 'Gitee' },
  description: { zh: '接收 Gitee 仓库里的 Issue 与 PR 讨论（接入开发中）。', en: 'Receives Issues and pull-request discussion in a Gitee repository (coming soon).' },
  schema: GiteeConfig,
  fields: [credential('token', { zh: '私人令牌', en: 'Access token' }),
    credential('repository', { zh: '仓库（owner/name）', en: 'Repository (owner/name)' }),
    credential('apiBase', { zh: 'API 地址', en: 'API base' })],
})

const TelegramConfig = z.object({ botToken: secret }).strict()
const telegramKind = placeholderKind({
  kind: 'telegram',
  order: 12,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: { zh: '接收 Telegram 机器人的私聊与群消息（接入开发中）。', en: 'Receives a Telegram bot\'s direct and group messages (coming soon).' },
  schema: TelegramConfig,
  fields: [credential('botToken', { zh: '机器人令牌', en: 'Bot token' })],
})

const WecomConfig = z.object({ corpId: secret, agentId: secret, secret: secret, token: secret, aesKey: secret }).strict()
const wecomKind = placeholderKind({
  kind: 'wecom',
  order: 7,
  title: { zh: '企业微信应用', en: 'WeCom app' },
  description: { zh: '接收企业微信自建应用的消息回调（接入开发中）。', en: 'Receives the message callback of a WeCom self-built app (coming soon).' },
  schema: WecomConfig,
  fields: [credential('corpId', { zh: '企业 ID', en: 'Corp ID' }), credential('agentId', { zh: '应用 AgentId', en: 'Agent ID' }),
    credential('secret', { zh: '应用 Secret', en: 'App secret' }), credential('token', { zh: '回调 Token', en: 'Callback token' }),
    credential('aesKey', { zh: '回调 AES Key', en: 'Callback AES key' })],
})

const EmailConfig = z.object({ imapHost: secret, smtpHost: secret, user: secret, secret: secret }).strict()
const emailKind = placeholderKind({
  kind: 'email',
  order: 8,
  title: { zh: '邮箱', en: 'Email' },
  description: { zh: '接收发到邮箱的邮件，并以邮件回复（接入开发中）。', en: 'Receives mail sent to a mailbox and replies by mail (coming soon).' },
  schema: EmailConfig,
  fields: [credential('imapHost', { zh: 'IMAP 地址', en: 'IMAP host' }), credential('smtpHost', { zh: 'SMTP 地址', en: 'SMTP host' }),
    credential('user', { zh: '邮箱地址', en: 'Mailbox address' }), credential('secret', { zh: '密码或授权码', en: 'Password or app password' })],
})

/** The four placeholder kinds, in the catalog order of plan/24: Gitee, Telegram, WeCom app and Email. */
export const connectorKinds = [giteeKind, telegramKind, wecomKind, emailKind] as unknown as SourceKind[]

export const name = 'dsh-superagent-connectors'
export const inject = ['orchestrator']
/** Registers each placeholder kind, so the catalog lists twelve kinds while only folder, remote, web, QQ, DingTalk, WeChat, GitHub and Feishu receive work. */
export function apply(ctx: Context): void {
  for (const kind of connectorKinds) {
    ctx.effect(() => ctx.orchestrator.sources.register(kind), `${kind.kind}: placeholder source kind`)
  }
}
