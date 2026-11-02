/**
 * The operator's own request path: a ticket created directly in the management panel or its API.
 *
 * It enters the Engine as any request does — a Trigger from a Source — so admission, the Mandate, the worker and the
 * panel all treat it the same way. The Source kind is the operator's admission identity: its Policy roster keeps the
 * operator on the allowed list by syncing it, the way a Feishu chat keeps its members.
 */
import { z } from 'zod'
import { UserError, key, type DecisionKind, type EngineForMainSession, type EngineForSources, type ReceiveResult,
  type Trigger } from '../core/index.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import type { SourceKind } from '../sources/kind.ts'

/** The sender id of every operator request; the kind's roster sync keeps it on the Policy's allowed list. */
export const OPERATOR = 'operator'

const ConfigSchema = z.object({}).strict()

/** The Trigger of one operator request; its own Thread, so no other ticket's subscriptions reach it. */
export function manualTrigger(text: string, at: string): Trigger {
  const id = key('manual', at, text)
  return {
    id, source: 'manual',
    threads: [{ source: 'manual', id }],
    actor: { source: 'manual', id: OPERATOR },
    human: true,
    // The operator filling in the panel is asking the agent directly.
    addressed: 'direct',
    at, text,
    channel: { source: 'manual', thread: `manual:${id}`, address: {} },
    meta: {},
  }
}

export const manualKind: SourceKind<Record<string, never>> = {
  kind: 'manual',
  title: { zh: '面板请求', en: 'Panel requests' },
  description: { zh: '操作者在管理面板或管理 API 里直接填写的请求；操作者始终在允许名单里，无需配置。', en: 'Requests the operator writes directly in the management panel or its API; the operator is always on the allowed list, with nothing to configure.' },
  schema: ConfigSchema,
  fields: [],
  health: [],
  scope: () => ({ listened: true, observed: false, row: 'manual' }),
  threadContext: {
    messageId: trigger => trigger.id,
    read: async (_commands, trigger) => {
      const message = { id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text }
      return { messages: [message], body: { messages: [message] } }
    },
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '在面板里填写请求就是向智能体发起请求。', en: 'Filling in a request in the panel asks the agent for work.' },
    rows: () => [{ id: 'manual', label: { zh: '面板请求', en: 'Panel requests' }, note: { zh: '管理面板与管理 API 的操作者', en: 'The operator of the panel and its API' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
    // The roster is the operator alone, and it is authoritative: a synced list behaves as the Feishu roster does.
    sync: {
      label: { zh: '操作者', en: 'Operator' },
      ready: () => true,
      run: async (_host, part) => ({ ...part, allowed: [{ id: OPERATOR, name: 'Operator' }] }),
    },
  },
}

export const ManualRequestSchema = z.object({
  /** The request itself; what the agent is asked to do. */
  text: z.string().trim().min(1).max(100_000),
  /** A short label of the request; the first line of `text` when omitted. */
  title: z.string().trim().max(200).optional(),
}).strict()
export type ManualRequest = z.infer<typeof ManualRequestSchema>

/** What the manual creation needs of the application; the Runtime provides it. */
export interface ManualHost {
  configured(): boolean
  readonly setupProblem?: SetupProblem | undefined
  receive(trigger: Trigger): ReceiveResult
  engine: Pick<EngineForMainSession, 'decide'> & Pick<EngineForSources, 'receive'>
  requestPass(): void
}

const titleOf = (request: ManualRequest): string => request.title
  ?? request.text.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? request.text.slice(0, 200)

/** A worktree name for a request without one: the title's ASCII words, or `manual` and the moment when it has none. */
export function manualWorktreeName(request: ManualRequest, at: string): string {
  const words = titleOf(request).toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []
  let name = ''
  for (const word of words.slice(0, 3)) {
    const next = name ? `${name}-${word}` : word
    if (next.length > 32) break
    name = next
  }
  return name || `manual-${Math.max(0, Date.parse(at)).toString(36)}`
}

/**
 * Creates a ticket for an operator request: the trigger is stored, accepted at once under the operator's explicit
 * request, and a pass starts its worker. The panel shows the ticket like any other.
 * @throws a SetupError while the deployment check has not finished, and a UserError when the Policy does not admit
 *   the request or a worker already decides it.
 */
export function createManualTicket(host: ManualHost, request: ManualRequest): { trigger_id: string; decision: DecisionKind; ticket_id?: string } {
  if (!host.configured()) {
    if (host.setupProblem) throw new SetupError(host.setupProblem.code, host.setupProblem.values)
    throw new UserError('setupComplete')
  }
  const trigger = manualTrigger(request.text, new Date().toISOString())
  const received = host.receive(trigger)
  if (received !== 'stored') throw new UserError('notAdmissible', { reason: received })
  const title = titleOf(request)
  const decision = host.engine.decide(trigger.id, { kind: 'accept', title, scope: title, name: manualWorktreeName(request, trigger.at),
    reason: { code: 'explicitRouted' } })
  if (decision.kind !== 'accept' || !decision.ticketId) throw new UserError('notExplicit')
  host.requestPass()
  return { trigger_id: trigger.id, decision: decision.kind, ticket_id: decision.ticketId }
}
