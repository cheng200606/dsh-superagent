/**
 * A Source that takes requests from a loopback HTTP endpoint.
 *
 * A program on this machine — an IDE task, a CI job, a script, a cron line — posts a request to
 * `/orchestrator/webhook` and it becomes a ticket, with no account, repository or bot in between. The endpoint is on the
 * loopback Web server only; a browser page cannot reach it (a custom request header forces a preflight no page answers),
 * and a shared token can be required on top. Replies have no channel to go to: the request's outcome is read from the
 * management panel or its API, by the same caller that posted the work.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const MAX_BODY_BYTES = 256 * 1024
const ConfigSchema = z.object({
  /** A shared secret callers must send as `x-webhook-token`; empty trusts the loopback alone. */
  token: z.string().trim().max(200).default(''),
  /** The sender id these requests speak for; it must be on the Policy's allowed list. */
  actor: z.string().trim().min(1).max(200).default('webhook'),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

const RequestSchema = z.object({
  /** The request itself; what the agent is asked to do. */
  text: z.string().trim().min(1).max(100_000),
  /** A caller-chosen id: resending the same `key` is the same request, not a new one. */
  key: z.string().trim().min(1).max(200).optional(),
  /** Who asks, when the endpoint serves more than one sender; must be on the Policy's allowed list. */
  actor: z.string().trim().min(1).max(200).optional(),
}).strict()
export type WebhookRequest = z.infer<typeof RequestSchema>

/**
 * The id of one webhook request. A caller's `key` makes resends the same Trigger; without one, every POST is its own
 * request — a job rerun asking again is a new ticket, not a swallowed duplicate.
 */
export function webhookTriggerId(sender: string, text: string, at: string, idempotencyKey?: string): string {
  return idempotencyKey ? key('webhook', sender, idempotencyKey) : key('webhook', sender, text, at)
}

/** The Trigger of one webhook request; the POST itself is a direct request to the agent. */
export function webhookTrigger(text: string, sender: string, at: string, id: string): Trigger {
  return {
    id, source: 'webhook',
    threads: [{ source: 'webhook', id: `webhook:${sender}` }],
    actor: { source: 'webhook', id: sender },
    human: true,
    // Posting to the endpoint is asking the agent directly; nothing else could be meant by it.
    addressed: 'direct',
    at, text,
    channel: { source: 'webhook', thread: `webhook:${sender}`, address: {} },
    meta: { sender },
  }
}

/** The endpoint does not carry answers back; a caller reads its ticket's outcome from the management API instead. */
export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: '本地 Webhook', en: 'Local webhook' },
  description: { zh: '本机程序向一个回环地址 POST 请求即可派活：IDE、CI、脚本、计划任务都能发起工单；结果在面板或管理 API 里读。', en: 'A program on this machine POSTs a request to a loopback address: an IDE task, a CI job, a script or a cron line starts a ticket; its outcome is read from the panel or the management API.' },
  schema: ConfigSchema,
  fields: [
    { key: 'token', type: 'text', label: { zh: '共享令牌', en: 'Shared token' },
      hint: { zh: '调用方需在 x-webhook-token 头里带上它；留空表示只信任本机回环。', en: 'Callers send it in the x-webhook-token header; empty trusts the loopback alone.' } },
    { key: 'actor', type: 'text', label: { zh: '发送者', en: 'Sender' }, advanced: true,
      hint: { zh: '这些请求以谁的名义发出；需要出现在策略允许名单里。', en: 'Who these requests come from; the id must be on the Policy allowed list.' } },
  ],
  health: ['webhook'],
  scope: () => ({ listened: true, observed: false, row: 'webhook' }),
  threadContext: {
    messageId: trigger => trigger.id,
    read: async (_commands, trigger) => {
      const message = { id: trigger.id, from: String(trigger.actor.id), at: trigger.at, text: trigger.text }
      return { messages: [message], body: { messages: [message] } }
    },
  },
  find: query => {
    const sender = query.trim()
    return sender ? { threads: [`webhook:${sender}`], terms: [] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '向本机回环端点 POST 一份请求就是向智能体发起请求。', en: 'POSTing a request to the loopback endpoint asks the agent for work.' },
    rows: () => [{ id: 'webhook', label: { zh: '本地 Webhook', en: 'Local webhook' }, note: { zh: '回环端点的调用方', en: 'Callers of the loopback endpoint' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_SENDER', description: {
      zh: '发起这份工单的发送者；工单不是来自本地 Webhook 时为空',
      en: 'The sender that started this ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_SENDER: trigger?.source === 'webhook' ? String(trigger.meta.sender ?? '') : '',
    }),
  },
}

