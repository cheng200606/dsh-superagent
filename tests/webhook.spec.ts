/**
 * The local webhook Source: a program POSTs a request to the loopback endpoint and it becomes a
 * Trigger. The tests drive the handler through fake HTTP objects, so they run the same way on every platform.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleWebhook, webhookKind, webhookTrigger, webhookTriggerId, type WebhookConfig } from '../src/sources/webhook.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'

const config: WebhookConfig = { token: '', actor: 'webhook' }

/** A POST request over a JSON body, as a caller would send it. */
function post(body: unknown, headers: Record<string, string> = { 'x-webhook-request': '1' }): IncomingMessage {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return { method: 'POST', headers, [Symbol.asyncIterator]: async function* () { yield payload } } as unknown as IncomingMessage
}
/** Collects the status and body one handler run answered. */
function answer(): { res: ServerResponse; result: () => { status: number; body: Record<string, unknown> } } {
  const carried = {} as { status?: number; text?: string }
  const res = { writeHead: (status: number) => { carried.status = status }, end: (text?: string) => { carried.text = text } } as unknown as ServerResponse
  return { res, result: () => ({ status: carried.status!, body: JSON.parse(carried.text!) }) }
}
/** A Source context that records what it received and what it reported. */
function fakeSource(received: Trigger[]) {
  const reports: { entry: string; health: unknown }[] = []
  return {
    receive: (trigger: Trigger) => { received.push(trigger); return 'stored' },
    report: (entry: string, health: unknown) => { reports.push({ entry, health }) },
    config: <C>(): C | undefined => config as C,
    reports,
  } as unknown as SourceContext & { reports: { entry: string; health: unknown }[] }
}

describe('the webhook request', () => {
  it('becomes a direct request from the configured sender on its own thread', () => {
    const trigger = webhookTrigger('run the checks', 'ci', '2026-01-01T00:00:00.000Z', 'id-1')
    expect(trigger.source).toBe('webhook')
    expect(trigger.actor).toEqual({ source: 'webhook', id: 'ci' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.threads).toEqual([{ source: 'webhook', id: 'webhook:ci' }])
    expect(trigger.channel).toEqual({ source: 'webhook', thread: 'webhook:ci', address: {} })
  })

  it('derives the same id from a caller key, and different ids from repeated posts without one', () => {
    expect(webhookTriggerId('ci', 'text', '2026-01-01T00:00:00.000Z', 'job-7'))
      .toBe(webhookTriggerId('ci', 'text', '2026-01-02T00:00:00.000Z', 'job-7'))
    expect(webhookTriggerId('ci', 'text', '2026-01-01T00:00:00.000Z'))
      .not.toBe(webhookTriggerId('ci', 'text', '2026-01-01T00:00:01.000Z'))
  })
})

describe('the webhook endpoint', () => {
  it('hands a POST to the Engine and answers with its admission result', async () => {
    const received: Trigger[] = []
    const source = fakeSource(received)
    const { res, result } = answer()
    await handleWebhook(source, config, post({ text: 'run the checks', key: 'job-7' }), res)
    expect(received).toHaveLength(1)
    expect(received[0]!.text).toBe('run the checks')
    expect(received[0]!.actor.id).toBe('webhook')
    expect(result()).toEqual({ status: 202, body: { status: 'stored', trigger_id: received[0]!.id, thread: 'webhook:webhook' } })
    expect(source.reports.at(-1)).toMatchObject({ entry: 'webhook', health: { state: 'ready' } })
  })

  it('honours an actor override in the body', async () => {
    const received: Trigger[] = []
    const { res } = answer()
    await handleWebhook(fakeSource(received), config, post({ text: 'from the IDE', actor: 'ide' }), res)
    expect(received[0]!.actor.id).toBe('ide')
    expect(received[0]!.threads).toEqual([{ source: 'webhook', id: 'webhook:ide' }])
  })

  it('refuses a caller without the request header, before it learns anything else', async () => {
    const received: Trigger[] = []
    const { res, result } = answer()
    await handleWebhook(fakeSource(received), config, post({ text: 'x' }, {}), res)
    expect(received).toHaveLength(0)
    expect(result()).toEqual({ status: 403, body: { error: 'Send the x-webhook-request: 1 header' } })
  })

  it('asks for the token when one is configured, and compares it without leaking it', async () => {
    const received: Trigger[] = []
    const secured = { ...config, token: 's3cret' }
    const { res, result } = answer()
    await handleWebhook(fakeSource(received), secured, post({ text: 'x' }), res)
    expect(result().status).toBe(401)
    const { res: ok } = answer()
    await handleWebhook(fakeSource(received), secured, post({ text: 'x' }, { 'x-webhook-request': '1', 'x-webhook-token': 's3cret' }), ok)
    expect(received).toHaveLength(1)
  })

  it('answers 503 while the Source is off, and 405 for a read', async () => {
    const received: Trigger[] = []
    const { res, result } = answer()
    await handleWebhook(fakeSource(received), undefined, post({ text: 'x' }), res)
    expect(result().status).toBe(503)
    const { res: get, result: getResult } = answer()
    await handleWebhook(fakeSource(received), config, { method: 'GET', headers: { 'x-webhook-request': '1' } } as unknown as IncomingMessage, get)
    expect(getResult().status).toBe(405)
    expect(received).toHaveLength(0)
  })

  it('rejects a body without text or with a malformed one', async () => {
    const received: Trigger[] = []
    const source = fakeSource(received)
    const { res, result } = answer()
    await handleWebhook(source, config, post({ key: 'no text' }), res)
    expect(result().status).toBe(400)
    const { res: bad, result: badResult } = answer()
    await handleWebhook(source, config, post('not json'), bad)
    expect(badResult().status).toBe(400)
    expect(received).toHaveLength(0)
  })

  it('leaves the endpoint without a reply channel, on purpose', () => {
    expect(webhookKind.channel).toBeUndefined()
    expect(webhookKind.threadContext).toBeDefined()
  })
})
