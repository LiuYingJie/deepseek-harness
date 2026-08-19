/**
 * Project-level durable improvement-proposal stream: one append-only JSONL
 * stream per project root, folded into the active proposal set. Each proposal
 * is a background-authored improvement plan — analysis, proposed change, and
 * the problem records it addresses — never an applied change. A human (or a
 * later human-authorized session) reads the stream and decides. Nothing
 * model-visible rides this seam directly; consumers publish their own
 * model-facing surfaces.
 * @module @deepseek-ai/dsh-refinery
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project-level improvement-proposal stream; one service instance per process. */
    refinery: RefineryService
  }
}

/** Lifecycle stage of one proposal. */
export type RefineryProposalStatus = 'proposed' | 'applied' | 'discarded'

/** One immutable proposal as folded from the stream. */
export interface RefineryProposal {
  /** Proposal identity, stable across processes. */
  readonly id: string
  /** One-line summary naming the improvement. */
  readonly title: string
  /** Complete proposal body: analysis, proposed change, and effort estimate. */
  readonly body: string
  /** Memory-ledger record ids this proposal addresses, when known. */
  readonly addresses: readonly string[]
  readonly createdAt: number
  /** Session that authored the proposal, when known. */
  readonly sessionId?: string
  /** Settlement annotation; presence and value mark the proposal inactive. */
  readonly settled?: { status: RefineryProposalStatus; at: number; note: string }
}

/** Folded stream state: active (unsettled) proposals. */
export interface RefineryState {
  readonly active: readonly RefineryProposal[]
  readonly total: number
}

/** Stream event shapes as persisted to the JSONL stream. */
export type RefineryEvent
  = | { readonly type: 'propose'; readonly proposal: RefineryProposal }
    | {
      readonly type: 'settle'
      readonly id: string
      readonly status: RefineryProposalStatus
      readonly at: number
      readonly note: string
    }

/** Input for {@link RefineryService.propose}. */
export interface RefineryProposeInput {
  readonly title: string
  readonly body: string
  readonly addresses?: readonly string[]
  readonly sessionId?: string
}

/** Input for {@link RefineryService.settle}. */
export interface RefinerySettleInput {
  readonly id: string
  readonly status: RefineryProposalStatus
  readonly note: string
}

/** Refinery service configuration. */
export interface Config {
  /** Explicit stream file path; overrides the project-root default. */
  readonly path?: string
  /** Directory whose nearest `.git` ancestor anchors the default stream location. */
  readonly cwd?: string
}

export const Config: Schema<Config> = z.object({
  path: z.string(),
  cwd: z.string(),
})

const STREAM_BASENAME = 'proposals.jsonl'

/** Stream error with a stable code. */
export class RefineryError extends Error {
  constructor(message: string, readonly code: 'CORRUPT_STREAM' | 'EMPTY_TITLE' | 'EMPTY_BODY' | 'EMPTY_NOTE') {
    super(message)
    this.name = 'RefineryError'
  }
}

/** Whether a filesystem error means absence. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function gitRootExists(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch (error) {
    if (!isENOENT(error)) throw error
    return false
  }
}

/**
 * Walk upward from `cwd` to the nearest ancestor containing `.git`; the start
 * directory itself anchors when no ancestor matches.
 * @param cwd - directory the work happens in.
 * @returns the resolved project root.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  const start = resolve(cwd)
  let current = start
  while (true) {
    if (await gitRootExists(current)) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

/** Resolve the default stream path for one working directory.
 * @param cwd - directory the work happens in.
 * @returns the absolute stream path anchored at the project root.
 */
export async function resolveDefaultStreamPath(cwd: string): Promise<string> {
  const root = await findProjectRoot(cwd)
  return join(root, '.dsh', 'refinery', STREAM_BASENAME)
}

function isProposal(value: unknown): value is RefineryProposal {
  if (typeof value !== 'object' || value === null) return false
  const proposal = value as Partial<RefineryProposal>
  return typeof proposal.id === 'string'
    && proposal.id.length > 0
    && typeof proposal.title === 'string'
    && proposal.title.length > 0
    && typeof proposal.body === 'string'
    && proposal.body.length > 0
    && Array.isArray(proposal.addresses)
    && proposal.addresses.every(address => typeof address === 'string')
    && typeof proposal.createdAt === 'number'
}

/**
 * Fold one parsed event into the mutable accumulator. The active set holds
 * unsettled proposals only: a `propose` inserts its proposal, and a `settle`
 * removes its target from the active set (the settlement rides history).
 */
function applyEvent(active: Map<string, RefineryProposal>, event: RefineryEvent): void {
  switch (event.type) {
    case 'propose':
      active.set(event.proposal.id, event.proposal)
      break
    case 'settle':
      active.delete(event.id)
      break
  }
}

