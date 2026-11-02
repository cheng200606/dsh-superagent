/** The capability-detection layer: allow lists keep only what a scope exposes, and a renamed shell is found by its shape. */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { commandShaped, isShellTool, masterAllow, restrictAllow, restrictableTools, SHELL_ALIASES, shellTools,
  workerAllow, type ToolRegistry } from '../src/app/capabilities.ts'

/** A fake agent whose registry holds `inherited` tools (as a preset scope would) and optional own-layer tools. */
function fakeAgent(inherited: string[], options: {
  /** Parameters served per tool name; a name without parameters serves none, as a bare registry would. */
  parameters?: Record<string, { parameters?: Record<string, unknown> }>
  /** Tools of the agent's own layer, which a restriction may not name. */
  own?: string[]
  /** Whether the registry offers enumeration at all; a host may not. */
  schemas?: boolean
} = {}): Agent {
  const ctx = { tools: {
    get: (name: string, scope?: object) => {
      if (scope === agent) return options.own?.includes(name) ? { name } : undefined
      if (scope !== preset) return undefined
      if (!inherited.includes(name)) return undefined
      return options.parameters?.[name] ?? { name }
    },
    restrict: vi.fn((rule: { allow: string[] }) => {
      if (rule.allow.some(name => !inherited.includes(name) || options.own?.includes(name)))
        throw new Error('tools.restrict() names unknown global tool')
      return () => {}
    }),
    ...options.schemas ? { schemas: (scope?: object) => scope === preset
      ? inherited.map(name => ({ name, parameters: options.parameters?.[name]?.parameters ?? {} })) : [] } : {},
  } } as unknown as Agent['ctx']
  const agent = { ctx } as Agent
  const preset = {}
  bindScopeParent(agent, preset)
  return agent
}

describe('commandShaped', () => {
  it('accepts an object schema whose command is a string, however the type is written', () => {
    expect(commandShaped({ type: 'object', properties: { command: { type: 'string' } } })).toBe(true)
    expect(commandShaped({ properties: { command: { type: ['string', 'null'] } } })).toBe(true)
    expect(commandShaped({})).toBe(false)
    expect(commandShaped({ properties: { command: { type: 'number' } } })).toBe(false)
    expect(commandShaped({ properties: { command: { description: 'run it' } } })).toBe(false)
    expect(commandShaped(undefined)).toBe(false)
  })
})

describe('restrictableTools', () => {
  it('keeps the candidates the scope exposes, in order, and drops the rest', () => {
    const agent = fakeAgent(['read', 'bash', 'grep'])
    expect(restrictableTools(agent, ['skill', 'bash', 'pwsh', 'read', 'job_output'])).toEqual(['bash', 'read'])
  })
})

describe('shellTools', () => {
  it('finds the shell among the aliases a bare registry knows', () => {
    const agent = fakeAgent(['read', 'bash'])
    expect(shellTools(agent)).toEqual(['bash'])
  })
  it('finds a renamed shell by its command parameters when enumeration is offered', () => {
    const agent = fakeAgent(['read', 'terminal'], { parameters: { terminal: { parameters: { type: 'object',
      properties: { command: { type: 'string' } } } } }, schemas: true })
    expect(shellTools(agent)).toEqual(['terminal'])
  })
  it('does not call a non-command tool a shell for sharing an alias name', () => {
    const agent = fakeAgent(['read', 'shell'], { parameters: { shell: { parameters: { type: 'object',
      properties: { query: { type: 'string' } } } } }, schemas: true })
    expect(shellTools(agent)).toEqual([])
  })
  it('serves no shells for a scope without any', () => {
    expect(shellTools(fakeAgent(['read', 'grep']))).toEqual([])
  })
})

describe('isShellTool', () => {
  it('accepts a known alias on a bare registry and a shaped tool on a real one', () => {
    expect(isShellTool(fakeAgent(['bash']), 'bash')).toBe(true)
    expect(isShellTool(fakeAgent(['pwsh'], { parameters: { pwsh: { parameters: { type: 'object',
      properties: { command: { type: 'string' } } } } } }), 'pwsh')).toBe(true)
    expect(isShellTool(fakeAgent(['bash']), 'grep')).toBe(false)
    expect(isShellTool(fakeAgent(['read']), 'bash')).toBe(false)
    expect(isShellTool(fakeAgent(['terminal'], { parameters: { terminal: { parameters: { type: 'object',
      properties: { command: { type: 'string' } } } } } }), 'terminal')).toBe(true)
  })
})

describe('workerAllow and masterAllow', () => {
  it('keeps the role candidates the scope exposes and adds no detected name already listed', () => {
    const agent = fakeAgent(['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill',
      'write', 'edit', 'glob', 'web_fetch', 'todo_write', 'ask_user_question', 'plugin_manager'])
    expect(workerAllow(agent).allow).toEqual(['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'job_output',
      'job_list', 'job_kill', 'web_search', 'web_fetch', 'skill', 'todo_write'])
    expect(workerAllow(agent).detected).toEqual([])
    expect(masterAllow(agent).allow).toEqual(['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'])
  })
  it('appends a renamed shell that enumeration found', () => {
    const agent = fakeAgent(['read', 'terminal'], { parameters: { terminal: { parameters: { type: 'object',
      properties: { command: { type: 'string' } } } } }, schemas: true })
    expect(masterAllow(agent).allow).toEqual(['read', 'terminal'])
    expect(masterAllow(agent).detected).toEqual(['terminal'])
  })
})

describe('restrictAllow', () => {
  it('applies the restriction as given and returns its disposer', () => {
    const agent = fakeAgent(['read', 'bash'])
    const dispose = restrictAllow(agent, masterAllow(agent).allow, [])
    expect(dispose).toBeTypeOf('function')
    expect((agent.ctx.tools as unknown as ToolRegistry).restrict).toHaveBeenCalledWith({ allow: ['bash', 'read'] })
  })
  it('drops only the detected names when the host refuses the restriction, and retries', () => {
    // An own-layer tool is known to the scope but cannot be named by a restriction.
    const agent = fakeAgent(['read', 'terminal'], { own: ['terminal'], parameters: { terminal: { parameters: { type: 'object',
      properties: { command: { type: 'string' } } } } }, schemas: true })
    const { allow, detected } = masterAllow(agent)
    expect(() => (agent.ctx.tools as unknown as ToolRegistry).get('terminal', agent)).not.toThrow()
    const dispose = restrictAllow(agent, allow, detected)
    expect(dispose).toBeTypeOf('function')
    expect((agent.ctx.tools as unknown as ToolRegistry).restrict).toHaveBeenLastCalledWith({ allow: ['read'] })
  })
  it('surfaces a refusal that surviving names cannot clear', () => {
    const agent = fakeAgent(['read'])
    expect(() => restrictAllow(agent, ['bash', 'pwsh'], [])).toThrow(/unknown global tool/)
  })
})

describe('SHELL_ALIASES', () => {
  it('names the shells this host family has used', () => {
    expect(SHELL_ALIASES).toContain('bash')
    expect(SHELL_ALIASES).toContain('pwsh')
  })
})
