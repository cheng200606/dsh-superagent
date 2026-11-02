/**
 * What the plugin needs from the host's tool registry, resolved at runtime instead of trusted by name.
 *
 * A DSH build names and shapes its tools as it likes — one had `bash`, this one has `pwsh` — and
 * `tools.restrict()` refuses a name the host does not know, which used to stop the plugin from activating at
 * all. The allow lists here state intent by role (shell, reading, job inspection), and resolution keeps only
 * what this Session's scope actually exposes; a tool the host renamed is found again by its parameters (a
 * command runner takes a `command` string), not by guessing names.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'

/** The part of the tool registry a Session decorates with; the registry types carry more, and a host may carry less. */
export interface ToolRegistry {
  /** The tool `name` as `scope` resolves it, or undefined when that scope does not know it. */
  get(name: string, scope?: object): { parameters?: Record<string, unknown> } | undefined
  /** Restricts the global tools `scope` inherits; throws for a name it will not restrict. */
  restrict(filter: { allow: string[] }): () => void
  /** Lists the tools `scope` resolves, when the host exposes enumeration at all. */
  schemas?(scope?: object): { name: string; parameters: Record<string, unknown> }[]
}

/** Names a shell tool has had, or plausibly takes; shape decides when the definition says more. */
export const SHELL_ALIASES: readonly string[] = ['bash', 'pwsh', 'powershell', 'shell', 'terminal']

/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
export const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** The tools the main Session keeps: routing, reading, and watching work, but none that does the work itself. */
export const MASTER_TOOLS = ['skill', 'bash', 'pwsh', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']

/** Whether a tool's parameters make it a command runner: an object schema with a `command` string. */
export function commandShaped(parameters: Record<string, unknown> | undefined): boolean {
  const properties = parameters !== null && typeof parameters === 'object'
    ? (parameters as { properties?: Record<string, unknown> }).properties : undefined
  const command = properties?.command
  if (command === null || typeof command !== 'object') return false
  const type = (command as { type?: unknown }).type
  return type === 'string' || Array.isArray(type) && type.includes('string')
}

/** The tool `name` as the agent's inherited scope resolves it — what a restriction may name — or undefined. */
export function knownTool(agent: Agent, name: string): { parameters?: Record<string, unknown> } | undefined {
  return (agent.ctx.tools as unknown as ToolRegistry).get(name, scopeParentOf(agent))
}

/** Whether `name` is this agent's shell tool: a `command` runner by parameters, or a known shell name the registry knows. */
export function isShellTool(agent: Agent, name: string): boolean {
  const definition = knownTool(agent, name)
  if (!definition) return false
  return commandShaped(definition.parameters) || (definition.parameters === undefined && SHELL_ALIASES.includes(name))
}

/**
 * The shell tools the agent's scope exposes: the known aliases it knows, plus any tool with a `command` string that
 * enumeration reveals. Enumeration is a courtesy of the registry, not a promise — a host without it still gets the aliases.
 */
export function shellTools(agent: Agent): string[] {
  const names = SHELL_ALIASES.filter(name => isShellTool(agent, name))
  const listed = (agent.ctx.tools as unknown as ToolRegistry).schemas?.(scopeParentOf(agent))
  if (listed) for (const schema of listed) if (!names.includes(schema.name) && commandShaped(schema.parameters)) names.push(schema.name)
  return names
}

/** The candidates this agent's scope restricts, in the candidate order; names it does not know drop out. */
export function restrictableTools(agent: Agent, candidates: readonly string[]): string[] {
  return candidates.filter(name => knownTool(agent, name))
}

/**
 * The tools of an Executor Session: its role's candidates, plus a shell the host renamed that enumeration found.
 */
export function workerAllow(agent: Agent): { allow: string[]; detected: readonly string[] } {
  return allowOf(agent, WORK_TOOLS)
}
/** The tools of the main Session: its role's candidates, plus a shell the host renamed that enumeration found. */
export function masterAllow(agent: Agent): { allow: string[]; detected: readonly string[] } {
  return allowOf(agent, MASTER_TOOLS)
}
function allowOf(agent: Agent, candidates: readonly string[]): { allow: string[]; detected: readonly string[] } {
  const allow = restrictableTools(agent, candidates)
  const detected = shellTools(agent).filter(name => !allow.includes(name))
  return { allow: [...allow, ...detected], detected }
}

/**
 * Restricts `allow` on the agent; the detected additions (found by parameters, not by name) are the only ones a host may
 * still refuse — a restriction may not name a tool of the agent's own layer — so one refusal retries without them, and a
 * second failure is a real mismatch that should surface.
 */
export function restrictAllow(agent: Agent, allow: readonly string[], detected: readonly string[]): (() => void) {
  const tools = agent.ctx.tools as unknown as ToolRegistry
  try {
    return tools.restrict({ allow: [...allow] })
  } catch (error) {
    const reduced = allow.filter(name => !detected.includes(name))
    if (reduced.length === allow.length) throw error
    return tools.restrict({ allow: reduced })
  }
}
