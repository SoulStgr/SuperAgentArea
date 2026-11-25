/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { Artifact } from './app/artifacts.ts'
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}
/** The suffix of a GitHub instance's sharded key: the default instance keeps the historical unsharded key. */
const shard = (instance: string): string => instance === 'github' ? '' : `:${instance}`

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID). Each record takes the instance id: the default
   * instance `github` keeps the historical unsharded key, and a named instance gets its own shard.
   */
  github: { since: family<string, [instance: string]>('github-since', shard),
    retries: family<Record<string, Retry>, [instance: string]>('github-retry', shard),
    cursor: family<string, [instance: string, number: number]>('github-cursor:',
      (instance, number) => shard(instance) ? `:${instance}:${number}` : `${number}`),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [instance: string, stream: string]>('github-stream:',
      (instance, stream) => shard(instance) ? `:${instance}:${stream}` : stream),
    branchCi: family<{ branch?: string; failures?: string[]; revision: number }, [instance: string]>('github-branch-ci', shard),
    ci: family<{ fingerprint: string; revision: number }, [instance: string, number: number]>('github-ci:',
      (instance, number) => shard(instance) ? `:${instance}:${number}` : `${number}`) },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
  /**
   * Folder Source: per-inbox write-completeness fingerprints (size and mtime of the previous round) and the content
   * hash of the last received version of each drop, so an unchanged reread is a duplicate and an edit a new event.
   */
  folder: { pending: family<Record<string, { size: number; mtime: number }>, [row: string]>('folder-pending:'),
    seen: family<Record<string, string>, [row: string]>('folder-seen:') },
  /**
   * Artifacts: the deliverables earlier versions collected from a ticket's `deliver/` directory, oldest collection last.
   * Since P6c only the schema 12 migration reads them, to index them in the artifact table; nothing writes them any more.
   */
  artifacts: family<Artifact[], [ticket: string]>('artifacts:'),
  /**
   * Project ownership: the Project a Thread answered its `needsProject` question with, so its next Eval resolves it (and later
   * Triggers on the Thread keep it). Written by the Project service, read by its resolution.
   */
  projects: { answers: family<string, [thread: string]>('project-answer:') },
}
