// 0.3.2 smoke: a folder drop uses its Source instance's prompt/policy scope; reports ticket + per-source prompt state.
const base = `${process.env.DSH_WEB_URL}/orchestrator/api`
const headers = { 'x-orchestrator-request': '1' }
const get = async (path) => (await fetch(`${base}/${path}`, { headers })).json()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const marker = process.argv[2] ?? 'demo-6'
const deadline = Date.now() + 4 * 60_000
let ticket
while (Date.now() < deadline) {
  const lists = await Promise.all([get('tickets?state=open&limit=50'), get('tickets?state=ended&limit=50')])
  ticket = [...(lists[0].items ?? []), ...(lists[1].items ?? [])].find(item => (item.threads ?? []).some(thread => String(thread.key).includes(marker)))
  if (ticket?.state === 'ended' || ticket?.stage === 'ended') break
  await sleep(5000)
}
if (!ticket) { console.log('NO TICKET for', marker); process.exit(2) }
console.log('TICKET', JSON.stringify({ id: ticket.id, stage: ticket.stage, state: ticket.state }))
const prompts = await get('sources/folder:ops/prompts')
console.log('PROMPTS', JSON.stringify({ revision: prompts.revision, source: prompts.source, defaultSkills: (prompts.defaultSkills ?? []).map(item => item.name) }))
const settings = await get('settings')
const folder = (settings.sources ?? []).find(item => item.id === 'folder:ops')
console.log('POLICY', JSON.stringify({ revision: folder?.policy?.revision, inherited: folder?.policy?.inherited, rules: (folder?.policy?.rules ?? []).length }))
