/**
 * Model-facing memory ledger tools plus the session-start injection of the
 * active problem ledger. Records durable cross-session improvement memory from
 * two origins: explicit model calls to `memory_record`, and turn-failure
 * capture from `turn/end` error reasons.
 * @module @deepseek-ai/dsh-tool-memory
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MemoryRecord, MemoryRecordKind } from '@deepseek-ai/dsh-memory'

export const name = 'tool-memory'
export const inject = ['tools', 'memory']

/** Durable record list mirroring the rendered ledger lines, for non-model consumers. */
export interface MemoryLedgerSource {
  readonly kind: 'memory-ledger'
  readonly form: 'catalog'
  /** Marks a replacement ledger rather than this session's first publication. */
  readonly update?: true
  /** Exactly the records this message published, in fold order. */
  readonly entries: readonly {
    readonly id: string
    readonly kind: MemoryRecordKind
    readonly title: string
    readonly origin: string
  }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Active problem ledger injected by the host for this step. */
    'memory-ledger': MemoryLedgerSource
  }
}

const DEFAULT_MAX_INJECT_ENTRIES = 32
const DEFAULT_MAX_DETAIL_CHARS = 240

/** Model-facing memory tool configuration. */
export interface Config {
  /** Maximum active records rendered in the injected ledger; minimum 1. */
  readonly maxInjectEntries?: number
  /** Whether failed turns automatically append an `auto` origin problem record; defaults true. */
  readonly autoCaptureFailures?: boolean
  /** Maximum characters of each record detail rendered in the injected ledger; minimum 8. */
  readonly maxDetailChars?: number
}

export const Config: z<Config> = z.object({
  maxInjectEntries: z.number().default(DEFAULT_MAX_INJECT_ENTRIES),
  autoCaptureFailures: z.boolean().default(true),
  maxDetailChars: z.number().default(DEFAULT_MAX_DETAIL_CHARS),
})

const KINDS = ['problem', 'decision', 'lesson'] as const

/** Escape model-facing prose embedded inside ledger markup. */
function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Render one ledger record for the model-facing block. */
function renderRecord(record: MemoryRecord, maxDetailChars: number): string {
  const parts = [`- [${record.id}] (${record.kind}/${record.origin}) ${escapeText(record.title)}`]
  if (record.detail !== undefined && record.detail.length > 0) {
    const clipped = record.detail.length <= maxDetailChars
      ? record.detail
      : `${record.detail.slice(0, maxDetailChars - 3)}...`
    parts.push(`  ${escapeText(clipped)}`)
  }
  return parts.join('\n')
}

/** Render the injected ledger message for one active record set. */
function renderLedgerMessage(
  entries: MemoryLedgerSource['entries'],
  records: readonly MemoryRecord[],
  maxDetailChars: number,
  update: boolean,
): UserMessage {
  const byId = new Map(records.map(record => [record.id, record]))
  const lines: string[] = []
  for (const entry of entries) {
    const record = byId.get(entry.id)
    if (record === undefined) continue
    lines.push(renderRecord(record, maxDetailChars))
  }
  const heading = update
    ? 'The active memory ledger changed. This complete list replaces every earlier memory list in this session:'
    : 'This project keeps a durable memory ledger of unresolved problems, standing decisions, and lessons from previous sessions:'
  const guidance = lines.length === 0
    ? [
      'The ledger is currently empty. Record durable problems and lessons with the `memory_record` tool when they are confirmed.',
    ]
    : [
      'These entries were recorded by earlier sessions. Treat unresolved problems as standing context: avoid repeating them, prefer the recorded decisions, and resolve a record with `memory_resolve` once the work that proved it is done.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        heading,
        '',
        '<memory_ledger>',
        ...lines,
        '</memory_ledger>',
        '',
        ...guidance,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'memory-ledger', form: 'catalog', ...update ? { update: true } : {}, entries },
  })
}

/** Entries projected from the same records the message renders. */
function ledgerSourceEntries(
  records: readonly MemoryRecord[],
  maxEntries: number,
): MemoryLedgerSource['entries'] {
  return records.slice(0, maxEntries).map(record => ({
    id: record.id,
    kind: record.kind,
    title: record.title,
    origin: record.origin,
  }))
}

/** Ledger identity over the durable entry list. */
function digestEntries(entries: MemoryLedgerSource['entries']): string {
  const canonical = entries.map(entry => JSON.stringify([entry.id, entry.kind, entry.title, entry.origin])).join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Entries of one durable ledger message, or undefined when the record is unusable. */
function readLedgerEntries(source: unknown): MemoryLedgerSource['entries'] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: { id: string; kind: MemoryRecordKind; title: string; origin: string }[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { id, kind, title, origin } = entry as { id?: unknown; kind?: unknown; title?: unknown; origin?: unknown }
    if (typeof id !== 'string' || id === '' || typeof title !== 'string' || typeof origin !== 'string') return undefined
    if (kind !== 'problem' && kind !== 'decision' && kind !== 'lesson') return undefined
    readable.push({ id, kind, title, origin })
  }
  return readable
}

function ledgerMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: MemoryLedgerSource['entries'] } | undefined {
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'memory-ledger') continue
    const entries = readLedgerEntries(message.source)
    if (entries !== undefined) return { message, entries }
  }
  return undefined
}

