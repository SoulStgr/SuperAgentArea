/**
 * How a message names the people it concerns: the reporter and the people a ticket mentions, each in the syntax of the
 * conversation's own Source. Sources keep their own identities, so a person of another Source is never mentioned.
 */
import type { ChannelRef } from './model.ts'
import type { PersonRef } from './project.ts'

/** Renders one person's mention for a conversation; a Source kind supplies it in production, `''` when it cannot mention. */
export type MentionRenderer = (person: PersonRef, channel: ChannelRef) => string
/** The people a message to `channel` mentions: the reporter first, then the ticket's mentions, each once, on that conversation's Source. */
export function mentionedPeople(reporter: PersonRef | undefined, mentions: readonly PersonRef[] | undefined,
  channel: ChannelRef): PersonRef[] {
  const seen = new Set<string>()
  return [...reporter ? [reporter] : [], ...mentions ?? []].filter(person => {
    const id = `${person.source}:${person.id}`
    if (person.source !== channel.source || seen.has(id)) return false
    seen.add(id)
    return true
  })
}
/**
 * Appends the rendered mentions of `reporter` and `mentions` to `text` as its last line, reusing one renderer for every
 * message kind (`result`, `attention` and the host's own questions and ticket cards). Text without anyone to mention is
 * returned unchanged, so a Source that cannot mention keeps its message exactly as written.
 */
export function withMentions(text: string, reporter: PersonRef | undefined, mentions: readonly PersonRef[] | undefined,
  channel: ChannelRef, render: MentionRenderer): string {
  const rendered = mentionedPeople(reporter, mentions, channel).map(person => render(person, channel)).filter(Boolean)
  return rendered.length ? `${text}\n\n${rendered.join(' ')}` : text
}
