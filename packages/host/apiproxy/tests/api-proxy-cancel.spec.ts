/**
 * session.cancel scopes: the default turn stop preserves inbox work, while
 * scope `all` issues descendant drain, owned-job kills, and a broad cancel.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobSnapshot } from '@deepseek-ai/dsh-jobs'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('cancel-rpc'), payload }
}

async function harness(options: {
  origin?: 'subagent'
  drain?: () => Promise<void>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const session = ctx.sessions.create(sid('session-root'), {
    meta: { cwd: '/proj', ...options.origin === undefined ? {} : { origin: options.origin } },
  })
  const cancel = vi.fn()
  const agent = { id: session.id, session, status: 'running', ctx, cancel } as unknown as Agent
  ctx.agents.register(agent)
  const drainContinuableDescendants = vi.fn(options.drain ?? (() => Promise.resolve()))
  ctx.provide('subagents', { drainContinuableDescendants })
  const kill = vi.fn(() => 'requested' as const)
  const list = vi.fn((): readonly JobSnapshot[] => [])
  ctx.provide('jobs', { list, kill })
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { api, agent, cancel, drainContinuableDescendants, list, kill, ctx }
}

describe('session.cancel scopes', () => {
  it('omitted scope and turn abort with keepInbox and do not drain', async () => {
    const omitted = await harness()
    expect((await omitted.api.sessions.cancel(request({ sessionId: omitted.agent.id }))).result)
      .toEqual({ ok: true, value: { accepted: true } })
    expect(omitted.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(omitted.drainContinuableDescendants).not.toHaveBeenCalled()
    expect(omitted.kill).not.toHaveBeenCalled()

    const turn = await harness()
    expect((await turn.api.sessions.cancel(request({ sessionId: turn.agent.id, scope: 'turn' }))).result.ok)
      .toBe(true)
    expect(turn.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(turn.drainContinuableDescendants).not.toHaveBeenCalled()
  })

  it('scope all drains descendants, kills owned live jobs, and cancels without keepInbox', async () => {
    const owned = JobId('bash-1')
    const foreign = JobId('bash-2')
    const settled = JobId('bash-3')
    const { api, agent, cancel, drainContinuableDescendants, list, kill } = await harness()
    list.mockReturnValue([
      { id: owned, kind: 'bash', label: 'owned', status: 'running', ownerSession: sid('session-root'), startedAt: 1, reported: false },
      { id: foreign, kind: 'bash', label: 'unowned', status: 'running', startedAt: 1, reported: false },
      { id: settled, kind: 'bash', label: 'done', status: 'completed', ownerSession: sid('session-root'), startedAt: 1, reported: false },
    ])
    expect((await api.sessions.cancel(request({ sessionId: agent.id, scope: 'all' }))).result)
      .toEqual({ ok: true, value: { accepted: true } })
    expect(drainContinuableDescendants).toHaveBeenCalledExactlyOnceWith([agent])
    expect(list).toHaveBeenCalledExactlyOnceWith(agent)
    expect(kill).toHaveBeenCalledExactlyOnceWith(owned, agent, 'session halt')
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' })
  })

  it('scope all still accepts when descendant drain later fails', async () => {
    const warn = vi.fn()
    const { api, agent, ctx, cancel } = await harness({
      drain: () => Promise.reject(new Error('activation teardown failed')),
    })
    ctx.logger.warn = warn
    expect((await api.sessions.cancel(request({ sessionId: agent.id, scope: 'all' }))).result.ok).toBe(true)
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'user' })
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(
      'session.cancel: continuable descendant drain failed: activation teardown failed',
    )
  })

  it('rejects a session-backed subagent for every scope', async () => {
    const { api, agent, cancel, drainContinuableDescendants } = await harness({ origin: 'subagent' })
    const stopped = await api.sessions.cancel(request({ sessionId: agent.id, scope: 'all' }))
    expect(stopped.result.ok).toBe(false)
    if (!stopped.result.ok) expect(stopped.result.error.code).toBe('agent-busy')
    expect(cancel).not.toHaveBeenCalled()
    expect(drainContinuableDescendants).not.toHaveBeenCalled()
  })
})
