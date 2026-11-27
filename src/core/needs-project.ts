/**
 * The host's question for a Trigger whose Project is not registered: the ways a person may answer it (an existing Project,
 * a new one with an address, the assessment's proposal, or the built-in workspace for temporary work), written in the
 * Trigger's language. The assessment must not create a Project itself, so this question and the person's answer are how
 * ownership is settled before any ticket.
 */
import type { Trigger } from './model.ts'
import type { ProjectCandidate, ProjectLocation, ProjectProposal } from './project.ts'

/** How many candidate names the question lists, and how many characters they may take, so a chat message stays short. */
const CANDIDATES = 8
const NAME_CHARS = 30
const LIST_CHARS = 240
/** Whether a text reads as Chinese rather than English, as the Source writes it; the question and a folder's answer file follow it. */
export const readsChinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
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
/**
 * The answers of the question, in the Trigger's language, from the Projects it may choose and the proposal it may confirm:
 * an existing station, a new one with its address, the assessment's proposal, and the built-in workspace for temporary work.
 */
export function needsProjectQuestion(trigger: Pick<Trigger, 'text'>, candidates: readonly ProjectCandidate[] = [],
  proposal?: ProjectProposal): string {
  const chinese = readsChinese(trigger.text)
  const names = listed(candidates, chinese)
  const options = [
    ...names ? [chinese ? `①归到已有工作站：${names}` : `①an existing workstation: ${names}`] : [],
    chinese ? '②新建工作站：给出名称和地址（远程仓库 URL 或本地文件夹绝对路径）'
      : '②a new workstation: its name and address (a remote repository URL or a local folder\'s absolute path)',
    ...proposal ? [chinese ? `③确认建议：新建“${proposal.name.slice(0, NAME_CHARS)}”（${projectLocationText(proposal.location, true)}）`
      : `③confirm the proposal: new “${proposal.name.slice(0, NAME_CHARS)}” (${projectLocationText(proposal.location)})`] : [],
    chinese ? '④ 不需要工作站（临时工作放 workspace）' : '④no workstation (temporary work in the workspace)',
  ]
  return chinese ? `这单还没有归属的工作站。请回复：${options.join('；')}。`
    : `This request belongs to no registered workstation. Reply with ${options.join('; ')}.`
}
