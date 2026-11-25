/**
 * The ticket card a Source conversation receives once its request started a ticket: the ticket's id, title, Project,
 * reporter, stage and link, with the reporter and the people the ticket mentions named in that Source's own syntax. The same
 * rendering names people on results and questions (`Replies`), so a Source's @ syntax is written once, in its Channel.
 */
import { key, ticketStage, withMentions, type ChannelRef, type OutboundMessage, type PersonRef, type Ticket, type Trigger } from '../core/index.ts'
import type { LinkTarget } from './views/records.ts'

/** What a card reads: the Ticket's origin Trigger and Project record, and the Source's mention rendering and conversation links. */
export interface AnnouncementHost {
  readonly store: { projects: { get(id: string): { value: { name: string; kind: string } } | undefined }
    triggers: { get(id: string): Trigger | undefined } }
  readonly sources: { mention(person: PersonRef, channel: ChannelRef): string }
  /** The page of a Channel's conversation, such as a Feishu chat or a GitHub Issue. */
  links: LinkTarget
}
/** The stage of an open ticket as the card words it, in both languages. */
const STAGE: Record<string, readonly [string, string]> = {
  'working/queued': ['排队中', 'queued'], working: ['执行中', 'working'], idle: ['空闲', 'idle'],
  'person/delivery': ['等待投递', 'waiting for delivery'], 'person/answer': ['等待你回答', 'waiting for your answer'],
  'person/review': ['待验收', 'waiting for review'], 'person/blocked': ['受阻', 'blocked'], 'person/failed': ['失败', 'failed'],
  ended: ['已结束', 'ended'],
}
/** How the card names the ticket's stage. */
export function stageText(ticket: Ticket): readonly [string, string] {
  const stage = ticketStage(ticket)
  const name = stage.stage === 'person' ? `person/${stage.action}`
    : stage.stage === 'working' && stage.action ? 'working/queued' : stage.stage
  return STAGE[name] ?? STAGE.working!
}
/** Whether a message reads as Chinese rather than English, as its Source wrote it. */
const chineseOf = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
/**
 * The ticket card for the conversation its request came from, or undefined when the ticket has no Channel to write to.
 * Its id names the Ticket, so a repeated announcement keeps one message; the card mentions the reporter and the ticket's
 * mentions in the conversation's Source syntax.
 */
export function ticketCardNotice(host: AnnouncementHost, ticket: Ticket, request: string): OutboundMessage | undefined {
  // The card goes where the request came from; a Ticket without that conversation uses its first Channel.
  const channel = host.store.triggers.get(ticket.origin.triggerId)?.channel ?? ticket.channels[0]
  if (!channel) return undefined
  const project = ticket.projectId ? host.store.projects.get(ticket.projectId) : undefined
  const reporter = ticket.reporter?.name ?? ticket.reporter?.id ?? ''
  const [zhStage, enStage] = stageText(ticket)
  const link = host.links(channel).url
  const zh = chineseOf(request)
  const text = (zh
    ? [`工单卡：${ticket.title}`, `编号：${ticket.id}`, `项目：${project?.value.name ?? ticket.projectId ?? 'workspace'}`,
      `汇报人：${reporter}`, `阶段：${zhStage}`, ...link ? [`链接：${link}`] : []]
    : [`Ticket: ${ticket.title}`, `ID: ${ticket.id}`, `Project: ${project?.value.name ?? ticket.projectId ?? 'workspace'}`,
      `Reporter: ${reporter}`, `Stage: ${enStage}`, ...link ? [`Link: ${link}`] : []]).join('\n')
  const mentioned = withMentions(text, ticket.reporter, ticket.mentions, channel, (person, target) => host.sources.mention(person, target))
  return { id: key('ticket-card', ticket.id), channel, text: mentioned, kind: 'notice', ticketId: ticket.id }
}
