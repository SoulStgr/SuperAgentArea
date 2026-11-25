/**
 * The host's question for a Trigger whose Project is not registered: the three ways a person may answer it (an existing
 * Project, a new one with an address, or the assessment's proposal), written in the Trigger's language. The assessment must
 * not create a Project itself, so this question and the person's answer are how ownership is settled before any ticket.
 */
import type { Trigger } from './model.ts'
import type { ProjectCandidate, ProjectLocation, ProjectProposal } from './project.ts'

/** How many candidate names the question lists, and how many characters they may take, so a chat message stays short. */
const CANDIDATES = 8
const NAME_CHARS = 30
const LIST_CHARS = 240
/** Whether a Trigger reads as Chinese rather than English, as the Source writes it. */
const chineseOf = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
/** A Project address as a person reads it: a managed directory, an external folder, or a repository URL or path. */
export function projectLocationText(location: ProjectLocation, chinese = false): string {
  if (location.type === 'managed') return chinese ? '托管目录' : 'managed directory'
  if (location.type === 'folder') return location.path
  return location.url ?? location.path ?? (chinese ? '仓库' : 'repository')
}
/** The candidate names the question lists, cut by name and by total length so the message stays within an IM limit. */
function listed(candidates: readonly ProjectCandidate[], chinese: boolean): string {
  const names: string[] = []
  let used = 0
  for (const candidate of candidates.slice(0, CANDIDATES)) {
    const name = candidate.name.slice(0, NAME_CHARS)
    if (used + name.length > LIST_CHARS) break
    names.push(name)
    used += name.length + 1
  }
  return names.join(chinese ? '、' : ', ')
}
/** The three answers of the question, in the Trigger's language, from the Projects it may choose and the proposal it may confirm. */
export function needsProjectQuestion(trigger: Pick<Trigger, 'text'>, candidates: readonly ProjectCandidate[] = [],
  proposal?: ProjectProposal): string {
  const chinese = chineseOf(trigger.text)
  const names = listed(candidates, chinese)
  const options = [
    ...names ? [chinese ? `①归到已有工作站：${names}` : `①an existing workstation: ${names}`] : [],
    chinese ? '②新建工作站：给出名称和地址（本地目录或远程仓库）' : '②a new workstation: its name and address (a local folder or a repository)',
    ...proposal ? [chinese ? `③确认建议：新建“${proposal.name.slice(0, NAME_CHARS)}”（${projectLocationText(proposal.location, true)}）`
      : `③confirm the proposal: new “${proposal.name.slice(0, NAME_CHARS)}” (${projectLocationText(proposal.location)})`] : [],
  ]
  return chinese ? `这单还没有归属的工作站。请回复：${options.join('；')}。`
    : `This request belongs to no registered workstation. Reply with ${options.join('; ')}.`
}
