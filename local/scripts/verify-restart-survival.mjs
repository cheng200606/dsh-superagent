/**
 * Verify that the management API survives a fiber restart.
 *
 * Saving a setup field makes dsh-superagent restart its fiber. The host's Web server keys its routes by
 * path, so a restart that registers before the previous fiber's disposer runs used to leave the panel
 * without its API until the whole DSH process restarted. This script forces such a restart — by saving the
 * agent CLI path in an equivalent spelling — and watches the API while it happens.
 *
 * Usage: node verify-restart-survival.mjs [apiBase]
 */

const API = process.argv[2] ?? 'http://127.0.0.1:3082/orchestrator/api'
const HEADERS = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
const CLI_FORWARD = 'D:/ProfessionalSoftware/tools/gh-agent-wrapper/gh-agent.exe'
const CLI_BACKWARD = 'D:\\ProfessionalSoftware\\tools\\gh-agent-wrapper\\gh-agent.exe'

async function api(path, init) {
  const response = await fetch(API + path, { headers: HEADERS, ...init })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

/** Saves the GitHub Source with the given CLI spelling, which makes setup change and restarts the plugin. */
async function saveCli(cli) {
  const settings = (await api('/settings')).body
  const github = settings.sources.find(source => source.id === 'github')
  const value = { enabled: true, config: { ...github.value.config, cli } }
  const answer = await api('/settings/source:github', { method: 'PUT', body: JSON.stringify({ value, revision: github.revision }) })
  return answer
}

/** The CLI path spelling that differs from the one saved now, so the save counts as a setup change. */
async function otherCliSpelling() {
  const settings = (await api('/settings')).body
  const github = settings.sources.find(source => source.id === 'github')
  return github.value.config.cli === CLI_FORWARD ? CLI_BACKWARD : CLI_FORWARD
}

/** Polls the state endpoint and reports every status code it saw. */
async function watch(seconds, label) {
  const seen = []
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    let code = 'ERR'
    try {
      const response = await fetch(`${API}/state`, { headers: { 'x-orchestrator-request': '1' } })
      await response.text()
      code = String(response.status)
    } catch { code = 'ERR' }
    seen.push(code)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  const unique = [...new Set(seen)]
  const alive = seen.filter(code => code === '200').length
  console.log(`${label}: ${alive}/${seen.length} 次探测返回 200；出现过的状态码：${unique.join(', ')}`)
  return { alive, total: seen.length, unique }
}

console.log('--- 保存一个等价的 CLI 路径写法，触发 fiber 重启')
const first = await saveCli(await otherCliSpelling())
console.log('  保存结果:', JSON.stringify(first.body))
if (first.body?.restarting !== true) {
  console.log('  未触发重启（restarting 不为 true），无法验证；检查设置是否真的变化。')
  process.exitCode = 1
} else {
  const during = await watch(45, '  重启期间')
  console.log('--- 换回另一种写法，再触发一次重启')
  const second = await saveCli(await otherCliSpelling())
  console.log('  保存结果:', JSON.stringify(second.body))
  const after = await watch(30, '  第二次重启期间')
  const failures = [...during.unique, ...after.unique].filter(code => code !== '200')
  if (failures.length) {
    console.log(`  失败：出现 ${failures.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('  通过：两次重启期间管理 API 始终可用。')
  }
}