const sameToken = (expected: string, given: string | undefined): boolean => {
  if (!given) return false
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(given).digest()
  return timingSafeEqual(left, right)
}

/** A client-facing error the endpoint answers with its status and body. */
export class WebhookError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.error ?? status)) }
}

/** Reads the request body within a limit; a larger or non-JSON body is a client error. */
export async function readRequest(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new WebhookError(413, { error: `The request exceeds ${maxBytes} bytes` })
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown }
  catch (error) {
    if (error instanceof WebhookError) throw error
    throw new WebhookError(400, { error: 'The request body is not JSON' })
  }
}

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

/**
 * Answers one POST: validates the caller and the body, hands the request to the Engine, and reports the admission
 * result. A wrong token says so without hinting at the expected one.
 */
export async function handleWebhook(source: SourceContext, config: WebhookConfig | undefined, req: IncomingMessage,
  res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') throw new WebhookError(405, { error: 'POST a JSON body to this endpoint' })
    // A browser page cannot send a custom header without a preflight this endpoint never answers, so even a
    // tokenless webhook is out of a page's reach; a program adds one line.
    if (req.headers['x-webhook-request'] !== '1') throw new WebhookError(403, { error: 'Send the x-webhook-request: 1 header' })
    if (!config) throw new WebhookError(503, { error: 'The webhook Source is off' })
    if (config.token && !sameToken(config.token, req.headers['x-webhook-token'] as string | undefined))
      throw new WebhookError(401, { error: 'A valid x-webhook-token header is required' })
    const request = RequestSchema.parse(await readRequest(req))
    const sender = request.actor ?? config.actor
    const at = new Date().toISOString()
    const trigger = webhookTrigger(request.text, sender, at, webhookTriggerId(sender, request.text, at, request.key))
    const result = await source.receive(trigger)
    source.report('webhook', { state: 'ready', detail: `last request ${at}`, at })
    json(res, 202, { status: result, trigger_id: trigger.id, thread: `webhook:${sender}` })
  } catch (error) {
    if (error instanceof z.ZodError) {
      json(res, 400, { error: 'Invalid request', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) })
      return
    }
    if (error instanceof WebhookError) { json(res, error.status, error.body); return }
    source.report('webhook', { state: 'error', detail: String(error) })
    json(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The endpoint, owned by the Web server rather than by one fiber, for the reason the management route is: DSH keys
 * its routes by path and refuses a second registration while the previous fiber's disposer may still be on its way,
 * so a restart re-points one registration at the handler that is current instead of registering anew.
 */
interface Endpoint { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; remove: () => void }
const endpoints = new WeakMap<object, Endpoint>()

export function registerWebhook(ctx: Context, source: SourceContext): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('The webhook Source requires a loopback Web server')
  const webServer = ctx.webServer
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    handleWebhook(source, source.config<WebhookConfig>('webhook'), req, res)
  const existing = endpoints.get(webServer)
  if (existing) existing.handle = handle
  else {
    const remove = webServer.register({ kind: 'exact', path: '/orchestrator/webhook', handler: async (req, res) => {
      const current = endpoints.get(webServer)
      if (!current) { json(res, 503, { error: 'The webhook Source is not running' }); return }
      await current.handle(req, res)
    } })
    endpoints.set(webServer, { handle, remove })
  }
  return () => {
    const current = endpoints.get(webServer)
    if (current?.handle !== handle) return
    endpoints.delete(webServer)
    current.remove()
  }
}

export const name = 'dsh-superagent-webhook'
// The endpoint sits on the host's Web server, and the Source protocol comes from the orchestrator.
export const inject = ['orchestrator', 'webServer']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    // Say what the endpoint will do before the first request tells it: off until configured, on when it is.
    source.report('webhook', source.config<WebhookConfig>('webhook')
      ? { state: 'ready', detail: 'Waiting for requests on /orchestrator/webhook' }
      : { state: 'paused', detail: 'The Source is off' })
    return registerWebhook(ctx, source)
  })
}
