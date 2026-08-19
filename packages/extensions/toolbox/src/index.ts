/**
 * Project-level durable tool library: one append-only JSONL stream per project
 * root, folded into the active tool set. Each record carries a model-authored
 * program (an async function body executed through the code-runtime seam),
 * its model-facing tool schema, and version history. A later session — or a
 * background improvement agent — re-mounts the active versions as real tools
 * without re-authoring them. Nothing model-visible rides this seam directly;
 * consumers publish their own model-facing surfaces.
 * @module @deepseek-ai/dsh-toolbox
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
    /** Project-level tool library; one service instance per process. */
    toolbox: ToolboxService
  }
}

/** Who authored one tool version. */
export type ToolboxOrigin = 'agent' | 'human'

/** One JSON-Schema-style parameter descriptor in the DSL `defineTool` accepts. */
export interface ToolboxParameterSpec {
  readonly type: string
  readonly description?: string
  /** Enum values, when the parameter is a closed set. */
  readonly enum?: readonly string[]
  readonly required?: boolean
}

/** The model-facing schema of one tool version. */
export interface ToolboxToolSchema {
  /** Tool name, unique among active tools. */
  readonly name: string
  readonly description: string
  /** Parameter descriptors keyed by parameter name. */
  readonly parameters: Readonly<Record<string, ToolboxParameterSpec>>
}

/** One immutable tool version as folded from the stream. */
export interface ToolboxRecord {
  /** Version identity, stable across processes. */
  readonly id: string
  readonly schema: ToolboxToolSchema
  /**
   * Program source: the body of an async function receiving `(args, exec)`.
   * Executed through the code-runtime seam at call time.
   */
  readonly program: string
  readonly origin: ToolboxOrigin
  readonly createdAt: number
  /** Session that authored the version, when known. */
  readonly sessionId?: string
  /** Supersession annotation; presence marks the version inactive. */
  readonly superseded?: { at: number; by: string }
}

/** Folded library state: the active version per tool name. */
export interface ToolboxState {
  readonly tools: readonly { readonly name: string; readonly version: ToolboxRecord }[]
  readonly total: number
}

/** Ledger event shapes as persisted to the JSONL stream. */
export type ToolboxEvent
  = | { readonly type: 'publish'; readonly record: ToolboxRecord }
    | {
      readonly type: 'retire'
      readonly name: string
      readonly at: number
      /** Version that supersedes the active one, when this retire accompanies a publish. */
      readonly by?: string
    }

/** Input for {@link ToolboxService.publish}. */
export interface ToolboxPublishInput {
  readonly schema: ToolboxToolSchema
  readonly program: string
  readonly origin?: ToolboxOrigin
  readonly sessionId?: string
}

/** Toolbox service configuration. */
export interface Config {
  /** Explicit library file path; overrides the project-root default. */
  readonly path?: string
  /** Directory whose nearest `.git` ancestor anchors the default library location. */
  readonly cwd?: string
}

export const Config: Schema<Config> = z.object({
  path: z.string(),
  cwd: z.string(),
})

const LIBRARY_BASENAME = 'toolbox.jsonl'

/** Library error with a stable code. */
export class ToolboxError extends Error {
  constructor(message: string, readonly code: 'CORRUPT_LIBRARY' | 'DUPLICATE_TOOL' | 'EMPTY_PROGRAM') {
    super(message)
    this.name = 'ToolboxError'
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

/** Resolve the default library path for one working directory.
 * @param cwd - directory the work happens in.
 * @returns the absolute library path anchored at the project root.
 */
export async function resolveDefaultLibraryPath(cwd: string): Promise<string> {
  const root = await findProjectRoot(cwd)
  return join(root, '.dsh', 'toolbox', LIBRARY_BASENAME)
}
const NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/

function isSchema(value: unknown): value is ToolboxToolSchema {
  if (typeof value !== 'object' || value === null) return false
  const schema = value as Partial<ToolboxToolSchema>
  if (typeof schema.name !== 'string' || !NAME_PATTERN.test(schema.name)) return false
  if (typeof schema.description !== 'string' || schema.description.length === 0) return false
  // Validate the raw parameters map before trusting the narrowed field type:
  // this guards a durable JSON boundary, not an in-memory value.
  const parameters = (value as { parameters?: unknown }).parameters
  if (typeof parameters !== 'object' || parameters === null) return false
  for (const spec of Object.values(parameters as Record<string, unknown>)) {
    if (typeof spec !== 'object' || spec === null) return false
    const type = (spec as { type?: unknown }).type
    if (typeof type !== 'string' || type.length === 0) return false
  }
  return true
}

function isRecord(value: unknown): value is ToolboxRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ToolboxRecord>
  return typeof record.id === 'string'
    && record.id.length > 0
    && isSchema(record.schema)
    && typeof record.program === 'string'
    && record.program.length > 0
    && (record.origin === 'agent' || record.origin === 'human')
    && typeof record.createdAt === 'number'
}

/**
 * Fold one parsed event into the mutable accumulator. The active set holds one
 * version per tool name: a `publish` replaces the name's active entry (the
 * replaced version's supersession rides history, not the active set), and a
 * `retire` removes the name.
 */
function applyEvent(
  active: Map<string, ToolboxRecord>,
  event: ToolboxEvent,
): void {
  switch (event.type) {
    case 'publish':
      active.set(event.record.schema.name, event.record)
      break
    case 'retire':
      active.delete(event.name)
      break
  }
}

/** Parse one JSONL line into an event; `undefined` for blank lines. */
function parseLibraryLine(line: string, path: string, lineNo: number): ToolboxEvent | undefined {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new ToolboxError(`toolbox: invalid JSON at ${path}:${lineNo}`, 'CORRUPT_LIBRARY')
  }
  const type = (parsed as { type?: unknown }).type
  if (type === 'publish') {
    const record = (parsed as { record?: unknown }).record
    if (!isRecord(record)) {
      throw new ToolboxError(`toolbox: invalid publish record at ${path}:${lineNo}`, 'CORRUPT_LIBRARY')
    }
    return { type: 'publish', record }
  }
  if (type === 'retire') {
    const { name, at, by } = parsed as { name?: unknown; at?: unknown; by?: unknown }
    if (typeof name !== 'string' || name.length === 0 || typeof at !== 'number') {
      throw new ToolboxError(`toolbox: invalid retire event at ${path}:${lineNo}`, 'CORRUPT_LIBRARY')
    }
    return {
      type: 'retire',
      name,
      at,
      ...(typeof by === 'string' ? { by } : {}),
    }
  }
  throw new ToolboxError(`toolbox: unknown event type at ${path}:${lineNo}`, 'CORRUPT_LIBRARY')
}

