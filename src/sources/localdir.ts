/**
 * A Source that reads requests from a directory on the operator's machine.
 *
 * The agent watches a folder: every file dropped into it is a request, the file's text is the request, and
 * the agent's answer is written next to it. It needs no account, no network and no other program, which makes
 * it the shortest path from "an idea" to "a ticket" — and the way to try the whole system without a GitHub
 * account, a bot or a webhook endpoint.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const ConfigSchema = z.object({
  /** The folder to watch; empty until an operator names one. */
  directory: z.string().trim().default(''),
  /** Which files count as a request; a simple suffix match, such as `.md`. */
  suffix: z.string().trim().default('.md'),
  /** The sender id this Source speaks for; it must be on the Policy's allowed list. */
  actor: z.string().trim().min(1).default('local'),
  /** How often the folder is read. */
  pollSeconds: z.number().int().min(5).max(3600).default(30),
  /** What the answer's file name ends with. */
  replySuffix: z.string().trim().default('.reply.md'),
}).strict()
export type LocaldirConfig = z.infer<typeof ConfigSchema>

/** The version of a file that makes a new request: its size and the moment it was written. */
const version = (size: number, modified: number): string => `${size}:${Math.floor(modified)}`

/** The Trigger of one file; a file that was not changed since it was read produces none. */
export function localdirTrigger(path: string, text: string, sender: string, at: string, fileVersion: string): Trigger {
  return {
    id: key('localdir', path, fileVersion),
    source: 'localdir',
    threads: [{ source: 'localdir', id: path }],
    actor: { source: 'localdir', id: sender },
    human: true,
    // A file in the watched folder is a request addressed to the agent; nothing else could be meant by it.
    addressed: 'direct',
    at,
    text,
    channel: { source: 'localdir', thread: `localdir:${path}`, address: { path } },
    meta: { path, version: fileVersion },
  }
}

/** The answer of a request, written next to the file that asked it. */
export async function sendLocaldir(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { path } = message.channel.address
  if (!path) throw new Error('Missing local directory reply target')
  const reply = join(path.replace(/\.[^.]*$/, '') + '.reply.md')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  let existing = ''
  try { existing = await readFile(reply, 'utf8') } catch { /* The answer is written for the first time. */ }
  if (existing.includes(marker)) return 'sent'
  await writeFile(reply, `${marker}\n\n${message.text}\n`, 'utf8')
  return 'sent'
}

