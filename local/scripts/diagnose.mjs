/**
 * Collect a diagnosis of a dsh-superagent installation.
 *
 * It answers "why is it not working" with one command, and it works when the
 * service is down: it reads the state directory, the profile, the ports and the
 * fork's own patch state, then names the most likely cause.
 *
 * Usage: node local/scripts/diagnose.mjs [--out <file>] [--api http://127.0.0.1:3082]
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform, release } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const home = homedir()
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const apiIndex = args.indexOf('--api')
const API = apiIndex >= 0 ? args[apiIndex + 1] : 'http://127.0.0.1:3082'
const OUT = outIndex >= 0 ? args[outIndex + 1] : join(home, '.dsh', 'state', 'superagent-diagnosis.txt')

const lines = []
const say = (text = '') => { lines.push(text) }
const findings = []

/** Runs a command and returns its output, or the reason it failed. */
async function capture(command, parameters) {
  try {
    const { stdout, stderr } = await exec(command, parameters, { timeout: 15000, windowsHide: true })
    return (stdout || stderr || '').trim()
  } catch (error) {
    return `(failed: ${error.code ?? error.message})`
  }
}

/** Reads a file, or reports why it could not. */
async function readText(path) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    return `(unreadable: ${error.code ?? error.message})`
  }
}

/** The size of a file in bytes, or -1 when it does not exist. */
async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

/** The API's answer, its status code and whether it carried a body. */
async function probe(path) {
  try {
    const response = await fetch(`${API}${path}`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(8000) })
    const text = await response.text()
    return { status: response.status, length: text.length, body: text }
  } catch (error) {
    return { status: 0, length: 0, body: '', error: String(error.message ?? error) }
  }
}

say('# dsh-superagent diagnosis')
say(`collected: ${new Date().toISOString()}`)
say(`host: ${hostname()} · ${platform()} ${release()}`)
say(`node: ${process.version}`)
say(`api: ${API}`)
say('')

