/**
 * The operator's manual request path: a panel request becomes a stored, at-once-accepted explicit
 * request with a ticket and a running worker, and the operator's roster keeps the Policy allowing it.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { Setup } from '../src/app/setup.ts'
import { createManualTicket, manualKind, manualTrigger, ManualRequestSchema, OPERATOR } from '../src/app/manual.ts'
import type { Host } from './fixtures/host.ts'
import { startRuntime } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('keeps the operator on the Policy allowed list by syncing its roster', async () => {
  h = await startRuntime()
  await vi.waitFor(() => expect(h!.runtime.health['sync:manual']).toMatchObject({ state: 'ready' }))
  expect(h.runtime.store.settings().policy.sources.manual?.allowed).toEqual([{ id: OPERATOR, name: 'Operator' }])
  // The roster stays authoritative: a sync re-adds the operator after a removal.
  const { settings } = h.runtime
  const part = await settings.sync('manual')
  expect(part.allowed).toEqual([{ id: OPERATOR, name: 'Operator' }])
})

it('creates a ticket for an operator request at once, with its own thread', async () => {
  h = await startRuntime()
  await vi.waitFor(() => expect(h!.runtime.health['sync:manual']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  const result = createManualTicket(h.runtime, ManualRequestSchema.parse({ text: '把 README 的安装一节翻译成英文\n第二行' }))
  expect(result.decision).toBe('accept')
  expect(result.ticket_id).toBeDefined()
  const ticket = h.runtime.store.tickets.get(result.ticket_id!)!
  expect(ticket.title).toBe('把 README 的安装一节翻译成英文')
  expect(ticket.mandate.strength).toBe('explicit')
  expect(ticket.mandate.actor).toEqual({ source: 'manual', id: OPERATOR })
  const trigger = h.runtime.store.triggers.get(result.trigger_id)!
  expect(trigger.threads).toEqual([{ source: 'manual', id: trigger.id }])
  expect(h.runtime.store.threads.get(`manual:${trigger.id}`)?.subscriptions).toContain(ticket.id)
  // A second request is its own thread and its own ticket.
  const second = createManualTicket(h.runtime, ManualRequestSchema.parse({ text: '修正 README 的错字', title: '修错字' }))
  expect(second.ticket_id).not.toBe(result.ticket_id)
  expect(h.runtime.store.tickets.get(second.ticket_id!)!.title).toBe('修错字')
  await h.runtime.idle()
})

it('refuses a request while the deployment check waits, and an empty one', async () => {
  h = await startRuntime()
  await vi.waitFor(() => expect(h!.runtime.health['sync:manual']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  try {
    h.runtime.setup.problem = { place: 'deployment', code: 'repositoryUnset', values: {}, detail: 'unset' }
    expect(() => createManualTicket(h!.runtime, ManualRequestSchema.parse({ text: 'x' }))).toThrow(/repository/)
  } finally {
    vi.mocked(Setup.prototype.configured).mockRestore()
    delete (h.runtime.setup as { problem?: unknown }).problem
  }
  expect(() => ManualRequestSchema.parse({ text: '  ' })).toThrow()
})

it('builds a direct request trigger addressed to the agent', () => {
  const trigger = manualTrigger('do the thing', '2026-01-01T00:00:00.000Z')
  expect(trigger.source).toBe('manual')
  expect(trigger.actor).toEqual({ source: 'manual', id: OPERATOR })
  expect(trigger.human).toBe(true)
  expect(trigger.addressed).toBe('direct')
  expect(trigger.threads).toEqual([{ source: 'manual', id: trigger.id }])
  // The manual kind declares no health of its own and no fields: there is nothing to configure or watch.
  expect(manualKind.health).toEqual([])
  expect(manualKind.fields).toEqual([])
})
