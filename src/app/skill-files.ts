/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { readdirSync, readFileSync } from 'node:fs'
import { packagePath } from '../infra/paths.ts'
/**
 * Reads a packaged text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
 */
function packaged(...parts: string[]): { path: string; text: string } {
  const path = packagePath(...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
/** A packaged built-in skill: the kind it belongs to, its frontmatter, its body, and the file it was read from. */
export interface BundledSkill { name: string; description: string; content: string; path: string }
/** The directory of a bundled Source skill: `skills/dsh-superagent-<kind>/SKILL.md`. */
const SKILL_DIR = /^dsh-superagent-([a-z][a-z0-9-]*)$/
function load(directory: string, name: string): BundledSkill {
  const { path, text } = packaged('skills', directory, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name, description: match[2]!, content: match[3]!, path }
}
/**
 * Every packaged Source skill, by the kind it serves: each directory `skills/dsh-superagent-<kind>` with a `SKILL.md`,
 * in name order, so a new Source kind's skill is registered by shipping its directory, without listing it in code.
 */
const scanned: [string, BundledSkill][] = readdirSync(packagePath('skills'), { withFileTypes: true }).flatMap(entry => {
  const match = entry.isDirectory() ? SKILL_DIR.exec(entry.name) : null
  return match ? [[match[1]!, load(entry.name, match[1]!)] as [string, BundledSkill]] : []
})
export const bundledSkills: Readonly<Record<string, BundledSkill>> = Object.fromEntries(scanned.sort(([a], [b]) => a.localeCompare(b)))
/** The kinds with a bundled skill, which a team skill name may not take. */
export const bundledSkillNames: readonly string[] = Object.keys(bundledSkills)
/**
 * Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
 * readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
export function promptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
