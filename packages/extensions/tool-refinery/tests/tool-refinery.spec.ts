import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import MemoryService from '@deepseek-ai/dsh-memory'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import RefineryService from '@deepseek-ai/dsh-refinery'
import * as toolRefinery from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  cleanups.length = 0
})

interface ProviderFixture {
  /** Structured value the mock provider's runs resolve with. */
  structured: unknown
  /** Stop reason the mock provider's runs resolve with. */
  stopReason: SubagentResult['stopReason']
  /** Requests captured from the plugin through `subagents.start`. */
  requests: { prompt: string; persona?: string | undefined; allow?: string[] | undefined }[]
}

function mockProvider(fixture: ProviderFixture): SubagentProvider {
  return {
    name: 'refinery-mock',
    capabilities: { outputSchema: true, depthLimit: false, toolFilter: true, persona: true },
    inheritsParentContext: false,
    async start(request) {
      fixture.requests.push({
        prompt: request.prompt.map(block => block.type === 'text' ? block.text : '').join(''),
        persona: request.persona,
        allow: request.toolFilter?.allow ? [...request.toolFilter.allow] : undefined,
      })
      const run: SubagentRun = {
        id: SessionId('refinery-mock-child'),
        localAgent: undefined,
        result: Promise.resolve({
          output: [],
          structured: fixture.structured,
          stopReason: fixture.stopReason,
        }),
        dispose: () => Promise.resolve(),
      }
      return run
    },
  }
}

async function setup(
  ledgerPath: string,
  streamPath: string,
  fixture: ProviderFixture,
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemoryService, { path: ledgerPath })
  await ctx.plugin(RefineryService, { path: streamPath })
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(mockProvider(fixture))
  const plugin = await ctx.plugin(toolRefinery, { provider: 'refinery-mock' })
  return { ctx, dispose: () => plugin.dispose() }
}

