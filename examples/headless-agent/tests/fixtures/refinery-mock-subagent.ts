import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'

/** Mock one-shot provider that immediately settles one structured proposal. */
const provider: SubagentProvider = {
  name: 'refinery-smoke',
  capabilities: { outputSchema: true, depthLimit: false, toolFilter: true, persona: true },
  inheritsParentContext: false,
  async start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    return {
      id: SessionId('refinery-smoke-child'),
      localAgent: undefined,
      result: Promise.resolve({
        output: [],
        structured: {
          title: 'stabilize the mock smoke',
          body: 'The mock flow is stable; this proposal exists to prove persistence.',
          addresses: [],
        },
        stopReason: 'completed',
      }),
      dispose: () => Promise.resolve(),
    }
  },
}

export const name = 'refinery-mock-subagent'
export const inject = ['subagents']

/** Register the mock `refinery-smoke` subagent provider. */
export function apply(ctx: Context): void {
  ctx.subagents.registerProvider(provider)
}
