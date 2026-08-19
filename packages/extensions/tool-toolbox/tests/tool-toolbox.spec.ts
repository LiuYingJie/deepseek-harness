import { mkdtemp } from 'node:fs/promises'
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
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import ToolboxService from '@deepseek-ai/dsh-toolbox'
import * as toolToolbox from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  cleanups.length = 0
})

async function setup(
  libraryPath: string,
  config: toolToolbox.Config = {},
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(WorkerThreadCodeRuntime)
  await ctx.plugin(ToolboxService, { path: libraryPath })
  const plugin = await ctx.plugin(toolToolbox, config)
  return { ctx, dispose: () => plugin.dispose() }
}

function sessionAgent(session: Session, id = 'tool-toolbox-agent'): Agent {
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
    callId: CallId('tool-toolbox-test'),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-toolbox-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

describe('tool-toolbox composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolToolbox).toBe(false)
    expect(toolToolbox.name).toBe('tool-toolbox')
    expect(toolToolbox.inject).toEqual(['tools', 'toolbox'])
  })

  it('publish mounts the tool, executes its program with args, and persists it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'toolbox.jsonl')
    const { ctx } = await setup(path)
    const session = Session.create(SessionId('tb-publish'), [], { version: 0, id: SessionId('tb-publish'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    const published = await execute(ctx, agent, 'toolbox_publish', {
      name: 'shout_text',
      description: 'Uppercase the given text.',
      parameters: { text: { type: 'string', required: true } },
      program: 'return String(args.text).toUpperCase();',
    }) as { id: string; name: string; mounted: boolean }
    expect(published.name).toBe('shout_text')
    expect(published.mounted).toBe(true)
    expect(ctx.tools.get('shout_text', agent)?.name).toBe('shout_text')
    const value = await execute(ctx, agent, 'shout_text', { text: 'hello toolbox' })
    expect(value).toBe('HELLO TOOLBOX')
  })

  it('remounts the new program after a second publish of the same name', async () => {
    const dir = await tempDir()
    const { ctx } = await setup(join(dir, 'toolbox.jsonl'))
    const agent = sessionAgent(Session.create(SessionId('tb-swap'), [], { version: 0, id: SessionId('tb-swap'), createdAt: 0, cwd: dir }))
    await execute(ctx, agent, 'toolbox_publish', {
      name: 'double_num',
      description: 'Double a number.',
      parameters: { n: { type: 'number', required: true } },
      program: 'return (args.n as number) * 2;',
    })
    expect(await execute(ctx, agent, 'double_num', { n: 3 })).toBe(6)
    await execute(ctx, agent, 'toolbox_publish', {
      name: 'double_num',
      description: 'Triple a number.',
      parameters: { n: { type: 'number', required: true } },
      program: 'return (args.n as number) * 3;',
    })
    expect(await execute(ctx, agent, 'double_num', { n: 3 })).toBe(9)
  })

  it('mounts persisted tools on load in a fresh process', async () => {
    const dir = await tempDir()
    const path = join(dir, 'toolbox.jsonl')
    {
      const { ctx } = await setup(path)
      const session = Session.create(SessionId('tb-seed'), [], { version: 0, id: SessionId('tb-seed'), createdAt: 0, cwd: dir })
      await execute(ctx, sessionAgent(session), 'toolbox_publish', {
        name: 'kept_tool',
        description: 'Survives restarts.',
        parameters: {},
        program: 'return "persisted";',
      })
      await ctx.fiber.dispose()
    }
    {
      const { ctx } = await setup(path)
      const session = Session.create(SessionId('tb-reload'), [], { version: 0, id: SessionId('tb-reload'), createdAt: 0, cwd: dir })
      const agent = sessionAgent(session)
      expect(ctx.tools.get('kept_tool', agent)?.name).toBe('kept_tool')
      expect(await execute(ctx, agent, 'kept_tool', {})).toBe('persisted')
      const listed = await execute(ctx, agent, 'toolbox_list', {}) as { tools: { name: string }[] }
      expect(listed.tools.map(tool => tool.name)).toEqual(['kept_tool'])
      await ctx.fiber.dispose()
    }
  })

  it('retire unmounts the tool and reports false for unknown names', async () => {
    const dir = await tempDir()
    const { ctx } = await setup(join(dir, 'toolbox.jsonl'))
    const session = Session.create(SessionId('tb-retire'), [], { version: 0, id: SessionId('tb-retire'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    await execute(ctx, agent, 'toolbox_publish', {
      name: 'gone_tool',
      description: 'Will be retired.',
      parameters: {},
      program: 'return 1;',
    })
    const retired = await execute(ctx, agent, 'toolbox_retire', { name: 'gone_tool' }) as { retired: boolean }
    expect(retired.retired).toBe(true)
    expect(ctx.tools.get('gone_tool', agent)).toBeUndefined()
    const unknown = await execute(ctx, agent, 'toolbox_retire', { name: 'never_was' }) as { retired: boolean }
    expect(unknown.retired).toBe(false)
  })

  it('rejects unsupported parameter types at publish', async () => {
    const dir = await tempDir()
    const { ctx } = await setup(join(dir, 'toolbox.jsonl'))
    const session = Session.create(SessionId('tb-bad'), [], { version: 0, id: SessionId('tb-bad'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    await expect(execute(ctx, agent, 'toolbox_publish', {
      name: 'bad_tool',
      description: 'Bad parameter type.',
      parameters: { x: { type: 'gadget' } },
      program: 'return 1;',
    })).rejects.toThrow('unsupported parameter type')
    expect(ctx.tools.get('bad_tool', agent)).toBeUndefined()
  })

  it('skips a persisted tool with an unsupported parameter type instead of blocking the rest', async () => {
    const dir = await tempDir()
    const path = join(dir, 'toolbox.jsonl')
    const seedCtx = new Context()
    cleanups.push(async () => { await seedCtx.fiber.dispose() })
    const service = new ToolboxService(seedCtx, { path })
    await service.publish({
      schema: { name: 'broken_tool', description: 'Bad type.', parameters: { x: { type: 'gadget' } } },
      program: 'return 1;',
    })
    await service.publish({
      schema: { name: 'healthy_tool', description: 'Good type.', parameters: {} },
      program: 'return "ok";',
    })
    await seedCtx.fiber.dispose()
    const { ctx } = await setup(path)
    const session = Session.create(SessionId('tb-skip'), [], { version: 0, id: SessionId('tb-skip'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    expect(ctx.tools.get('broken_tool', agent)).toBeUndefined()
    expect(await execute(ctx, agent, 'healthy_tool', {})).toBe('ok')
  })

  it('unwinds tool registrations on plugin disposal', async () => {
    const dir = await tempDir()
    const { ctx, dispose } = await setup(join(dir, 'toolbox.jsonl'))
    const session = Session.create(SessionId('tb-dispose'), [], { version: 0, id: SessionId('tb-dispose'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    await execute(ctx, agent, 'toolbox_publish', {
      name: 'unwind_me',
      description: 'Unmounts with the plugin.',
      parameters: {},
      program: 'return 1;',
    })
    expect(ctx.tools.get('unwind_me', agent)?.name).toBe('unwind_me')
    await dispose()
    expect(ctx.tools.get('unwind_me', agent)).toBeUndefined()
    expect(ctx.tools.get('toolbox_publish', agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('hot-syncs the mount when another process edits the library file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'toolbox.jsonl')
    const { ctx } = await setup(path, { watchStabilityMs: 50 })
    const session = Session.create(SessionId('tb-watch'), [], { version: 0, id: SessionId('tb-watch'), createdAt: 0, cwd: dir })
    const agent = sessionAgent(session)
    const { appendFile } = await import('node:fs/promises')
    // Another process appends a publish event directly to the library file.
    await appendFile(path, `${JSON.stringify({
      type: 'publish',
      record: {
        id: 'tool-watched1',
        schema: { name: 'watched_tool', description: 'Published by another process.', parameters: {} },
        program: 'return "external";',
        origin: 'human',
        createdAt: Date.now(),
      },
    })}\n`)
    const deadline = Date.now() + 5000
    while (ctx.tools.get('watched_tool', agent) === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(await execute(ctx, agent, 'watched_tool', {})).toBe('external')
    // Another process retires it: the watcher unmounts it here.
    await appendFile(path, `${JSON.stringify({ type: 'retire', name: 'watched_tool', at: Date.now() })}\n`)
    const goneDeadline = Date.now() + 5000
    while (ctx.tools.get('watched_tool', agent) !== undefined && Date.now() < goneDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(ctx.tools.get('watched_tool', agent)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
