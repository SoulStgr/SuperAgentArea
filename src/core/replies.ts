/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { withMentions } from './mentions.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { PersonRef } from './project.ts'
import type { OutboundAttachment, ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * the ticket's current `question` for a person (`attention`), or the host's own question about a Trigger that belongs to no
 * registered Project, which needs no ticket. When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
  /** A ticket's result; `attachments` are the files it delivers beside the text, such as a ready ticket's deliverables. */
  | { purpose: 'result'; ticketId?: string; triggerId?: string; text: string; attachments?: OutboundAttachment[] }
  /** A question for the conversation a Trigger came from, such as how to place it in a Project; idempotent per Trigger. */
  | { purpose: 'question'; triggerId: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }
/** Whether two Channel references name the same conversation; a result is not sent to its own source twice. */
const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => a.source === b.source && a.thread === b.thread
  && JSON.stringify(a.address) === JSON.stringify(b.address)

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, its question for a person, and the host's own question about a Project, each only when its
 * rule allows it, under a deterministic id that keeps it from going out twice (idempotent). The Engine routes `reply` here;
 * Tickets asks it for the acknowledgement an accept carries, Evals for the question a `needsProject` stop asks, and
 * Assignments asks it to withdraw a question a report replaced. Results and questions mention the ticket's reporter and
 * people where the conversation's Source can name them.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), a result to
   * the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`, `merged`, or
   * `dropped`), and a `question` to the conversation its Trigger came from. Each message is queued at most once (idempotent).
   * An acknowledgement, even one already queued, records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request)
      : request.purpose === 'question' ? this.question(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /**
   * Queue the host's question about a Trigger that belongs to no registered Project where that Trigger was written, once:
   * its id names the Trigger, so asking again after a failed answer or a replayed Eval keeps one message. It mentions the
   * person who wrote the Trigger when the conversation's Source can name them, and its `purpose` tells the Source that a
   * folder, for one, answers it with a question file rather than a reply in the ticket's folder.
   */
  question(request: Extract<ReplyRequest, { purpose: 'question' }>): Reply {
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (!trigger.channel) throw new UserError('noChannel')
    const id = key('question', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing) {
      this.options.outbox.send({ id, channel: trigger.channel, text: this.mentioned(request.text, undefined,
        [{ source: trigger.actor.source, id: trigger.actor.id }], trigger.channel), kind: 'reply', purpose: 'question' })
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' | 'question' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    // A result's files travel with its text; the message id is the text's, so a reused reply keeps what it queued first.
    const attachments = request.purpose === 'result' ? request.attachments : undefined
    // A Ticket may have no replyable origin Channel (a monitored web page, for one). Its result still has a
    // configured report target in that case; without either there is nowhere to deliver it.
    const reportTarget = request.purpose === 'result' && ticket ? this.options.reportTarget?.(ticket) : undefined
    if (!channel && !reportTarget) throw new UserError('noChannel')
    if (!channel && reportTarget) {
      return this.deliver(reportTarget, request.text, ticket, attachments, key('reply', trigger?.id ?? ticket?.id ?? '', request.text))
    }
    // A result or a question for a person names the people it concerns where that conversation's Source can mention them.
    const mentioned = request.purpose === 'attention' || request.purpose === 'result'
      ? this.mentioned(request.text, ticket?.reporter, ticket?.mentions, channel!) : request.text
    this.options.outbox.send({ id, channel: channel!, text: mentioned, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {},
      ...attachments?.length ? { attachments } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    // A monitored request's own result is also delivered to its configured conversation; the target gets the raw text,
    // because the origin conversation's mention syntax does not apply there.
    if (reportTarget && !sameChannel(reportTarget, channel!)) {
      const targetId = key('result-target', ticket!.id)
      const existingTarget = this.options.outbox.status(targetId)
      if (!existingTarget) {
        this.options.outbox.send({ id: targetId, channel: reportTarget, text: request.text, kind: 'reply', ticketId: ticket!.id,
          ...attachments?.length ? { attachments } : {} })
      }
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** Queue `text` and its files to a result's configured target, with an id a retry reuses. */
  private deliver(channel: ChannelRef, text: string, ticket: Ticket | undefined, attachments: OutboundAttachment[] | undefined,
    id: string): Reply {
    const existing = this.options.outbox.status(id)
    if (!existing) this.options.outbox.send({ id, channel, text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {},
      ...attachments?.length ? { attachments } : {} })
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** `text` with the mentions its Source can render; unchanged when the host has no Source-side people adapter. */
  private mentioned(text: string, reporter: PersonRef | undefined, mentions: readonly PersonRef[] | undefined,
    channel: ChannelRef): string {
    const people = this.options.people
    return people ? withMentions(text, reporter, mentions, channel, (person, target) => people.mention(person, target)) : text
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
