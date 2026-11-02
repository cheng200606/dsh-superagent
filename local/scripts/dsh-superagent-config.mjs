/**
 * Save dsh-superagent settings through the orchestrator Management API.
 *
 * The API replaces one block per request and answers `restarting: true` when
 * the service must reload, during which the API is briefly unavailable. This
 * script saves the blocks in order and waits for the service to answer again.
 *
 * Usage: node dsh-superagent-config.mjs
 */

const API = 'http://127.0.0.1:3082/orchestrator/api'
const HEADERS = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }

const REPOSITORY = 'cheng200606/dsh-plugin-codemap'
const CLI = 'D:/ProfessionalSoftware/tools/gh-agent-wrapper/gh-agent.exe'
const ALLOWED = ['cheng200606']
const CLONE = 'C:/Users/26825/src/widgets'
/** The folder the local directory Source watches; a file dropped in is a request. */
const WATCHED = 'C:/Users/26825/tasks'
const LOCAL_ACTOR = 'local'
/** The webhook Source speaks for this sender id; programs POST requests to the loopback endpoint. */
const WEBHOOK_ACTOR = 'webhook'
/** Direct github.com is unreachable from this machine at times; the read-only mirror proxies fetches. */
const MIRROR = 'https://ghfast.top/https://github.com'

/** The command that gives each ticket its own worktree of the repository. */
const PREPARE = [
  `git -C ${CLONE} fetch --no-tags "${MIRROR}/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "\${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"`,
  `&& git -C ${CLONE} worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"`,
].join(' ')

async function request(path, init) {
  const response = await fetch(API + path, { headers: HEADERS, ...init })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

/** Waits until the service answers again after a restart. */
async function waitUntilReady(attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(API + '/state', { headers: HEADERS })
      if (response.ok) {
        await response.text()
        await new Promise(resolve => setTimeout(resolve, 1500))
        return true
      }
    } catch {
      // The service is restarting; keep waiting.
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return false
}

/** Reads the settings, retrying while the service is restarting. */
async function readSettings() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const answer = await request('/settings')
    if (answer.status === 200 && answer.body?.blocks) return answer.body
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('the service does not answer GET /settings')
}

/** Saves one block with its current revision and reports the answer. */
async function save(block, value, label) {
  const settings = await readSettings()
  const revision = block.startsWith('source:')
    ? settings.sources.find(source => source.id === block.slice('source:'.length))?.revision ?? 0
    : settings.blocks[block]?.revision ?? 0
  const answer = await request(`/settings/${block}`, { method: 'PUT', body: JSON.stringify({ value, revision }) })
  console.log(`${label}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`)
  if (answer.status !== 200) {
    console.log(`  -> ${label} was refused; the answer names the setup problem.`)
    return false
  }
  if (answer.body?.restarting) {
    console.log('  -> the service restarts; waiting for it to answer again...')
    if (!await waitUntilReady()) {
      console.log('  -> the service did not come back in time.')
      return false
    }
  }
  return true
}

const settings = await readSettings()
const github = settings.sources.find(source => source.id === 'github')
const githubConfig = { ...github.value.config, repository: REPOSITORY, cli: CLI }
// A trigger that arrives as a comment on a thread is only seen when the repository's comment
// stream is observed; notifications alone carry mentions on issues and pull requests.
if (process.env.OBSERVE_COMMENTS === '1') githubConfig.observeComments = true
const localdir = settings.sources.find(source => source.id === 'localdir')
const localdirConfig = { ...(localdir?.value.config ?? {}), directory: WATCHED, suffix: '.md', actor: LOCAL_ACTOR, pollSeconds: 10 }
// The local directory Source sends as its actor, so the Policy must allow that id; so must the webhook sender.
const policy = {
  ...settings.blocks.policy.value,
  sources: {
    ...settings.blocks.policy.value.sources,
    github: { allowed: ALLOWED.map(id => ({ id })), bots: [] },
    localdir: { allowed: [{ id: LOCAL_ACTOR }] },
    webhook: { allowed: [{ id: WEBHOOK_ACTOR }] },
  },
}
const executor = { ...settings.blocks.executor.value, prepare: PREPARE }

const wanted = process.argv.slice(2)
const blocks = [
  { name: 'source:github', label: 'source:github', value: { enabled: true, config: githubConfig } },
  { name: 'source:localdir', label: 'source:localdir', value: { enabled: true, config: localdirConfig } },
  // The webhook Source's config is just its optional shared token and sender; it is enabled by default.
  { name: 'source:webhook', label: 'source:webhook', value: { enabled: true, config: { token: '', actor: WEBHOOK_ACTOR } } },
  { name: 'policy', label: 'policy', value: policy },
  { name: 'executor', label: 'executor', value: executor },
].filter(block => !wanted.length || wanted.includes(block.name))

for (const block of blocks) {
  console.log(`--- saving ${block.label}`)
  if (!await save(block.name, block.value, block.label)) {
    console.log('stopped: fix the problem above and run the script again')
    break
  }
}

console.log('--- final state')
const state = (await request('/state')).body
console.log('setup.problem:', JSON.stringify(state.setup.problem))
console.log('setup.accounts:', JSON.stringify(state.setup.accounts))
for (const [part, health] of Object.entries(state.health)) {
  console.log(`health.${part}: ${health.state} ${health.detail}`)
}
