/**
 * The local directory Source: a file dropped into a watched folder is a request, and the answer is written
 * beside it. The tests use a real temporary folder, so they run the same way on every platform.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localdirKind, localdirTrigger, pollLocaldir, sendLocaldir } from '../src/sources/localdir.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'

const directory = mkdtempSync(join(tmpdir(), 'localdir-'))
const config = { directory, suffix: '.md', actor: 'local', pollSeconds: 30, replySuffix: '.reply.md' }

/** A Source context that records the triggers it received and the state it keeps. */
function fakeContext(received: Trigger[]) {
  const state = new Map<string, unknown>()
  return {
    context: {
      report: () => {},
      receive: (trigger: Trigger) => { received.push(trigger); return 'stored' },
      atomic: (work: () => void) => work(),
      state: {
        get: (key: string) => state.get(key) as never,
        set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) },
        keys: () => [],
      },
    } as unknown as SourceContext,
    state,
  }
}

type Trigger = Parameters<SourceContext['receive']>[0]

afterEach(() => {
  for (const name of ['task.md', 'other.txt', 'task.reply.md']) rmSync(join(directory, name), { force: true })
})

describe('the local directory Source', () => {
  it('turns a file into a request that addresses the agent', () => {
    const trigger = localdirTrigger(join(directory, 'task.md'), 'do the thing', 'local', '2026-01-01T00:00:00.000Z', '12:1')
    expect(trigger.source).toBe('localdir')
    expect(trigger.actor.id).toBe('local')
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.text).toBe('do the thing')
    expect(trigger.threads).toEqual([{ source: 'localdir', id: join(directory, 'task.md') }])
  })

  it('reads a new file once and again only when it changes', async () => {
    const received: Trigger[] = []
    const { context, state } = fakeContext(received)
    writeFileSync(join(directory, 'task.md'), 'do the thing')
    expect(await pollLocaldir(context, config, new AbortController().signal)).toBe(1)
    expect(received).toHaveLength(1)
    // The same file, unchanged, produces no second request.
    expect(await pollLocaldir(context, config, new AbortController().signal)).toBe(0)
    expect(received).toHaveLength(1)
    writeFileSync(join(directory, 'task.md'), 'do the thing, and this')
    expect(await pollLocaldir(context, config, new AbortController().signal)).toBe(1)
    expect(received).toHaveLength(2)
    expect(state.size).toBeGreaterThan(0)
  })

  it('ignores files whose suffix does not match and its own answers', async () => {
    const received: Trigger[] = []
    const { context } = fakeContext(received)
    writeFileSync(join(directory, 'other.txt'), 'not a request')
    writeFileSync(join(directory, 'task.reply.md'), 'an answer')
    expect(await pollLocaldir(context, config, new AbortController().signal)).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('writes the answer beside the file and writes it once', async () => {
    const message: OutboundMessage = {
      id: 'message-1',
      text: 'the answer',
      channel: { source: 'localdir', thread: `localdir:${join(directory, 'task.md')}`, address: { path: join(directory, 'task.md') } },
    } as unknown as OutboundMessage
    expect(await sendLocaldir({ commands: {} as never }, message)).toBe('sent')
    const reply = readFileSync(join(directory, 'task.reply.md'), 'utf8')
    expect(reply).toContain('the answer')
    expect(reply).toContain('message-1')
    // A retry of the same message does not write a second answer.
    expect(await sendLocaldir({ commands: {} as never }, message)).toBe('sent')
    expect(readFileSync(join(directory, 'task.reply.md'), 'utf8')).toBe(reply)
  })

  it('lists the sender in its policy and explains how to ask it', () => {
    expect(localdirKind.policy?.explicit.zh).toContain('文件')
    expect(localdirKind.policy?.rows?.({})[0]?.id).toBe('local')
    expect(localdirKind.fields.map(field => field.key)).toContain('directory')
  })
})
