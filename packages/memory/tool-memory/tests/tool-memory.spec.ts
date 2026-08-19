import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as toolMemory from '../src/index.ts'

async function setup(
  ledgerPath: string,
  config: toolMemory.Config = {},
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemoryService, { path: ledgerPath })
  const plugin = await ctx.plugin(toolMemory, config)
  return { ctx, dispose: () => plugin.dispose() }
}

function sessionAgent(session: Session, id = 'tool-memory-agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function proposeStep(ctx: Context, agent: Agent, messages: UserMessage[] = []): Promise<PreStepDecision> {
  const signal = new AbortController().signal
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

async function execute(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('tool-memory-test'),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(`tool ${name} failed`)
  return result.value
}

describe('tool-memory composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolMemory).toBe(false)
    expect(toolMemory.name).toBe('tool-memory')
    expect(toolMemory.inject).toEqual(['tools', 'memory'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolMemory)).toBe(toolMemory)
  })

  it('records, lists, and resolves through the tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-'))
    const { ctx } = await setup(join(dir, 'ledger.jsonl'))
    const session = Session.create(SessionId('mem-tools'), [], { version: 0, id: SessionId('mem-tools'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)

    const recorded = await execute(ctx, agent, 'memory_record', {
      kind: 'problem',
      title: 'build flakes under pnpm 11',
      detail: 'retry resolved it twice',
    }) as { id: string }
    expect(recorded.id).toMatch(/^mem-/)

    const listed = await execute(ctx, agent, 'memory_list', {}) as { records: { id: string; title: string }[] }
    expect(listed.records).toHaveLength(1)
    expect(listed.records[0]).toMatchObject({ title: 'build flakes under pnpm 11' })

    const resolved = await execute(ctx, agent, 'memory_resolve', { id: recorded.id, note: 'pinned pnpm' }) as { resolved: boolean }
    expect(resolved.resolved).toBe(true)
    const after = await execute(ctx, agent, 'memory_list', {}) as { records: unknown[] }
    expect(after.records).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('injects the active ledger into the first step and republishes on change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-inject-'))
    const ledgerPath = join(dir, 'ledger.jsonl')
    const { ctx } = await setup(ledgerPath)
    const memoryCtx = ctx as unknown as { memory: import('@deepseek-ai/dsh-memory').MemoryService }
    await memoryCtx.memory.add({ kind: 'problem', title: 'standing issue one' })

    const session = Session.create(SessionId('mem-inject'), [], { version: 0, id: SessionId('mem-inject'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)

    const first = await proposeStep(ctx, agent)
    expect(first.kind).toBe('enter')
    const injection = first.kind === 'enter' ? first.messages.find(message => (message.source as { kind?: string }).kind === 'memory-ledger') : undefined
    expect(injection).toBeDefined()
    const text = (injection!.content[0] as { type: string; text: string }).text
    expect(text).toContain('<memory_ledger>')
    expect(text).toContain('standing issue one')

    // Persist the first publication, then resolve the record: the next step
    // must replace, not duplicate, the ledger message.
    if (first.kind === 'enter') {
      for (const message of first.messages) {
        session.append('user/message', message, { surfaceOp: 'append' })
      }
    }
    const state = await memoryCtx.memory.snapshot()
    const record = state.active[0]!
    await memoryCtx.memory.resolve({ id: record.id, note: 'resolved in test' })

    const second = await proposeStep(ctx, agent)
    expect(second.kind).toBe('enter')
    const ledgerMessages = second.kind === 'enter'
      ? second.messages.filter(message => (message.source as { kind?: string }).kind === 'memory-ledger')
      : []
    expect(ledgerMessages).toHaveLength(1)
    const replaced = (ledgerMessages[0]!.content[0] as { text: string }).text
    expect(replaced).toContain('replaces every earlier memory list')
    expect(replaced).not.toContain('standing issue one')
    await ctx.fiber.dispose()
  })

  it('injects nothing for a never-published empty ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-empty-'))
    const { ctx } = await setup(join(dir, 'ledger.jsonl'))
    const session = Session.create(SessionId('mem-empty'), [], { version: 0, id: SessionId('mem-empty'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    const decision = await proposeStep(ctx, agent)
    expect(decision.kind).toBe('enter')
    const injections = decision.kind === 'enter'
      ? decision.messages.filter(message => (message.source as { kind?: string }).kind === 'memory-ledger')
      : []
    expect(injections).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('captures a failed turn as one auto problem record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-capture-'))
    const ledgerPath = join(dir, 'ledger.jsonl')
    const { ctx } = await setup(ledgerPath)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('mem-capture') })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'provider 500', code: 'PROVIDER' } },
    })
    // The capture listener is fire-and-forget; settle the microtask queue.
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 50))
    const text = await readFile(ledgerPath, 'utf8')
    expect(text).toContain('"origin":"auto"')
    expect(text).toContain('Turn 1 failed')
    await ctx.fiber.dispose()
  })

  it('skips capture when autoCaptureFailures is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-nocapture-'))
    const ledgerPath = join(dir, 'ledger.jsonl')
    const { ctx } = await setup(ledgerPath, { autoCaptureFailures: false })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('mem-nocapture') })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'provider 500', code: 'PROVIDER' } },
    })
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(readFile(ledgerPath, 'utf8')).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('session event surface', () => {
  it('keeps the injection replayable from the session log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-durable-'))
    const { ctx } = await setup(join(dir, 'ledger.jsonl'))
    const memoryCtx = ctx as unknown as { memory: import('@deepseek-ai/dsh-memory').MemoryService }
    await memoryCtx.memory.add({ kind: 'lesson', title: 'prefer file locks' })
    const session = Session.create(SessionId('mem-durable'), [], { version: 0, id: SessionId('mem-durable'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    const decision = await proposeStep(ctx, agent)
    if (decision.kind === 'enter') {
      for (const message of decision.messages) {
        session.append('user/message', message, { surfaceOp: 'append' })
      }
    }
    const ledgerEvents = session.events.filter((event): event is SessionEvent & { type: 'user/message' } =>
      event.type === 'user/message' && (event.data.source as { kind?: string }).kind === 'memory-ledger')
    expect(ledgerEvents).toHaveLength(1)
    expect(ledgerEvents[0]!.data.source).toMatchObject({ kind: 'memory-ledger', form: 'catalog' })
    await ctx.fiber.dispose()
  })

  it('unwinds tool registrations on plugin disposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-dispose-'))
    const { ctx, dispose } = await setup(join(dir, 'ledger.jsonl'))
    const session = Session.create(SessionId('mem-dispose'), [], { version: 0, id: SessionId('mem-dispose'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    expect(ctx.tools.get('memory_record', agent)?.name).toBe('memory_record')
    await dispose()
    expect(ctx.tools.get('memory_record', agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
