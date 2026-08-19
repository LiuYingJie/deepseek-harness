/**
 * Model-facing refinery tools: `refinery_run` spawns one background proposal
 * author through the subagent seam, reads the memory ledger as its feedback
 * input, and persists the structured result as a durable improvement proposal
 * through `ctx.refinery`. `refinery_list` and `refinery_settle` read and settle
 * the active set. The author child is tool-scoped to read-only surface, so a
 * refinery run can analyze but never modify the project.
 * @module @deepseek-ai/dsh-tool-refinery
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MemoryRecord } from '@deepseek-ai/dsh-memory'
import type { RefineryProposalStatus } from '@deepseek-ai/dsh-refinery'
// Empty type import carries the subagent Context merge for ctx.subagents.
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'tool-refinery'
export const inject = ['tools', 'refinery', 'subagents', 'memory']

/** Model-facing refinery tool configuration. */
export interface Config {
  /** The `ctx.subagents` provider name proposal authors start on (default `spawn`). */
  readonly provider?: string
  /** Read-only tool names the proposal author keeps; everything else is removed. */
  readonly authorToolAllow?: string[]
  /** Maximum ledger problems rendered into the author prompt; minimum 1. */
  readonly maxLedgerEntries?: number
}

export const Config: z<Config> = z.object({
  provider: z.string(),
  authorToolAllow: z.array(z.string()),
  maxLedgerEntries: z.number(),
})

const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_AUTHOR_TOOL_ALLOW = ['fs_read', 'fs_search', 'session_search', 'memory_list'] as const
const DEFAULT_MAX_LEDGER_ENTRIES = 16

const PROPOSAL_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body', 'addresses'],
  properties: {
    title: { type: 'string', description: 'One-line summary naming the improvement.' },
    body: {
      type: 'string',
      description: 'Complete proposal: observed problem, root cause, proposed change, and effort estimate.',
    },
    addresses: {
      type: 'array',
      items: { type: 'string' },
      description: 'Memory-ledger record ids this proposal addresses.',
    },
  },
}

const AUTHOR_PERSONA = [
  'You are a background improvement analyst for this project.',
  'You receive unresolved problems from the project memory ledger and author ONE improvement proposal.',
  'You never modify the project: your job ends at a proposal that a human reviews before anything changes.',
  'Ground every claim in evidence you can read from the workspace; name files and symptoms concretely.',
  'Your output must satisfy the structured schema: a concise title, a complete body, and the ledger ids addressed.',
].join(' ')

/** Render one ledger problem for the author prompt. */
function renderProblem(record: MemoryRecord): string {
  const detail = record.detail !== undefined && record.detail.length > 0 ? `\n  ${record.detail}` : ''
  return `- [${record.id}] (${record.origin}) ${record.title}${detail}`
}

/**
 * Build the author prompt from the active ledger problems.
 * @param problems - active ledger records rendered into the prompt.
 * @param maxEntries - upper bound on rendered problems.
 * @returns the complete author prompt.
 */
export function buildAuthorPrompt(problems: readonly MemoryRecord[], maxEntries: number): string {
  const lines = problems.slice(0, maxEntries).map(renderProblem)
  const ledger = lines.length === 0 ? '(no unresolved problems recorded)' : lines.join('\n')
  return [
    'Author one improvement proposal for this project.',
    '',
    'Unresolved problems from the project memory ledger:',
    ledger,
    '',
    'Requirements:',
    '- Pick the highest-value improvement these problems justify; one proposal, one focus.',
    '- Investigate with your read-only tools until you can name the root cause, not just the symptom.',
    '- Propose the change concretely enough that a maintainer can act without re-deriving your analysis.',
    '- List every ledger record id your proposal addresses in `addresses`.',
  ].join('\n')
}

/** Narrow a structured subagent result into proposal fields, validating shape. */
function readProposal(
  structured: unknown,
): { title: string; body: string; addresses: string[] } {
  const value = structured as { title?: unknown; body?: unknown; addresses?: unknown }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    throw new Error('refinery: proposal author returned no title')
  }
  if (typeof value.body !== 'string' || value.body.length === 0) {
    throw new Error('refinery: proposal author returned no body')
  }
  const addresses = Array.isArray(value.addresses)
    ? value.addresses.filter((address): address is string => typeof address === 'string')
    : []
  return { title: value.title, body: value.body, addresses }
}

