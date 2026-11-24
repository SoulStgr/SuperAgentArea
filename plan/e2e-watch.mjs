// E2E run 2: a task folder with a Chinese TASK.md; waits for the ticket, then reports the outcome and delivery.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = `${process.env.DSH_WEB_URL}/orchestrator/api`
const headers = { 'x-orchestrator-request': '1' }
const get = async (path) => (await fetch(`${base}/${path}`, { headers })).json()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const outbox = 'H:\\DTB_AIToos\\superAgent\\e2e\\outbox'

const all = async () => {
  const lists = await Promise.all(['open', 'ended'].map(state => get(`tickets?state=${state}&limit=100`)))
  return [...lists[0].items ?? [], ...lists[1].items ?? []]
}
const marker = process.argv[2] ?? 'demo-2'
const deadline = Date.now() + 6 * 60_000
let found, last = ''
while (Date.now() < deadline) {
  const tickets = await all()
  found = tickets.find(ticket => (ticket.threads ?? []).some(thread => String(thread.key).includes(marker)))
  if (found) {
    const line = `${found.stage}/${found.state} ${JSON.stringify((found.summary ?? '').slice(0, 60))}`
    if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line }
    if (found.state === 'ended') break
  }
  await sleep(8000)
}
if (!found) { console.log(`NO TICKET for ${marker}`); process.exit(2) }
const state = await get('state')
console.log('WORKER HEALTH', JSON.stringify(state.health.worker))
const ticket = await get(`tickets/${encodeURIComponent(found.id)}`)
console.log('TICKET', JSON.stringify({ id: found.id, state: found.state, ended: ticket.ended, summary: (ticket.summary ?? '').slice(0, 200) }, null, 1))
const dir = join(outbox, found.id)
if (existsSync(dir)) {
  const walk = (path, depth = 0) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) { console.log(' '.repeat(depth) + '[dir] ' + entry.name); walk(child, depth + 2) }
      else console.log(' '.repeat(depth) + entry.name + ` (${readFileSync(child).length}b): ` + (entry.name.endsWith('.md') ? readFileSync(child, 'utf8').slice(0, 120).replaceAll('\n', ' | ') : ''))
    }
  }
  walk(dir)
} else console.log('NO OUTBOX for the ticket')