function sessionAgent(session: Session, id = 'tool-refinery-agent'): Agent {
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

async function execute(ctx: Context, agent: Agent | undefined, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('tool-refinery-test'),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-refinery-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('tool-refinery composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolRefinery).toBe(false)
    expect(toolRefinery.name).toBe('tool-refinery')
    expect(toolRefinery.inject).toEqual(['tools', 'refinery', 'subagents', 'memory'])
  })

  it('refinery_run seeds the author from ledger problems and persists the proposal', async () => {
    const dir = await tempDir()
    const fixture: ProviderFixture = {
      structured: {
        title: 'stabilize the windows build',
        body: 'The retry workaround masks a path-length bug; propose normalizing output paths.',
        addresses: ['mem-deadbeef'],
      },
      stopReason: 'completed',
      requests: [],
    }
    const { ctx } = await setup(join(dir, 'ledger.jsonl'), join(dir, 'proposals.jsonl'), fixture)
    await ctx.memory.add({
      kind: 'problem',
      title: 'flaky build on windows',
      detail: 'retry resolved it twice',
      origin: 'auto',
    })
    const session = Session.create(SessionId('tr-run'), [], { version: 0, id: SessionId('tr-run'), createdAt: 0, cwd: dir })
    const proposed = await execute(ctx, sessionAgent(session), 'refinery_run', {}) as {
      id: string
      title: string
      addresses: string[]
    }
    expect(proposed.title).toBe('stabilize the windows build')
    expect(proposed.addresses).toEqual(['mem-deadbeef'])
    // The author prompt carries the ledger problem and the read-only allow list.
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.prompt).toContain('flaky build on windows')
    expect(fixture.requests[0]?.allow).toBeDefined()
    // The proposal is durable in the stream file.
    const stream = await readFile(join(dir, 'proposals.jsonl'), 'utf8')
    expect(stream).toContain('"type":"propose"')
    expect(stream).toContain('stabilize the windows build')
  })

  it('refinery_run forwards a focus hint into the author prompt', async () => {
    const dir = await tempDir()
    const fixture: ProviderFixture = {
      structured: { title: 't', body: 'b', addresses: [] },
      stopReason: 'completed',
      requests: [],
    }
    const { ctx } = await setup(join(dir, 'ledger.jsonl'), join(dir, 'proposals.jsonl'), fixture)
    const session = Session.create(SessionId('tr-focus'), [], { version: 0, id: SessionId('tr-focus'), createdAt: 0, cwd: dir })
    await execute(ctx, sessionAgent(session), 'refinery_run', { focus: 'the installer script' })
    expect(fixture.requests[0]?.prompt).toContain('Focus specifically on: the installer script')
  })

  it('refinery_run fails loud when the author ends without a structured result', async () => {
    const dir = await tempDir()
    const fixture: ProviderFixture = { structured: undefined, stopReason: 'error', requests: [] }
    const { ctx } = await setup(join(dir, 'ledger.jsonl'), join(dir, 'proposals.jsonl'), fixture)
    const session = Session.create(SessionId('tr-err'), [], { version: 0, id: SessionId('tr-err'), createdAt: 0, cwd: dir })
    await expect(execute(ctx, sessionAgent(session), 'refinery_run', {})).rejects.toThrow('stopReason error')
  })

  it('refinery_list and refinery_settle read and settle the stream', async () => {
    const dir = await tempDir()
    const fixture: ProviderFixture = {
      structured: { title: 'reduce retry noise', body: 'cap consecutive retries at two.', addresses: [] },
      stopReason: 'completed',
      requests: [],
    }
    const { ctx } = await setup(join(dir, 'ledger.jsonl'), join(dir, 'proposals.jsonl'), fixture)
    const session = Session.create(SessionId('tr-settle'), [], { version: 0, id: SessionId('tr-settle'), createdAt: 0, cwd: dir })
    const proposed = await execute(ctx, sessionAgent(session), 'refinery_run', {}) as { id: string }
    const listed = await execute(ctx, undefined, 'refinery_list', {}) as { proposals: { id: string }[] }
    expect(listed.proposals.map(proposal => proposal.id)).toEqual([proposed.id])
    const settled = await execute(ctx, undefined, 'refinery_settle', {
      id: proposed.id,
      status: 'applied',
      note: 'landed as a retry cap',
    }) as { settled: boolean; restartRecommended: boolean }
    expect(settled.settled).toBe(true)
    expect(settled.restartRecommended).toBe(true)
    const after = await execute(ctx, undefined, 'refinery_list', {}) as { proposals: unknown[] }
    expect(after.proposals).toEqual([])
  })

  it('marks data-only applied settlements as not needing a restart', async () => {
    const dir = await tempDir()
    const fixture: ProviderFixture = {
      structured: { title: 'fix stale docs', body: 'regenerate the catalog.', addresses: [] },
      stopReason: 'completed',
      requests: [],
    }
    const { ctx } = await setup(join(dir, 'ledger.jsonl'), join(dir, 'proposals.jsonl'), fixture)
    const session = Session.create(SessionId('tr-data'), [], { version: 0, id: SessionId('tr-data'), createdAt: 0, cwd: dir })
    const proposed = await execute(ctx, sessionAgent(session), 'refinery_run', {}) as { id: string }
    const settled = await execute(ctx, undefined, 'refinery_settle', {
      id: proposed.id,
      status: 'applied',
      note: 'docs regenerated, no code changed',
      restartRecommended: false,
    }) as { settled: boolean; restartRecommended: boolean }
    expect(settled.settled).toBe(true)
    expect(settled.restartRecommended).toBe(false)
    const discarded = await execute(ctx, undefined, 'refinery_settle', {
      id: 'prop-never-existed',
      status: 'discarded',
      note: 'unknown id',
    }) as { settled: boolean; restartRecommended: boolean }
    expect(discarded.settled).toBe(false)
    expect(discarded.restartRecommended).toBe(false)
  })

  it('unregisters its tools when the plugin disposes', async () => {
    const dir = await tempDir()
    const fixture: ProviderFixture = { structured: { title: 't', body: 'b', addresses: [] }, stopReason: 'completed', requests: [] }
    const { ctx, dispose } = await setup(join(dir, 'ledger.jsonl'), join(dir, 'proposals.jsonl'), fixture)
    const session = Session.create(SessionId('tr-dispose'), [], { version: 0, id: SessionId('tr-dispose'), createdAt: 0, cwd: dir })
    expect(ctx.tools.get('refinery_run', sessionAgent(session))?.name).toBe('refinery_run')
    await dispose()
    expect(ctx.tools.get('refinery_run', sessionAgent(session))).toBeUndefined()
  })
})
