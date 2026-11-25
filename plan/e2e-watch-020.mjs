// 0.2.0 E2E: a folder drop after the schema-12 migration; reports the ticket, workspace project and artifact counts.
const base = `${process.env.DSH_WEB_URL}/orchestrator/api`
const headers = { 'x-orchestrator-request': '1' }
const get = async (path) => (await fetch(`${base}/${path}`, { headers })).json()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const deadline = Date.now() + 5 * 60_000
let ticket, last = ''
while (Date.now() < deadline) {
  const list = await get('tickets?state=open')
  ticket = (list.items ?? []).find(item => (item.threads ?? []).some(thread => String(thread.key).includes('demo-4')))
  if (ticket) {
    const line = `${ticket.stage}/${ticket.state}`
    if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line }
    if (ticket.state === 'ended' || ticket.stage === 'ended') break
  }
  await sleep(8000)
}
if (!ticket) { console.log('NO TICKET for demo-4'); process.exit(2) }
const projects = await get('projects')
const workspace = projects.find(project => project.key === 'workspace')
const detail = await get(`projects/${workspace.id}`)
console.log('WORKSPACE', JSON.stringify({ tickets: workspace.tickets, artifacts: workspace.artifacts, open: workspace.openTickets }))
console.log('DETAIL COUNTS', JSON.stringify(detail.counts))
const artifacts = await get(`artifacts?ticket=${encodeURIComponent(ticket.id)}`)
console.log('ARTIFACTS', JSON.stringify(artifacts).slice(0, 600))
