/**
 * Record retention: records past the cutoff that started no ticket are deleted; anything an open ticket or a recent
 * thread still needs stays.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Decision, Thread, Ticket, Trigger, TriggerDisposition } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'

let directory: string
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const DAY = 86_400_000
const at = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
const trigger = (id: string, when: string, threads: string[]): Trigger =>
  ({ id, source: 'feishu', threads: threads.map(thread => ({ source: 'feishu', id: thread.slice('feishu:'.length) })),
    actor: { source: 'feishu', id: 'ou_alice' }, human: true, addressed: 'direct', at: when, text: `text of ${id}`,
    channel: { source: 'feishu', thread: threads[0]!, address: {} }, meta: {} })
const disposition = (id: string, value: Partial<TriggerDisposition> = {}): TriggerDisposition =>
  ({ fanout: [], at: at(1), ...value })
const decision = (id: string, thread: string, when: string, fields: Partial<Decision> = {}): Decision =>
  ({ id, evalId: `eval-${id}`, threadKey: thread, triggerIds: [`tr-${id}`], policyVersion: 'v', at: when, kind: 'ignore',
    reason: [{ code: 'admission_ignored' }], strength: 'inferred', ...fields })
const ticket = (id: string, when: string, fields: Partial<Ticket> = {}): Ticket => ({ id, title: `ticket ${id}`, decisionId: `dec-${id}`,
  assignments: [], inputs: [], undelivered: [], createdAt: when, updatedAt: when,
  origin: { triggerId: `tr-${id}`, triggerIds: [`tr-${id}`] }, channels: [], mandate: {} as Ticket['mandate'], ...fields })
const thread = (key: string, fields: Partial<Thread> = {}): Thread =>
  ({ key, ref: { source: 'feishu', id: key.slice('feishu:'.length) }, createdAt: at(2), correlated: [], subscriptions: [], pending: [],
    lastAt: at(1), meta: {}, ...fields })

function store(): Store {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-retain-'))
  return new Store(join(directory, 'db.sqlite'))
}

it('deletes filtered triggers and ticketless decisions past the cutoff, and their dispositions', () => {
  const db = store()
  try {
    db.triggers.save(trigger('old-filtered', at(40), ['feishu:chat']))
    db.triggers.saveDisposition('old-filtered', disposition('old-filtered', { filtered: { code: 'not_a_member' }, at: at(40) }))
    db.triggers.save(trigger('old-resolved', at(40), ['feishu:chat']))
    db.triggers.saveDisposition('old-resolved', disposition('old-resolved', { fanout: [], at: at(40) }))
    db.decisions.save(decision('old-ignore', 'feishu:chat', at(40)))
    db.triggers.save(trigger('fresh', at(1), ['feishu:chat']))
    const deleted = db.retain(at(30))
    expect(deleted).toEqual({ triggers: 2, decisions: 1 })
    expect(db.triggers.get('old-filtered')).toBeUndefined()
    expect(db.triggers.get('old-resolved')).toBeUndefined()
    expect(db.triggers.disposition('old-filtered')).toBeUndefined()
    expect(db.decisions.get('old-ignore')).toBeUndefined()
    expect(db.triggers.get('fresh')).toBeDefined()
  } finally { db.close() }
})

it('keeps what an open ticket, a recent thread, or any ticket\'s origin names', () => {
  const db = store()
  try {
    // An open ticket on the thread protects everything on it, whatever its age.
    db.threads.save(thread('feishu:busy', { subscriptions: ['t-open'], lastAt: at(40) }))
    db.triggers.save(trigger('tr-open-origin', at(40), ['feishu:busy']))
    db.tickets.save(ticket('t-open', at(40), { origin: { triggerId: 'tr-open-origin', triggerIds: ['tr-open-origin'] } }))
    // An ended ticket's origin trigger stays even on an unprotected thread; its ticketless decision does not.
    db.threads.save(thread('feishu:idle', { lastAt: at(40) }))
    db.triggers.save(trigger('tr-ended-origin', at(40), ['feishu:idle']))
    db.tickets.save(ticket('t-ended', at(40), { ended: { at: at(2), by: 'executor' as const, outcome: 'completed' as const },
      origin: { triggerId: 'tr-ended-origin', triggerIds: ['tr-ended-origin'] } }))
    db.triggers.save(trigger('tr-stray', at(40), ['feishu:idle']))
    const deleted = db.retain(at(30))
    expect(db.triggers.get('tr-open-origin')).toBeDefined()
    expect(db.triggers.get('tr-ended-origin')).toBeDefined()
    expect(db.triggers.get('tr-stray')).toBeUndefined()
    expect(deleted.triggers).toBe(1)
  } finally { db.close() }
})

it('keeps every record while the cutoff is open-ended, and deletes nothing twice', () => {
  const db = store()
  try {
    db.triggers.save(trigger('tr-1', at(400), ['feishu:chat']))
    db.decisions.save(decision('dec-1', 'feishu:chat', at(400)))
    expect(db.retain('')).toEqual({ triggers: 0, decisions: 0 })
    expect(db.triggers.get('tr-1')).toBeDefined()
    expect(db.retain(at(30))).toEqual({ triggers: 1, decisions: 1 })
    expect(db.retain(at(30))).toEqual({ triggers: 0, decisions: 0 })
  } finally { db.close() }
})
