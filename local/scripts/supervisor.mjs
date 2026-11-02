/**
 * Keep dsh-superagent running.
 *
 * The upstream service script needs tmux, which Windows does not have, and the DSH host runs as its own
 * process, so a terminal that started it cannot tell whether it is still alive. This supervisor owns the
 * host process directly: it starts it, watches it, restarts it when it dies, stops it on request and
 * reports what it sees.
 *
 * Usage:
 *   node local/scripts/supervisor.mjs start [--detach] [--profile superagent] [--dsh <app dir>]
 *   node local/scripts/supervisor.mjs stop | restart | status
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const home = homedir()
const args = process.argv.slice(2)
const command = args[0] ?? 'status'
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const has = name => args.includes(`--${name}`)

const profile = flag('profile', 'superagent')
const appDir = resolve(flag('dsh', 'D:/ProfessionalSoftware/Agent/dsh'))
const profileDir = join(home, '.dsh', 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')

/** Reads the profile's state directory, which the plugin writes into. */
async function stateDir() {
  try {
    const text = await readFile(patchFile, 'utf8')
    return /stateDir:\s*(\S+)/.exec(text)?.[1] ?? join(home, '.dsh', 'state', profile)
  } catch {
    return join(home, '.dsh', 'state', profile)
  }
}

/** The port the panel answers on. */
async function port() {
  try {
    const text = await readFile(patchFile, 'utf8')
    return /port:\s*(\d+)/.exec(text)?.[1] ?? '3082'
  } catch {
    return '3082'
  }
}

const state = await stateDir()
const listenPort = await port()
const api = `http://127.0.0.1:${listenPort}/orchestrator/api`
const supervisorPidFile = join(state, 'supervisor.pid')
const hostPidFile = join(state, 'host.pid')
const logFile = join(state, 'supervisor.log')

/** Whether the management API answers. */
async function alive() {
  try {
    const response = await fetch(`${api}/state`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(5000) })
    await response.text()
    return response.ok
  } catch {
    return false
  }
}

/** The pid recorded in a file, when that process is still alive. */
async function readPid(path) {
  try {
    const pid = Number((await readFile(path, 'utf8')).trim())
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

/** Removes the lock a killed host left behind; the next start refuses to run while it exists. */
async function clearLock() {
  await rm(`${state}.lock`, { recursive: true, force: true })
}

/** Appends a line to the supervisor's log. */
async function log(line) {
  await mkdir(state, { recursive: true })
  const handle = await open(logFile, 'a')
  await handle.appendFile(`${new Date().toISOString()} ${line}\n`)
  await handle.close()
}

/**
 * Starts the DSH host. The upstream launcher runs the desktop executable with ELECTRON_RUN_AS_NODE, which
 * makes it a plain Node process that this supervisor can own and signal; the command wrapper is skipped so
 * that the child is the host itself and no intermediate process survives it.
 */
function startHost() {
  const executable = join(appDir, 'DeepSeek Harness.exe')
  const entry = join(appDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (!existsSync(executable)) throw new Error(`the DSH executable is missing: ${executable}`)
  const child = spawn(executable, ['--expose-internals', entry, '--profile', profile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const forward = (stream, name) => {
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      for (const line of String(chunk).split('\n')) if (line.trim()) void log(`${name} ${line.trim()}`)
    })
  }
  forward(child.stdout, 'host')
  forward(child.stderr, 'host')
  return child
}

/** Stops the host: a gentle request first, then a forced one when it does not go. */
async function stopHost(pid, timeoutMs = 20000) {
  const forced = () => { try { process.kill(pid, 'SIGKILL') } catch { /* It is already gone. */ } }
  const gentle = () => {
    try { process.kill(pid, 'SIGINT') } catch { /* It is already gone. */ }
  }
  gentle()
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try { process.kill(pid, 0) } catch { return 'stopped' }
    await delay(500)
  }
  forced()
  await delay(1000)
  return 'killed'
}

/** Waits until the panel answers, or gives up. */
async function waitForApi(timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await alive()) return true
    await delay(2000)
  }
  return false
}

if (command === 'status') {
  const supervisor = await readPid(supervisorPidFile)
  const host = await readPid(hostPidFile)
  const answers = await alive()
  console.log(`profile: ${profile}`)
  console.log(`state directory: ${state}`)
  console.log(`supervisor pid: ${supervisor ?? '(not running)'}`)
  console.log(`host pid: ${host ?? '(not running)'}`)
  console.log(`api: ${answers ? 'answers' : 'does not answer'} (${api})`)
  if (existsSync(logFile)) {
    const lines = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).slice(-5)
    console.log('last log lines:')
    for (const line of lines) console.log(`  ${line}`)
  }
  process.exit(answers ? 0 : 1)
}