/** Parse the complete library text. */
function parseLibrary(text: string, path: string): ToolboxEvent[] {
  const events: ToolboxEvent[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const event = parseLibraryLine(line, path, index + 1)
    if (event !== undefined) events.push(event)
  }
  return events
}

function foldLibrary(events: readonly ToolboxEvent[]): ToolboxState {
  const active = new Map<string, ToolboxRecord>()
  for (const event of events) applyEvent(active, event)
  return {
    tools: [...active.entries()].map(([name, version]) => ({ name, version })),
    total: events.length,
  }
}

/**
 * Toolbox service (`ctx.toolbox`): one durable project tool library. Writes
 * serialize through the cross-process file lock; the in-process fold is
 * refreshed under the lock before each append so concurrent writers never fold
 * a stale prefix.
 */
export class ToolboxService extends Service {
  static Config = Config

  private readonly libraryPath: string
  private state: ToolboxState = { tools: [], total: 0 }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'toolbox')
    this.libraryPath = resolve(config.path ?? join(process.cwd(), '.dsh', 'toolbox', LIBRARY_BASENAME))
  }

  /** Resolved library file path. */
  get path(): string {
    return this.libraryPath
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.libraryPath, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      this.state = { tools: [], total: 0 }
      return
    }
    this.state = foldLibrary(parseLibrary(text, this.libraryPath))
  }

  /**
   * Snapshot of the folded library state. Every snapshot re-reads and re-folds
   * the stream: the library is a cross-session, externally editable file, so a
   * cached fold would hide both external edits and corruption.
   * @returns the active version per tool name plus the total event count.
   */
  async snapshot(): Promise<ToolboxState> {
    await this.load()
    return this.state
  }

  /**
   * Append one `publish` event, retiring any active version of the same name.
   * @param input - schema, program, and authorship; `id` and `createdAt` are minted here.
   * @returns the persisted version record.
   */
  async publish(input: ToolboxPublishInput): Promise<ToolboxRecord> {
    const name = input.schema.name
    if (!NAME_PATTERN.test(name)) {
      throw new ToolboxError(
        `toolbox: tool name must match ${NAME_PATTERN.source} (got ${JSON.stringify(name)})`,
        'DUPLICATE_TOOL',
      )
    }
    const program = input.program.trim()
    if (program.length === 0) throw new ToolboxError('toolbox: program must be a non-empty string', 'EMPTY_PROGRAM')
    const record: ToolboxRecord = {
      id: `tool-${randomUUID().slice(0, 8)}`,
      schema: input.schema,
      program,
      origin: input.origin ?? 'agent',
      createdAt: Date.now(),
      ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    }
    await this.appendLocked({ type: 'publish', record })
    return record
  }

  /**
   * Append one `retire` event removing the active version of one tool name.
   * @param name - the tool name whose active version is removed.
   * @returns whether an active version was removed.
   */
  async retire(name: string): Promise<boolean> {
    const result = await this.appendLocked({ type: 'retire', name, at: Date.now() })
    return result.retired
  }

  /**
   * Refresh the fold from disk, append the event, and update the in-memory
   * fold — all under the cross-process writer lock. A `retire` naming no active
   * tool appends nothing and reports `false`.
   */
  private async appendLocked(
    event: ToolboxEvent,
  ): Promise<{ retired: boolean }> {
    let retired = false
    await mkdir(dirname(this.libraryPath), { recursive: true })
    await withFileLock(this.libraryPath, async () => {
      await this.load()
      if (event.type === 'retire') {
        if (!this.state.tools.some(tool => tool.name === event.name)) return
        retired = true
      }
      await appendFile(this.libraryPath, `${JSON.stringify(event)}\n`, 'utf8')
      const active = new Map(this.state.tools.map(tool => [tool.name, tool.version]))
      applyEvent(active, event)
      this.state = {
        tools: [...active.entries()].map(([name, version]) => ({ name, version })),
        total: this.state.total + 1,
      }
    })
    return { retired }
  }
}

export default ToolboxService
