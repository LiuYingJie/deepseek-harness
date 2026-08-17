import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ExplorationHygiene from '@deepseek-ai/dsh-exploration-hygiene'
import {
  DEFAULT_SECTION,
  SECTION_NAME,
  mcpServerNames,
  type Config,
} from '@deepseek-ai/dsh-exploration-hygiene'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal

async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ExplorationHygiene, config)
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'r', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'grep', description: 'g', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'w', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'todo_write', description: 't', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'mcp__bridge__get_node', description: 'm', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

function reminders(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
    .filter(e => e.data.source.kind === 'plugin' && e.data.source.plugin === 'exploration-hygiene')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

const guardSource = (count: number) => ({
  kind: 'plugin',
  plugin: 'exploration-hygiene',
  form: 'notice',
  summary: `inspection × ${count}`,
})

describe('operating-contract section', () => {
  it('registers the default contract after persona and lists live MCP servers', async () => {
    const ctx = await harness()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === SECTION_NAME)
    expect(section?.text).toContain("Complete the user's task by the simplest path that works.")
    expect(section?.text).toContain('Specialized MCP servers in this session: bridge.')
    expect(renderPrompt(assembly)).toContain(DEFAULT_SECTION)
  })

  it('omits the MCP appendix when no mcp__ tools are visible', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ExplorationHygiene)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(entry => entry.name === SECTION_NAME)?.text).toBe(DEFAULT_SECTION)
  })

  it('drops the section when section is empty and still arms stall reminders', async () => {
    const ctx = await harness({ section: '', thresholds: [2] })
    expect((await ctx.systemPrompt.assemble()).sections.some(entry => entry.name === SECTION_NAME)).toBe(false)

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'grep', { q: 2 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(1)
  })

  it('removes the section when the plugin fiber disposes', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const fiber = await ctx.plugin(ExplorationHygiene)
    expect((await ctx.systemPrompt.assemble()).sections.some(entry => entry.name === SECTION_NAME)).toBe(true)
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections.some(entry => entry.name === SECTION_NAME)).toBe(false)
  })
})

describe('mcpServerNames', () => {
  it('extracts unique sorted server namespaces and ignores malformed names', () => {
    expect(mcpServerNames([
      { name: 'read', description: '', parameters: {} },
      { name: 'mcp__web__search', description: '', parameters: {} },
      { name: 'mcp__bridge__get_node', description: '', parameters: {} },
      { name: 'mcp__bridge__create_prefab', description: '', parameters: {} },
      { name: 'mcp__', description: '', parameters: {} },
      { name: 'mcp__nounderscore', description: '', parameters: {} },
    ])).toEqual(['bridge', 'web'])
  })
})