if (command === 'stop') {
  // The supervisor restarts the host when it dies, so it is stopped first; on Windows a signal cannot be
  // delivered as a console event to another process, so both are asked to end and then forced.
  const supervisor = await readPid(supervisorPidFile)
  if (supervisor) {
    console.log(`stopping the supervisor (pid ${supervisor})...`)
    await stopHost(supervisor, 5000)
  }
  const host = await readPid(hostPidFile)
  if (host) {
    console.log(`stopping the host (pid ${host})...`)
    await stopHost(host)
  }
  await clearLock()
  await rm(supervisorPidFile, { force: true })
  await rm(hostPidFile, { force: true })
  console.log('stopped')
  process.exit(0)
}

if (command === 'restart') {
  const supervisor = await readPid(supervisorPidFile)
  if (supervisor) await stopHost(supervisor, 5000)
  const host = await readPid(hostPidFile)
  if (host) await stopHost(host)
  await clearLock()
  await rm(supervisorPidFile, { force: true })
  await rm(hostPidFile, { force: true })
  args.unshift('start')
}

if (command === 'start') {
  const supervisor = await readPid(supervisorPidFile)
  const host = await readPid(hostPidFile)
  if ((supervisor || host) && await alive()) {
    console.log(`already running (supervisor ${supervisor ?? '—'}, host ${host ?? '—'}); the panel is at http://127.0.0.1:${listenPort}/`)
    process.exit(0)
  }
  if (supervisor) {
    console.log(`the supervisor (pid ${supervisor}) does not answer; stopping it first`)
    await stopHost(supervisor, 5000)
  }
  if (host) {
    console.log(`the host (pid ${host}) does not answer; stopping it first`)
    await stopHost(host)
  }
  await clearLock()
  await mkdir(state, { recursive: true })

  let stopping = false
  let restarts = 0
  let restartedAt = Date.now()
  let finished
  const done = new Promise(resolve => { finished = resolve })

  const run = async () => {
    while (!stopping) {
      // The DSH host is a single-instance application: when one already serves the panel, a new one exits
      // at once. Adopting the running instance avoids a restart loop that fights it.
      if (await alive()) {
        await log('another instance already serves the panel; waiting for it to end')
        await delay(10000)
        continue
      }
      // A host that was killed leaves its lock behind, and the next one refuses to start while it exists.
      await clearLock()
      const child = startHost()
      await writeFile(hostPidFile, String(child.pid), 'utf8')
      await log(`started the host (pid ${child.pid})`)
      const code = await new Promise(resolve => child.once('exit', (exitCode, signal) => resolve(exitCode ?? signal)))
      await rm(hostPidFile, { force: true })
      if (stopping) break
      // A host that keeps dying is a configuration problem, not a crash to retry forever.
      if (Date.now() - restartedAt > 600_000) { restarts = 0; restartedAt = Date.now() }
      restarts++
      await log(`the host exited (${code}); restarting (${restarts})`)
      if (restarts > 5) {
        await log('the host exited five times in a row; not restarting again. Run diagnose.mjs.')
        console.error('the host keeps exiting; run node local/scripts/diagnose.mjs')
        finished()
        process.exit(1)
      }
      await delay(5000)
    }
  }

  const shutdown = async () => {
    if (stopping) return
    stopping = true
    const pid = await readPid(hostPidFile)
    if (pid) await stopHost(pid)
    await clearLock()
    await rm(hostPidFile, { force: true })
    await rm(supervisorPidFile, { force: true })
    await log('stopped by request')
    finished()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })

  if (has('detach')) {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'start', '--profile', profile, '--dsh', appDir], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    console.log(`supervisor started in the background (pid ${child.pid})`)
    console.log(`the panel is at http://127.0.0.1:${listenPort}/`)
    process.exit(0)
  }

  // The supervisor records its own pid, so that a stop can end it before it restarts the host.
  await writeFile(supervisorPidFile, String(process.pid), 'utf8')

  console.log(`starting the ${profile} profile; the panel is at http://127.0.0.1:${listenPort}/`)
  void run()
  const ready = await waitForApi(90000)
  console.log(ready ? 'the panel is answering; the supervisor keeps it running until Ctrl+C' : 'the panel did not answer within 90 seconds; run node local/scripts/diagnose.mjs')
  if (!ready) { finished(); process.exit(1) }
  // The supervisor stays in the foreground: it restarts the host when it dies and stops it on Ctrl+C.
  await done
}

console.error(`unknown command: ${command}`)
process.exit(2)