export const localdirKind: SourceKind<LocaldirConfig> = {
  kind: 'localdir',
  title: { zh: '本地目录', en: 'Local directory' },
  description: { zh: '监视一个本地文件夹；放进去的文件就是交给智能体的请求，答案写在同名文件旁。', en: 'Watches a local folder: a file dropped in is a request for the agent, and its answer is written beside it.' },
  schema: ConfigSchema,
  fields: [
    { key: 'directory', type: 'text', label: { zh: '监视的文件夹', en: 'Watched folder' },
      hint: { zh: '绝对路径，例如 C:/tasks。文件夹里的每个文件都是一份请求。', en: 'An absolute path, for example C:/tasks. Every file in it is a request.' } },
    { key: 'suffix', type: 'text', label: { zh: '文件后缀', en: 'File suffix' }, advanced: true,
      hint: { zh: '只读取这个后缀的文件，留空表示全部。', en: 'Only files with this suffix are read; empty reads every file.' } },
    { key: 'actor', type: 'text', label: { zh: '发送者', en: 'Sender' }, advanced: true,
      hint: { zh: '这些请求以谁的名义发出；需要出现在策略允许名单里。', en: 'Who these requests come from; the id must be on the Policy allowed list.' } },
    { key: 'pollSeconds', type: 'number', min: 5, max: 3600, advanced: true, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['localdir'],
  scope: ({ meta }, config) => {
    const path = String(meta.path ?? '')
    if (!config.directory) return { listened: false, reason: 'no_directory' }
    if (!path || !resolve(path).startsWith(resolve(config.directory))) return { listened: false, reason: 'outside_directory' }
    return { listened: true, observed: false, row: 'local' }
  },
  channel: {
    allowed: (address, config) => {
      const path = String(address.path ?? '')
      return !!config.directory && !!path && resolve(path).startsWith(resolve(config.directory))
    },
    send: sendLocaldir,
    link: address => ({ url: '', label: { zh: `本地文件 ${basename(String(address.path ?? ''))}`, en: `Local file ${basename(String(address.path ?? ''))}` } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.version ?? ''),
    read: async (_commands, trigger) => {
      const path = String(trigger.meta.path ?? '')
      let text = ''
      try { text = await readFile(path, 'utf8') } catch { /* The file was removed; the trigger keeps its text. */ }
      const message = { id: String(trigger.meta.version ?? ''), from: String(trigger.actor.id), at: trigger.at, text }
      return { messages: [message], body: { messages: [message] } }
    },
  },
  find: query => {
    const threads = [...query.matchAll(/[A-Za-z]:[\\/][^\s"'<>|]+/g)].map(match => `localdir:${match[0]}`)
    return { threads, terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '把文件放进监视的文件夹就是向智能体发起请求。', en: 'Dropping a file into the watched folder asks the agent for work.' },
    rows: () => [{ id: 'local', label: { zh: '本地目录', en: 'Local directory' }, note: { zh: '监视的文件夹', en: 'The watched folder' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_LOCALDIR_PATH', description: {
      zh: '发起这份工单的文件路径；工单不是来自本地目录时为空',
      en: 'The file that started this ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_LOCALDIR_PATH: trigger?.source === 'localdir' ? String(trigger.meta.path ?? '') : '',
    }),
  },
}

/** Reads the folder once and hands every new or changed file to the Engine. */
export async function pollLocaldir(ctx: SourceContext, config: LocaldirConfig, signal: AbortSignal): Promise<number> {
  if (!config.directory) {
    ctx.report('localdir', { state: 'paused', detail: 'No folder is watched yet' })
    return 0
  }
  const directory = resolve(config.directory)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    ctx.report('localdir', { state: 'error', detail: `the watched folder cannot be read: ${String(error)}` })
    return 0
  }
  const seen = { ...(ctx.state.get(KV.localdir.seen) ?? {}) }
  let received = 0
  for (const name of entries) {
    if (signal.aborted) break
    if (config.suffix && !name.endsWith(config.suffix)) continue
    if (name.endsWith('.reply.md')) continue
    const path = join(directory, name)
    let info: Awaited<ReturnType<typeof stat>>
    try { info = await stat(path) } catch { continue }
    if (!info.isFile()) continue
    const fileVersion = version(info.size, info.mtimeMs)
    if (seen[path] === fileVersion) continue
    let text = ''
    try { text = await readFile(path, 'utf8') } catch { continue }
    const trigger = localdirTrigger(path, text.trim(), config.actor, new Date(info.mtimeMs).toISOString(), fileVersion)
    // The cursor advances only after the Engine stored the trigger, so a failed read is retried.
    await ctx.receive(trigger)
    seen[path] = fileVersion
    received++
  }
  ctx.atomic(() => { ctx.state.set(KV.localdir.seen, seen) })
  return received
}

/** The polling loop; it ends when the Source is stopped. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  for (;;) {
    const config = ctx.config<LocaldirConfig>('localdir')
    if (!config) {
      ctx.report('localdir', { state: 'paused', detail: 'The Source is off' })
    } else {
      const received = await pollLocaldir(ctx, config, signal)
      ctx.report('localdir', { state: 'ready', detail: `${received} new request(s) in the last round`, at: new Date().toISOString() })
    }
    await new Promise(resolve => setTimeout(resolve, (config?.pollSeconds ?? 30) * 1000))
    if (signal.aborted) break
  }
}

export const name = 'dsh-superagent-localdir'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localdirKind), 'localdir: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, localdirKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('localdir', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