describe('inspection-stall reminders', () => {
  it('reminds gently at the first threshold and in detail at the second, across different inspection tools', async () => {
    const ctx = await harness({ thresholds: [3, 5] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'grep', { q: 2 }),
      toolCallResponse('c3', 'read', { q: 3 }),
      toolCallResponse('c4', 'grep', { q: 4 }),
      toolCallResponse('c5', 'read', { q: 5 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(2)
    expect(found[0]!.text).toContain('several inspection calls without writing')
    expect(found[0]!.source).toEqual(guardSource(3))
    expect(found[1]!.text).toContain('consecutive_inspection_calls: 5')
    expect(found[1]!.text).toContain('- last_tool: read')
    expect(found[1]!.source).toEqual(guardSource(5))
  })

  it('treats MCP tools as progress', async () => {
    const ctx = await harness({ thresholds: [3] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'grep', { q: 2 }),
      toolCallResponse('c3', 'mcp__bridge__get_node', { q: 3 }),
      toolCallResponse('c4', 'read', { q: 4 }),
      toolCallResponse('c5', 'grep', { q: 5 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
  })

  it('resets the stall when a progress tool runs', async () => {
    const ctx = await harness({ thresholds: [3] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'grep', { q: 2 }),
      toolCallResponse('c3', 'write', { q: 3 }),
      toolCallResponse('c4', 'read', { q: 4 }),
      toolCallResponse('c5', 'grep', { q: 5 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
  })

  it('treats excluded calls as transparent: they neither count nor reset', async () => {
    const ctx = await harness({ thresholds: [3] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'todo_write', { q: 2 }),
      toolCallResponse('c3', 'grep', { q: 3 }),
      toolCallResponse('c4', 'todo_write', { q: 4 }),
      toolCallResponse('c5', 'read', { q: 5 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(1)
  })

  it('a new user prompt resets the stall', async () => {
    const ctx = await harness({ thresholds: [3] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'grep', { q: 2 }),
      textResponse('turn one done'),
      toolCallResponse('c3', 'read', { q: 3 }),
      textResponse('turn two done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
  })

  it('keys stalls per agent', async () => {
    const ctx = await harness({ thresholds: [3] })
    ctx.llm.registerAdapter(['mock-a'], new MockAdapter([
      toolCallResponse('a1', 'read', { q: 1 }),
      toolCallResponse('a2', 'grep', { q: 2 }),
      textResponse('done'),
    ]))
    ctx.llm.registerAdapter(['mock-b'], new MockAdapter([
      toolCallResponse('b1', 'read', { q: 1 }),
      toolCallResponse('b2', 'grep', { q: 2 }),
      toolCallResponse('b3', 'read', { q: 3 }),
      textResponse('done'),
    ]))
    const agentA = ctx.agentLoop.create(SessionId('a'), { provider: 'mock-a', model: 'model-a' })
    const agentB = ctx.agentLoop.create(SessionId('b'), { provider: 'mock-b', model: 'model-b' })
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await Promise.all([waitForIdle(ctx, agentA), waitForIdle(ctx, agentB)])
    expect(reminders(agentA)).toHaveLength(0)
    expect(reminders(agentB)).toHaveLength(1)
  })

  it('ignores direct executes with no agent', async () => {
    const ctx = await harness({ thresholds: [2] })
    const direct = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('d1'), name: 'read', arguments: { q: 1 } })
    expect(direct.isError).toBe(false)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
  })

  it('folds the reminder onto a downstream block and keeps its feedback', async () => {
    const ctx = await harness({ thresholds: [2] })
    ctx.on('tools/post-execute', async () => ({
      kind: 'block' as const,
      feedback: [{ type: 'text' as const, text: 'nope' }],
      additionalContexts: [createUserMessage({
        content: [{ type: 'text' as const, text: 'downstream-ctx' }], source: { kind: 'plugin' as const, plugin: 'test' },
      })],
    }))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      toolCallResponse('c2', 'grep', { q: 2 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const injected = [...agent.session.events]
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
      .map(e => ({
        text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
        source: e.data.source,
      }))
    expect(injected).toHaveLength(3)
    expect(injected[0]!.text).toBe('downstream-ctx')
    expect(injected[0]!.source).toEqual({ kind: 'plugin', plugin: 'test' })
    expect(injected[1]!.text).toContain('several inspection calls without writing')
    expect(injected[1]!.source).toEqual(guardSource(2))
    expect(injected[2]).toEqual({ text: 'downstream-ctx', source: { kind: 'plugin', plugin: 'test' } })
    const results = [...agent.session.events].filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results.every(r => r.data.message.content[0].isError)).toBe(true)
    expect(results[1]!.data.message.content[0].content).toEqual([{ type: 'text', text: 'nope' }])
  })

  it('stops reminding after the plugin fiber disposes', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'r', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const fiber = await ctx.plugin(ExplorationHygiene, { thresholds: [2] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'read', { q: 1 }),
      textResponse('first'),
      toolCallResponse('c2', 'read', { q: 2 }),
      toolCallResponse('c3', 'read', { q: 3 }),
      textResponse('second'),
    ]))
    const first = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first)
    await fiber.dispose()
    const second = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, second)
    expect(reminders(first)).toHaveLength(0)
    expect(reminders(second)).toHaveLength(0)
  })
})

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects a threshold below 2', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(ExplorationHygiene, { thresholds: [1, 3] })).rejects.toThrow(/integer >= 2/)
  })

  it('rejects duplicate thresholds', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(ExplorationHygiene, { thresholds: [3, 3] })).rejects.toThrow(/duplicates/)
  })

  it('rejects an empty progress list', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(ExplorationHygiene, { progress: [] })).rejects.toThrow(/progress/)
  })

  it('disables stall reminders when thresholds is empty', async () => {
    const ctx = await harness({ thresholds: [] })
    const adapter = new MockAdapter([
      ...Array.from({ length: 8 }, (_, i) => toolCallResponse(`c${i}`, 'read', { q: i })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
    expect((await ctx.systemPrompt.assemble()).sections.some(entry => entry.name === SECTION_NAME)).toBe(true)
  })
})

describe('dsh-exploration-hygiene real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in ExplorationHygiene).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(ExplorationHygiene) as Record<string, unknown>
    expect(unwrapped).toBe(ExplorationHygiene)
    expect(unwrapped.name).toBe('exploration-hygiene')
    expect(unwrapped.inject).toEqual(['systemPrompt', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