// --- The fork's own state -----------------------------------------------------
say('## fork')
const version = JSON.parse(await readText(join(root, 'package.json'))).version
const head = await capture('git', ['-C', root, 'log', '-1', '--format=%h %s'])
const branch = await capture('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])
const dirty = await capture('git', ['-C', root, 'status', '--porcelain'])
say(`version: ${version}`)
say(`branch: ${branch}`)
say(`head: ${head}`)
say(`uncommitted changes: ${dirty ? dirty.split('\n').length : 0} file(s)`)
if (dirty) say('```\n' + dirty + '\n```')
say('')

// --- The profile and the state directory ---------------------------------------
say('## profile and state directory')
const profileDir = join(home, '.dsh', 'profiles', 'superagent')
const patch = await readText(join(profileDir, 'cordis.patch.yml'))
say(`profile: ${profileDir}`)
say('```yaml\n' + patch + '\n```')
const stateDir = /stateDir:\s*(\S+)/.exec(patch)?.[1] ?? join(home, '.dsh', 'state', 'superagent')
say(`stateDir: ${stateDir}`)
try {
  const entries = await readdir(stateDir)
  say(`contents: ${entries.join(', ')}`)
} catch (error) {
  say(`contents: (unreadable: ${error.code ?? error.message})`)
  findings.push(`the state directory ${stateDir} does not exist: the profile's stateDir points somewhere the service never wrote`)
}
const lock = `${stateDir}.lock`
const lockSize = await sizeOf(lock)
say(`lock: ${lock} ${lockSize >= 0 ? `exists (${lockSize} bytes)` : 'absent'}`)
const database = await sizeOf(join(stateDir, 'orchestrator.sqlite'))
say(`database: ${database} bytes`)
try {
  const shims = await readdir(join(stateDir, 'worker-bin'))
  say(`worker shims: ${shims.join(', ')}`)
  if (!shims.includes('gh')) findings.push('the worker shim directory has no gh shim: setup did not finish')
} catch {
  findings.push('no worker shim directory: setup did not finish')
}
const pluginLog = await readText(join(stateDir, 'diagnostics.log'))
if (pluginLog.startsWith('(unreadable')) {
  say('plugin diagnostics: (no diagnostics.log; the plugin predates this file or setup never finished)')
} else {
  const events = pluginLog.split('\n').filter(Boolean)
  say(`plugin diagnostics: ${events.length} event(s) in diagnostics.log`)
  say('```\n' + events.slice(-10).join('\n') + '\n```')
}
say('')

// --- The process and its port ---------------------------------------------------
say('## process and port')
const port = new URL(API).port || '80'
const listening = await capture('netstat', ['-ano'])
const rows = listening.split('\n').filter(line => line.includes(`:${port}`) && line.includes('LISTENING'))
say(rows.length ? rows.join('\n') : `nothing listens on port ${port}`)
const serving = rows.length > 0
if (!serving) findings.push(`nothing listens on port ${port}: the service is not running`)
if (lockSize >= 0 && !serving) findings.push(`a lock directory ${lock} exists while nothing listens on port ${port}: it is stale and the next start refuses to run`)
say('')

// --- What the API answers -------------------------------------------------------
say('## api')
const state = await probe('/orchestrator/api/state')
say(`state: status ${state.status}${state.error ? ` (${state.error})` : ''}, ${state.length} bytes`)
if (state.status === 0) {
  findings.push('the API does not answer: the service is not running or the port is wrong')
} else if (state.status === 404) {
  findings.push('the API answers 404: the management route is not registered (the fiber restart fix in local/docs/windows-patches.md, patch 7)')
} else if (state.status === 400 && state.length === 0) {
  findings.push('the API answers an empty 400: the host caught a failing route handler; the plugin log would name the cause')
} else if (state.status === 200) {
  try {
    const parsed = JSON.parse(state.body)
    say(`setup problem: ${JSON.stringify(parsed.setup?.problem ?? null)}`)
    say(`accounts: ${JSON.stringify(parsed.setup?.accounts ?? null)}`)
    say(`health: ${Object.entries(parsed.health ?? {}).map(([part, entry]) => `${part}=${entry.state}`).join(' ')}`)
    if (parsed.setup?.problem) findings.push(`setup is unresolved: ${parsed.setup.problem.detail}`)
  } catch {
    findings.push('the API answered 200 with a body that is not JSON')
  }
}
const sources = await probe('/orchestrator/api/sources')
if (sources.status === 200) {
  try {
    for (const source of JSON.parse(sources.body)) {
      say(`source ${source.id}: ${source.state} · ${(source.health ?? []).map(entry => `${entry.name}=${entry.state} ${entry.detail}`).join('; ')}`)
    }
  } catch { /* The body is not JSON; the status line above already says so. */ }
}
const settings = await probe('/orchestrator/api/settings')
if (settings.status === 200) {
  try {
    const parsed = JSON.parse(settings.body)
    const github = parsed.sources?.find(source => source.id === 'github')
    if (github) {
      say(`github source: repository=${github.value.config.repository} cli=${github.value.config.cli}`)
      const cliExists = (await sizeOf(github.value.config.cli)) >= 0
      say(`agent cli exists: ${cliExists ? 'yes' : 'NO'}`)
      if (!cliExists) findings.push(`the configured agent CLI ${github.value.config.cli} does not exist`)
    }
  } catch { /* The body is not JSON; the status line above already says so. */ }
}
say('')

// --- The tools the agent needs --------------------------------------------------
say('## tools')
say(`git: ${await capture('git', ['--version'])}`)
say(`gh on PATH: ${await capture('gh', ['--version'])}`)
const ghConfig = join(home, '.config', 'gh-agent', 'hosts.yml')
const ghConfigSize = await sizeOf(ghConfig)
say(`agent gh config: ${ghConfigSize >= 0 ? 'present' : 'missing'}`)
if (ghConfigSize < 0) findings.push('the agent GitHub CLI is not signed in: no hosts.yml in the agent configuration directory')
say('')

// --- The DSH host ---------------------------------------------------------------
say('## dsh host')
say(`dsh on PATH: ${await capture('dsh', ['--version'])}`)
say('note: the CLI usually is not on PATH; it sits beside the app, for example D:\\ProfessionalSoftware\\Agent\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd')
const logDir = join(home, '.dsh', 'logs')
try {
  const logs = (await readdir(logDir)).filter(name => name.endsWith('.log')).slice(-5)
  say(`host logs: ${logs.join(', ') || '(none)'}`)
} catch {
  say('host logs: (no log directory)')
}
say('')

// --- The verdict ------------------------------------------------------------------
say('## findings')
if (!findings.length) say('nothing stands out; the installation looks healthy.')
for (const finding of findings) say(`- ${finding}`)
say('')
say('## notes')
say('- The DSH host runs as a separate process, so its log lines do not reach a terminal that started it.')
say('- The management API answers 200 only while the plugin is registered; check the fork state above for the patch set.')
say('- local/scripts/verify-restart-survival.mjs proves the API survives a settings save that restarts the plugin.')

const report = lines.join('\n')
process.stdout.write(report + '\n')
await writeFile(OUT, report + '\n', 'utf8')
console.error(`\nwritten: ${OUT}`)