/**
 * Register the refinery tools and the background author runner.
 * @param ctx - registrant context carrying the tool, refinery, subagent, and memory services.
 * @param config - deployment's refinery tool policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? DEFAULT_PROVIDER
  const authorToolAllow = [...config.authorToolAllow ?? DEFAULT_AUTHOR_TOOL_ALLOW]
  const maxLedgerEntries = config.maxLedgerEntries ?? DEFAULT_MAX_LEDGER_ENTRIES

  const runTool = defineTool({
    name: 'refinery_run',
    description:
      'Run one background improvement-proposal author for this project. Reads the unresolved problems from the project memory ledger, spawns a read-only analyst subagent that investigates the workspace, and persists one structured improvement proposal to the durable refinery stream. Proposals are never applied automatically — a human reviews and settles them. Use when the user asks for self-improvement analysis, or after recording problems worth a fix proposal.',
    parameters: {
      focus: {
        type: 'string',
        description: 'Optional focus hint steering the author toward one area or problem.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          addresses: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Proposed ${value.id}: ${value.title}` }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('refinery_run requires a calling agent (exec.agent was undefined)')
      }
      const state = await ctx.memory.snapshot()
      const problems = state.active.filter(record => record.kind === 'problem')
      const promptText = args.focus !== undefined && args.focus.trim().length > 0
        ? `${buildAuthorPrompt(problems, maxLedgerEntries)}\n- Focus specifically on: ${args.focus.trim()}`
        : buildAuthorPrompt(problems, maxLedgerEntries)
      const run = await ctx.subagents.start(provider, {
        label: 'refinery proposal author',
        prompt: [{ type: 'text', text: promptText }] as ContentBlock[],
        parent,
        signal: exec.signal,
        outputSchema: PROPOSAL_SCHEMA,
        persona: AUTHOR_PERSONA,
        toolFilter: { allow: authorToolAllow },
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed' || result.structured === undefined) {
          throw new Error(`refinery: proposal author ended with stopReason ${result.stopReason}`)
        }
        const proposal = readProposal(result.structured)
        const persisted = await ctx.refinery.propose({
          title: proposal.title,
          body: proposal.body,
          addresses: proposal.addresses,
          sessionId: parent.session.id,
        })
        return { id: persisted.id, title: persisted.title, addresses: [...persisted.addresses] }
      } finally {
        await run.dispose()
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Run refinery author',
      kind: 'other',
      rawInput: args.focus ?? '',
    }),
  })
  ctx.tools.register(runTool)

  const listTool = defineTool({
    name: 'refinery_list',
    description: 'List the active improvement proposals in the project refinery stream.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposals: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                addresses: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.proposals.length === 0
          ? 'Refinery stream is empty.'
          : value.proposals.map(proposal => `- [${proposal.id}] ${proposal.title}`).join('\n'),
      }],
    },
    async execute() {
      const state = await ctx.refinery.snapshot()
      return {
        proposals: state.active.map(proposal => ({
          id: proposal.id,
          title: proposal.title,
          addresses: [...proposal.addresses],
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List refinery proposals', kind: 'read', rawInput: '' }),
  })
  ctx.tools.register(listTool)

  const settleTool = defineTool({
    name: 'refinery_settle',
    description:
      'Settle one active improvement proposal: `applied` after the improvement landed (name what changed), or `discarded` when it was rejected or became moot. An `applied` settlement that changed source code or configuration cannot hot-load into the running process; the result says whether a restart is recommended and you must relay that to the user.',
    parameters: {
      id: { type: 'string', required: true, description: 'The proposal id, e.g. `prop-ab12cd34`.' },
      status: {
        type: 'string',
        required: true,
        enum: ['applied', 'discarded'],
        description: 'applied | discarded.',
      },
      note: { type: 'string', required: true, description: 'What applied the proposal, or why it was discarded.' },
      restartRecommended: {
        type: 'boolean',
        description: 'Whether the running process should restart to load the applied change; defaults true for source/config changes, false for pure data or documentation edits.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          settled: { type: 'boolean', required: true },
          restartRecommended: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.settled
          ? `No active proposal ${value.id}.`
          : value.restartRecommended
            ? `Settled ${value.id}. Restart the process to load the applied change.`
            : `Settled ${value.id}.`,
      }],
    },
    async execute(args) {
      const status: RefineryProposalStatus = args.status === 'applied' ? 'applied' : 'discarded'
      const proposal = await ctx.refinery.settle({ id: args.id, status, note: args.note })
      const settled = proposal !== undefined
      const restartRecommended = settled && status === 'applied' && (args.restartRecommended ?? true)
      return { id: args.id, settled, restartRecommended }
    },
    presentCall: args => ({ card: 'generic', title: `Settle ${args.id}`, kind: 'other', rawInput: args.note }),
  })
  ctx.tools.register(settleTool)
}
