/**
 * Project-level durable issue ledger: one append-only JSONL stream per project
 * root, folded into the active record set. The ledger is a cross-session
 * improvement memory — problems that were not solved, decisions taken, and
 * lessons that a later session (or a background improvement agent) consumes as
 * input. Nothing model-visible rides this seam directly; consumers publish
 * their own model-facing surfaces.
 * @module @deepseek-ai/dsh-memory
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
    /** Project-level issue ledger; one service instance per process. */
    memory: MemoryService
  }
}

/** Ledger record kind. */
export type MemoryRecordKind = 'problem' | 'decision' | 'lesson'

/** Who authored one ledger record. */
export type MemoryRecordOrigin = 'agent' | 'auto' | 'human'

/** One ledger record as folded from the stream. */
export interface MemoryRecord {
  readonly id: string
  readonly kind: MemoryRecordKind
  readonly title: string
  readonly detail?: string
  readonly origin: MemoryRecordOrigin
  readonly createdAt: number
  /** Session that authored the record, when known. */
  readonly sessionId?: string
  /** Resolve annotation; presence marks the record resolved. */
  readonly resolved?: { at: number; note: string; sessionId?: string }
}

/** Ledger event shapes as persisted to the JSONL stream. */
export type MemoryLedgerEvent
  = | { readonly type: 'open'; readonly record: MemoryRecord }
    | {
      readonly type: 'resolve'
      readonly id: string
      readonly at: number
      readonly note: string
      readonly sessionId?: string
    }

/** Folded ledger state. */
export interface MemoryLedgerState {
  readonly active: readonly MemoryRecord[]
  readonly total: number
}

/** Input for {@link MemoryService.add}. */
export interface MemoryAddInput {
  readonly kind: MemoryRecordKind
  readonly title: string
  readonly detail?: string
  readonly origin?: MemoryRecordOrigin
  readonly sessionId?: string
}

/** Input for {@link MemoryService.resolve}. */
export interface MemoryResolveInput {
  readonly id: string
  readonly note: string
  readonly sessionId?: string
}

/** Memory service configuration. */
export interface Config {
  /** Explicit ledger file path; overrides the project-root default. */
  readonly path?: string
  /** Directory whose nearest `.git` ancestor anchors the default ledger location. */
  readonly cwd?: string
}

export const Config: Schema<Config> = z.object({
  path: z.string(),
  cwd: z.string(),
})

const LEDGER_BASENAME = 'ledger.jsonl'

/** Ledger error with a stable code. */
export class MemoryLedgerError extends Error {
  constructor(message: string, readonly code: 'CORRUPT_LEDGER') {
    super(message)
    this.name = 'MemoryLedgerError'
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

/** Resolve the default ledger path for one working directory.
 * @param cwd - directory the work happens in.
 * @returns the absolute ledger path anchored at the project root.
 */
export async function resolveDefaultLedgerPath(cwd: string): Promise<string> {
  const root = await findProjectRoot(cwd)
  return join(root, '.dsh', 'memory', LEDGER_BASENAME)
}

function isRecord(value: unknown): value is MemoryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<MemoryRecord>
  return typeof record.id === 'string'
    && record.id.length > 0
    && (record.kind === 'problem' || record.kind === 'decision' || record.kind === 'lesson')
    && (record.origin === 'agent' || record.origin === 'auto' || record.origin === 'human')
    && typeof record.title === 'string'
    && record.title.length > 0
    && typeof record.createdAt === 'number'
}

/**
 * Fold one parsed event into the mutable accumulator. `active` holds unresolved
 * records only: a `resolve` removes its target; the resolved annotation rides
 * the returned record, not the active set.
 */
function applyEvent(records: Map<string, MemoryRecord>, event: MemoryLedgerEvent): void {
  switch (event.type) {
    case 'open':
      records.set(event.record.id, event.record)
      break
    case 'resolve':
      records.delete(event.id)
      break
  }
}

/** Parse one JSONL line into an event; `undefined` for blank lines. */
function parseLedgerLine(line: string, path: string, lineNo: number): MemoryLedgerEvent | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new MemoryLedgerError(`memory: invalid JSON at ${path}:${lineNo}`, 'CORRUPT_LEDGER')
  }
  const type = (parsed as { type?: unknown }).type
  if (type === 'open') {
    const record = (parsed as { record?: unknown }).record
    if (!isRecord(record)) {
      throw new MemoryLedgerError(`memory: invalid open record at ${path}:${lineNo}`, 'CORRUPT_LEDGER')
    }
    return { type: 'open', record }
  }
  if (type === 'resolve') {
    const { id, at, note, sessionId } = parsed as { id?: unknown; at?: unknown; note?: unknown; sessionId?: unknown }
    if (typeof id !== 'string' || id.length === 0 || typeof at !== 'number' || typeof note !== 'string') {
      throw new MemoryLedgerError(`memory: invalid resolve event at ${path}:${lineNo}`, 'CORRUPT_LEDGER')
    }
    return {
      type: 'resolve',
      id,
      at,
      note,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    }
  }
  throw new MemoryLedgerError(`memory: unknown event type at ${path}:${lineNo}`, 'CORRUPT_LEDGER')
}

