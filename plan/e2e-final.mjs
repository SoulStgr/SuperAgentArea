// Final E2E on 0.3.0: drop → ticket → artifact delivery → project/workspace counts → history → instance health.
const base = `${process.env.DSH_WEB_URL}/orchestrator/api`
const headers = { 'x-orchestrator-request': '1' }
const get = async (path) => (await fetch(`${base}/${path}`, { headers })).json()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const state = await get('state')
console.log('STATE', JSON.stringify({ runtime: state.health.runtime?.state, setup: state.setup?.problem ?? null,
  instances: Object.keys(state.setup?.problems ?? {}) }))
const sources = await get('sources')
for (const source of sources) console.log('SOURCE', source.id, source.state, 'health=', (source.health ?? []).map(item => `${item.name}:${item.state}`).join(','))

const marker = 'demo-5'
const deadline = Date.now() + 5 * 60_000
let ticket, last = ''
while (Date.now() < deadline) {
  const open = await get('tickets?state=open&limit=50')
  const ended = await get('tickets?state=ended&limit=50')
  ticket = [...(open.items ?? []), ...(ended.items ?? [])].find(item => (item.threads ?? []).some(thread => String(thread.key).includes(marker)))
  if (ticket) {
    const line = `${ticket.stage}/${ticket.state}`
    if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line }
    const done = ticket.state === 'ended' || ticket.stage === 'ended'
    if (done) break
  }
  await sleep(6000)
}
if (!ticket) { console.log('NO TICKET for', marker); process.exit(2) }
const detail = await get(`tickets/${encodeURIComponent(ticket.id)}`)
console.log('TICKET', JSON.stringify({ id: ticket.id, stage: ticket.stage, summary: (detail.summary ?? '').slice(0, 100) }))
const artifacts = await get(`artifacts?ticket=${encodeURIComponent(ticket.id)}`)
console.log('ARTIFACTS', JSON.stringify((artifacts.items ?? []).map(item => ({ name: item.name, size: item.size, deliverable: item.deliverable, ticket: item.ticketTitle }))))
if (artifacts.items?.[0]) {
  const artifact = await get(`artifacts/${artifacts.items[0].id}`)
  console.log('REVERSE', JSON.stringify({ worker: artifact.workerSessionId, assignment: artifact.assignment?.state, exists: artifact.delivery?.exists }))
}
const projects = await get('projects')
const workspace = projects.find(project => project.key === 'workspace')
console.log('WORKSPACE', JSON.stringify({ tickets: workspace.tickets, open: workspace.openTickets, artifacts: workspace.artifacts }))
const history = await get(`projects/${workspace.id}/history`)
console.log('HISTORY', JSON.stringify({ tickets: history.tickets.length, artifacts: history.artifacts.length, reports: history.reports.length }))