function ledgerPublished(agent: Agent): { visibleDigest?: string; published: boolean } {
  const visible = new Set(agent.session.surface.nodes)
  const events = agent.session.events
  let published = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The loop bounds prove the read-only event view contains this index.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type !== 'user/message' || (event.data.source as { kind?: unknown }).kind !== 'memory-ledger') continue
    const entries = readLedgerEntries(event.data.source)
    if (entries === undefined) continue
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digestEntries(entries), published }
  }
  return { published }
}

/**
 * Register the memory ledger tools, the step injection, and the optional
 * turn-failure capture.
 * @param ctx - registrant context carrying the tool registry and memory service.
 * @param config - deployment's memory tool policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxInjectEntries = config.maxInjectEntries ?? DEFAULT_MAX_INJECT_ENTRIES
  const autoCaptureFailures = config.autoCaptureFailures ?? true
  const maxDetailChars = config.maxDetailChars ?? DEFAULT_MAX_DETAIL_CHARS

  const recordTool = defineTool({
    name: 'memory_record',
    description:
      'Record one durable entry in the project memory ledger: an unresolved problem, a standing decision, or a lesson. Use it the moment a problem is confirmed to persist, a decision is made, or a lesson worth keeping is identified — the entry survives this session and is injected into later sessions working on this project. Prefer `problem` for anything that should be fixed later.',
    parameters: {
      kind: { type: 'string', required: true, enum: [...KINDS], description: 'problem | decision | lesson.' },
      title: { type: 'string', required: true, description: 'One concise imperative line naming the problem, decision, or lesson.' },
      detail: { type: 'string', description: 'Optional context: symptoms, evidence, workaround, or reasoning. What would a later session need to act on it?' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Recorded ${value.kind} ${value.id}: ${value.title}` }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      const record = await ctx.memory.add({
        kind: args.kind,
        title: args.title,
        ...args.detail !== undefined ? { detail: args.detail } : {},
        origin: 'agent',
        ...sessionId !== undefined ? { sessionId } : {},
      })
      return { id: record.id, kind: record.kind, title: record.title }
    },
    presentCall: args => ({ card: 'generic', title: `Record ${args.kind}`, kind: 'other', rawInput: args.title }),
  })
  ctx.tools.register(recordTool)

  const listTool = defineTool({
    name: 'memory_list',
    description: 'List the active records in the project memory ledger.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                title: { type: 'string', required: true },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.records.length === 0
          ? 'Memory ledger is empty.'
          : value.records.map(record => `- [${record.id}] (${record.kind}/${record.origin}) ${record.title}`).join('\n'),
      }],
    },
    async execute() {
      const state = await ctx.memory.snapshot()
      return {
        records: state.active.map(record => ({
          id: record.id,
          kind: record.kind,
          origin: record.origin,
          title: record.title,
          ...record.detail !== undefined ? { detail: record.detail } : {},
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List memory ledger', kind: 'read', rawInput: '' }),
  })
  ctx.tools.register(listTool)

  const resolveTool = defineTool({
    name: 'memory_resolve',
    description: 'Mark one active ledger record resolved with a short note naming what fixed it.',
    parameters: {
      id: { type: 'string', required: true, description: 'The record id, e.g. `mem-ab12cd34`.' },
      note: { type: 'string', required: true, description: 'What resolved the record — the fix, decision, or evidence.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          resolved: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.resolved ? `Resolved ${value.id}.` : `No active record ${value.id}.`,
      }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      const record = await ctx.memory.resolve({
        id: args.id,
        note: args.note,
        ...sessionId !== undefined ? { sessionId } : {},
      })
      return { id: args.id, resolved: record !== undefined }
    },
    presentCall: args => ({ card: 'generic', title: `Resolve ${args.id}`, kind: 'other', rawInput: args.note }),
  })
  ctx.tools.register(resolveTool)

  // Step injection: publish the active ledger into the model-visible surface.
  // The digest compares the durable entry list, not the rendered prose, and the
  // tool-visibility check mirrors the skill catalog so a restricted tool view
  // also removes the ledger guidance.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const toolVisible = ctx.tools.get(recordTool.name, agent) === recordTool
    if (!toolVisible) return decision
    const state = await ctx.memory.snapshot()
    signal.throwIfAborted()
    const entries = ledgerSourceEntries(state.active, maxInjectEntries)
    const digest = digestEntries(entries)
    const existing = ledgerMessage(decision.messages)
    const history = ledgerPublished(agent)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && digestEntries(existing.entries) === digest) return decision
    if (!history.published && entries.length === 0) {
      return existing === undefined
        ? decision
        : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const message = renderLedgerMessage(entries, state.active, maxDetailChars, history.published)
    return {
      kind: 'enter',
      messages: existing === undefined
        ? [...decision.messages, message]
        : decision.messages.map(item => item.id === existing.message.id ? message : item),
    }
  })

  // Turn-failure capture: a failed turn appends one `auto` problem record.
  // Fire-and-forget; a capture failure logs without failing the session.
  if (autoCaptureFailures) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
      const error = event.data.reason.error
      const message = typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'turn failed with an unnamed error'
      void ctx.memory.add({
        kind: 'problem',
        title: `Turn ${event.data.turn} failed: ${message.slice(0, 160)}`,
        detail: `reason.kind=error code=${error.code}`,
        origin: 'auto',
        sessionId: session.id,
      }).catch((captureError: unknown) => {
        ctx.logger.warn('tool-memory: turn-failure capture failed')
        ctx.logger.warn(captureError)
      })
    })
  }
}