/** Parse the complete ledger text. */
function parseLedger(text: string, path: string): MemoryLedgerEvent[] {
  const events: MemoryLedgerEvent[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const event = parseLedgerLine(line, path, index + 1)
    if (event !== undefined) events.push(event)
  }
  return events
}

function foldLedger(events: readonly MemoryLedgerEvent[]): MemoryLedgerState {
  const records = new Map<string, MemoryRecord>()
  for (const event of events) applyEvent(records, event)
  return { active: [...records.values()], total: events.length }
}

/**
 * Memory service (`ctx.memory`): one durable project ledger. Writes serialize
 * through the cross-process file lock; the in-process fold is refreshed under
 * the lock before each append so concurrent writers never fold a stale prefix.
 */
export class MemoryService extends Service {
  static Config = Config

  private readonly ledgerPath: string
  private state: MemoryLedgerState = { active: [], total: 0 }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memory')
    this.ledgerPath = resolve(config.path ?? join(process.cwd(), '.dsh', 'memory', LEDGER_BASENAME))
  }

  /** Resolved ledger file path. */
  get path(): string {
    return this.ledgerPath
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.ledgerPath, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.state = { active: [], total: 0 }
      return
    }
    this.state = foldLedger(parseLedger(text, this.ledgerPath))
  }

  /**
   * Snapshot of the folded ledger state. Every snapshot re-reads and re-folds
   * the stream: the ledger is a cross-session, externally editable file, so a
   * cached fold would hide both external edits and corruption.
   * @returns active records in insertion order plus the total event count.
   */
  async snapshot(): Promise<MemoryLedgerState> {
    await this.load()
    return this.state
  }

  /**
   * Append one `open` event.
   * @param input - record fields; `id` and `createdAt` are minted here.
   * @returns the persisted record.
   */
  async add(input: MemoryAddInput): Promise<MemoryRecord> {
    const title = input.title.trim()
    if (title.length === 0) throw new Error('memory: title must be a non-empty string')
    const detail = input.detail?.trim()
    const record: MemoryRecord = {
      id: `mem-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      title,
      ...detail !== undefined && detail.length > 0 ? { detail } : {},
      origin: input.origin ?? 'agent',
      createdAt: Date.now(),
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    await this.appendLocked({ type: 'open', record })
    return record
  }

  /**
   * Append one `resolve` event.
   * @param input - record id and resolution note.
   * @returns the resolved record with its annotation, or `undefined` when the
   *   id is unknown or already resolved.
   */
  async resolve(input: MemoryResolveInput): Promise<MemoryRecord | undefined> {
    const note = input.note.trim()
    if (note.length === 0) throw new Error('memory: note must be a non-empty string')
    const event: MemoryLedgerEvent = {
      type: 'resolve',
      id: input.id,
      at: Date.now(),
      note,
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    const result = await this.appendLocked(event)
    return result.record
  }

  /**
   * Refresh the fold from disk, append the event, and update the in-memory
   * fold — all under the cross-process writer lock so concurrent writers see
   * one serialized order. A `resolve` targeting an unknown or already resolved
   * id appends nothing and returns `undefined`.
   */
  private async appendLocked(
    event: MemoryLedgerEvent,
  ): Promise<{ record: MemoryRecord | undefined }> {
    let result: { record: MemoryRecord | undefined } = { record: undefined }
    // The lock file is a sibling of the ledger, so its parent must exist before
    // the lock is taken.
    await mkdir(dirname(this.ledgerPath), { recursive: true })
    await withFileLock(this.ledgerPath, async () => {
      await this.load()
      if (event.type === 'resolve') {
        const existing = this.state.active.find(record => record.id === event.id)
        if (existing === undefined) return
        result = {
          record: {
            ...existing,
            resolved: { at: event.at, note: event.note, ...event.sessionId !== undefined ? { sessionId: event.sessionId } : {} },
          },
        }
      } else {
        result = { record: event.record }
      }
      await appendFile(this.ledgerPath, `${JSON.stringify(event)}\n`, 'utf8')
      const records = new Map(this.state.active.map(record => [record.id, record]))
      applyEvent(records, event)
      this.state = { active: [...records.values()], total: this.state.total + 1 }
    })
    return result
  }
}

export default MemoryService