/** Parse one JSONL line into an event; `undefined` for blank lines. */
function parseStreamLine(line: string, path: string, lineNo: number): RefineryEvent | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new RefineryError(`refinery: invalid JSON at ${path}:${lineNo}`, 'CORRUPT_STREAM')
  }
  const type = (parsed as { type?: unknown }).type
  if (type === 'propose') {
    const proposal = (parsed as { proposal?: unknown }).proposal
    if (!isProposal(proposal)) {
      throw new RefineryError(`refinery: invalid propose record at ${path}:${lineNo}`, 'CORRUPT_STREAM')
    }
    return { type: 'propose', proposal }
  }
  if (type === 'settle') {
    const { id, status, at, note } = parsed as { id?: unknown; status?: unknown; at?: unknown; note?: unknown }
    if (typeof id !== 'string' || id.length === 0 || typeof at !== 'number' || typeof note !== 'string') {
      throw new RefineryError(`refinery: invalid settle event at ${path}:${lineNo}`, 'CORRUPT_STREAM')
    }
    if (status !== 'applied' && status !== 'discarded') {
      throw new RefineryError(`refinery: invalid settle status at ${path}:${lineNo}`, 'CORRUPT_STREAM')
    }
    return { type: 'settle', id, status, at, note }
  }
  throw new RefineryError(`refinery: unknown event type at ${path}:${lineNo}`, 'CORRUPT_STREAM')
}

/** Parse the complete stream text. */
function parseStream(text: string, path: string): RefineryEvent[] {
  const events: RefineryEvent[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const event = parseStreamLine(line, path, index + 1)
    if (event !== undefined) events.push(event)
  }
  return events
}

function foldStream(events: readonly RefineryEvent[]): RefineryState {
  const active = new Map<string, RefineryProposal>()
  for (const event of events) applyEvent(active, event)
  return { active: [...active.values()], total: events.length }
}

/**
 * Refinery service (`ctx.refinery`): one durable project proposal stream.
 * Writes serialize through the cross-process file lock; the in-process fold is
 * refreshed under the lock before each append so concurrent writers never fold
 * a stale prefix.
 */
export class RefineryService extends Service {
  static Config = Config

  private readonly streamPath: string
  private state: RefineryState = { active: [], total: 0 }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'refinery')
    this.streamPath = resolve(config.path ?? join(process.cwd(), '.dsh', 'refinery', STREAM_BASENAME))
  }

  /** Resolved stream file path. */
  get path(): string {
    return this.streamPath
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.streamPath, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.state = { active: [], total: 0 }
      return
    }
    this.state = foldStream(parseStream(text, this.streamPath))
  }

  /**
   * Snapshot of the folded stream state. Every snapshot re-reads and re-folds
   * the stream: it is a cross-session, externally editable file, so a cached
   * fold would hide both external edits and corruption.
   * @returns active proposals in insertion order plus the total event count.
   */
  async snapshot(): Promise<RefineryState> {
    await this.load()
    return this.state
  }

  /**
   * Append one `propose` event.
   * @param input - proposal fields; `id` and `createdAt` are minted here.
   * @returns the persisted proposal.
   */
  async propose(input: RefineryProposeInput): Promise<RefineryProposal> {
    const title = input.title.trim()
    if (title.length === 0) throw new RefineryError('refinery: title must be a non-empty string', 'EMPTY_TITLE')
    const body = input.body.trim()
    if (body.length === 0) throw new RefineryError('refinery: body must be a non-empty string', 'EMPTY_BODY')
    const proposal: RefineryProposal = {
      id: `prop-${randomUUID().slice(0, 8)}`,
      title,
      body,
      addresses: [...input.addresses ?? []],
      createdAt: Date.now(),
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    await this.appendLocked({ type: 'propose', proposal })
    return proposal
  }

  /**
   * Append one `settle` event.
   * @param input - proposal id, terminal status, and settlement note.
   * @returns the settled proposal with its annotation, or `undefined` when the
   *   id is unknown or already settled.
   */
  async settle(input: RefinerySettleInput): Promise<RefineryProposal | undefined> {
    const note = input.note.trim()
    if (note.length === 0) throw new RefineryError('refinery: note must be a non-empty string', 'EMPTY_NOTE')
    const event: RefineryEvent = {
      type: 'settle',
      id: input.id,
      status: input.status,
      at: Date.now(),
      note,
    }
    const result = await this.appendLocked(event)
    return result.proposal
  }

  /**
   * Refresh the fold from disk, append the event, and update the in-memory
   * fold — all under the cross-process writer lock. A `settle` targeting an
   * unknown or already settled id appends nothing and returns `undefined`.
   */
  private async appendLocked(
    event: RefineryEvent,
  ): Promise<{ proposal: RefineryProposal | undefined }> {
    let result: { proposal: RefineryProposal | undefined } = { proposal: undefined }
    await mkdir(dirname(this.streamPath), { recursive: true })
    await withFileLock(this.streamPath, async () => {
      await this.load()
      if (event.type === 'settle') {
        const existing = this.state.active.find(proposal => proposal.id === event.id)
        if (existing === undefined) return
        result = {
          proposal: {
            ...existing,
            settled: { status: event.status, at: event.at, note: event.note },
          },
        }
      } else {
        result = { proposal: event.proposal }
      }
      await appendFile(this.streamPath, `${JSON.stringify(event)}\n`, 'utf8')
      const active = new Map(this.state.active.map(proposal => [proposal.id, proposal]))
      applyEvent(active, event)
      this.state = { active: [...active.values()], total: this.state.total + 1 }
    })
    return result
  }
}

export default RefineryService
