/**
 * The people a Source instance knows and how it names one: the Policy's allowed senders and bots, the people its kind's
 * configuration knows (a folder's operator), and the sender of the Trigger itself. An assessment may report or mention only
 * these; anyone else is a person another Source knows, or nobody, and is dropped.
 */
import type { ChannelRef, PersonRef, Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import type { Settings } from '../policy.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** What the people helpers read: the current Policy and the Source registry. */
export interface PeopleHost {
  settings(): Settings
  readonly sources: Pick<SourceRegistry, 'instanceFor' | 'people' | 'mention'>
}

/** The allowed entries and bots of one Source instance's Policy part, as the panel and the gate read them. */
function policyPeople(settings: Settings, id: string): { id: string; name?: string }[] {
  const part = settings.policy.sources[id] as (Record<string, unknown> | undefined)
  const entries = (value: unknown): { id: string; name?: string }[] => Array.isArray(value)
    ? value.flatMap(item => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
      ? [{ id: (item as { id: string }).id, ...typeof (item as { name?: unknown }).name === 'string' ? { name: (item as { name: string }).name } : {} }]
      : [])
    : []
  return [...entries(part?.allowed), ...entries(part?.bots)]
}
/**
 * Every person the Trigger's Source instance knows, by that instance's own identities: its Policy's allowed senders and
 * bots, the people its kind configures (a folder's operator), and the Trigger's sender.
 */
export function sourcePeople(host: PeopleHost, trigger: Trigger): PersonRef[] {
  const instance = host.sources.instanceFor(trigger.source, typeof trigger.meta.row === 'string' ? trigger.meta.row : undefined)
  const people: PersonRef[] = []
  if (instance) {
    people.push(...policyPeople(host.settings(), instance.id).map(entry => ({ source: instance.id, id: entry.id,
      ...entry.name ? { name: entry.name } : {} })))
    people.push(...host.sources.people(trigger))
  }
  if (trigger.actor.id) people.push({ source: trigger.actor.source, id: trigger.actor.id })
  const seen = new Set<string>()
  return people.filter(person => {
    const id = `${person.source}:${person.id}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
/** The person `person` names on the Trigger's Source, with the id and name that Source knows, or undefined for a stranger. */
export function knownPerson(host: PeopleHost, trigger: Trigger, person: { id: string; name?: string }): PersonRef | undefined {
  const found = sourcePeople(host, trigger).find(entry => sameName(entry.id, person.id))
  const name = found?.name ?? person.name
  return found ? { source: found.source, id: found.id, ...name ? { name } : {} } : undefined
}
/** Renders a mention of `person` for `channel` in that Source kind's own syntax, or `''` when it cannot mention. */
export function mentionOf(host: Pick<PeopleHost, 'sources'>, person: PersonRef, channel: ChannelRef): string {
  return host.sources.mention(person, channel)
}
