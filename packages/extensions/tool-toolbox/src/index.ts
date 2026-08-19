/**
 * Model-facing toolbox tools plus the persistent tool mount. Publishes and
 * retires tool versions in the project library through `toolbox_publish` /
 * `toolbox_retire` / `toolbox_list`, and mounts every active version as a real
 * tool whose `execute` runs the stored program through the code-runtime seam.
 * Mounted tools survive restarts because the library is durable; a publish
 * hot-swaps the mount to the new version, and a file watcher picks up library
 * edits from other sessions and external editors without a restart.
 * @module @deepseek-ai/dsh-tool-toolbox
 */

import type { Context } from '@deepseek-ai/cordis'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { CodeRuntime, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ParameterPropertySpec, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  ToolboxParameterSpec, ToolboxRecord, ToolboxToolSchema,
} from '@deepseek-ai/dsh-toolbox'

export const name = 'tool-toolbox'
export const inject = ['tools', 'toolbox']

/** Model-facing toolbox tool configuration. */
export interface Config {
  /** Whether the plugin mounts library tools on load; defaults true. */
  readonly mountOnLoad?: boolean
  /** Whether library-file edits from other processes hot-sync the mount; defaults true. */
  readonly watchLibrary?: boolean
  /** Milliseconds library edits must stay stable before the mount syncs; minimum 1. */
  readonly watchStabilityMs?: number
}

const KINDS_SCALAR = new Set(['string', 'number', 'integer', 'boolean'])
const KINDS_ALL = new Set([...KINDS_SCALAR, 'array', 'object', 'json'])
const DEFAULT_WATCH_STABILITY_MS = 500

/** Whether a stored parameter spec maps onto the schema DSL. */
function isSupportedSpec(spec: ToolboxParameterSpec): boolean {
  return KINDS_ALL.has(spec.type)
}

/** Report the parameter keys a stored schema cannot map onto the schema DSL. */
function unsupportedParameters(schema: ToolboxToolSchema): string[] {
  return Object.entries(schema.parameters)
    .filter(([, spec]) => !isSupportedSpec(spec))
    .map(([key]) => key)
}

/**
 * Narrow one stored spec — durable JSON, so only structurally supported — to a
 * DSL `ParameterPropertySpec`. `type` is closed by {@link isSupportedSpec};
 * the annotation fields pass through when present.
 */
function toPropertySpec(spec: ToolboxParameterSpec): ParameterPropertySpec {
  const out: Record<string, unknown> = { type: spec.type }
  if (spec.description !== undefined) out.description = spec.description
  if (spec.enum !== undefined) {
    if (spec.type === 'string') out.enum = spec.enum
    else if (spec.type === 'number' || spec.type === 'integer') out.enum = spec.enum.map(Number)
  }
  if (spec.required === true) out.required = true
  return out as unknown as ParameterPropertySpec
}

/** Build the `defineTool` parameter map from one stored schema. */
function parameterMap(schema: ToolboxToolSchema): ParameterSchemaSpec {
  const out: ParameterSchemaSpec = {}
  for (const [key, spec] of Object.entries(schema.parameters)) {
    out[key] = toPropertySpec(spec)
  }
  return out
}

/** Program text handed to the code runtime: the validated call arguments are
 * injected as a JSON `args` binding because the runtime's async-function shell
 * only parameterizes binding namespaces and `console`. */
function programWrapper(record: ToolboxRecord, args: unknown): string {
  return `const args = ${JSON.stringify(args ?? null)} as Record<string, unknown>;\n${record.program}`
}

/**
 * Build the mounted {@link ToolDefinition} for one library tool. The `execute`
 * closure resolves the name's current active version at call time, so a
 * version published after the mount took its definition runs the new program
 * without a remount.
 * @param ctx - registrant context carrying the code runtime.
 * @param runtime - the mounted code-runtime backend.
 * @param version - the library version whose schema the mount presents.
 * @returns the registry-ready definition.
 */
function mountedTool(ctx: Context, runtime: () => CodeRuntime, version: ToolboxRecord): ToolDefinition {
  const schema = version.schema
  return defineTool({
    name: schema.name,
    description: `${schema.description} (project toolbox tool, version ${version.id})`,
    parameters: parameterMap(schema),
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      const state = await ctx.toolbox.snapshot()
      const current = state.tools.find(tool => tool.name === schema.name)
      if (current === undefined) {
        throw new Error(`toolbox: tool ${JSON.stringify(schema.name)} was retired; the mount is stale`)
      }
      const result: CodeRunResult = await runtime().run({
        program: programWrapper(current.version, args),
        bindings: [],
        signal: exec.signal,
      })
      if (result.error) {
        const logs = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
        throw new Error(`toolbox: tool ${JSON.stringify(schema.name)} failed (${result.error.kind}): ${result.error.message}${logs}`)
      }
      return result.value ?? null
    },
    presentCall: args => ({ card: 'generic', title: schema.name, kind: 'other', rawInput: JSON.stringify(args) }),
  })
}

/**
 * Register the toolbox management tools and the persistent mount.
 * @param ctx - registrant context carrying the tool registry and toolbox service.
 * @param config - deployment's toolbox tool policy.
 * @returns after the initial library mount has settled.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const mountOnLoad = config.mountOnLoad ?? true
  const watchLibrary = config.watchLibrary ?? true
  const watchStabilityMs = config.watchStabilityMs ?? DEFAULT_WATCH_STABILITY_MS
  if (!Number.isInteger(watchStabilityMs) || watchStabilityMs < 1) {
    throw new TypeError('tool-toolbox: watchStabilityMs must be a positive integer')
  }

  const runtime = (): CodeRuntime => {
    // Read the optional runtime through the global service store, not the
    // property proxy; toolbox tools run lazily after the backend may have
    // mounted.
    const resolved = ctx.get('codeRuntime')
    if (resolved === undefined) {
      throw new Error('tool-toolbox: no code runtime mounted — load a code-runtime backend (e.g. @deepseek-ai/dsh-code-runtime-worker-thread)')
    }
    return resolved
  }

  const disposers = new Map<string, () => void>()

  // Syncs serialize through one promise chain: the publish/retire tools and
  // the file watcher can both trigger a sync, and concurrent registrations of
  // the same tool name would throw duplicate-name errors.
  let syncChain: Promise<void> = Promise.resolve()

  const enqueueSync = (): Promise<void> => {
    syncChain = syncChain.then(() => syncMount())
    return syncChain
  }

  /** Sync the mounted set to the folded library state. A tool whose stored
   * schema cannot map onto the registry DSL is skipped with a logged error so
   * one bad record never blocks the remaining mounts. */
  const syncMount = async (): Promise<void> => {
    const state = await ctx.toolbox.snapshot()
    const active = new Set(state.tools.map(tool => tool.name))
    for (const [name, dispose] of disposers) {
      if (!active.has(name)) {
        dispose()
        disposers.delete(name)
      }
    }
    for (const tool of state.tools) {
      if (disposers.has(tool.name)) continue
      const unsupported = unsupportedParameters(tool.version.schema)
      if (unsupported.length > 0) {
        ctx.logger.warn(`tool-toolbox: skipping ${JSON.stringify(tool.name)}: unsupported parameter type(s) for ${unsupported.map(key => JSON.stringify(key)).join(', ')}`)
        continue
      }
      disposers.set(tool.name, ctx.tools.register(mountedTool(ctx, runtime, tool.version)))
    }
  }

  /** Replace one name's mount after its version changed. */
  const remount = (name: string): void => {
    disposers.get(name)?.()
    disposers.delete(name)
  }

  const publishTool = defineTool({
    name: 'toolbox_publish',
    description:
      'Publish one tool version into the persistent project toolbox. The program is the body of an async '
      + 'function executed with `args` (the validated call arguments) at call time through the sandboxed '
      + 'code runtime; it must `return` a JSON value. Publishing a name that already has an active version '
      + 'replaces it (the old version stays in history). The tool becomes callable in this session and is '
      + 'mounted automatically in every later session on this project.',
    parameters: {
      name: { type: 'string', required: true, description: 'Tool name: 3-64 chars, lowercase letters/digits/underscores, starting with a letter.' },
      description: { type: 'string', required: true, description: 'One-line model-facing description of what the tool does and when to use it.' },
      parameters: {
        type: 'json',
        required: true,
        description: 'Parameter map: { paramName: { type: "string"|"number"|"integer"|"boolean", description?: string, enum?: string[], required?: true } }.',
      },
      program: { type: 'string', required: true, description: 'Async function body; `args` holds the validated arguments; return a JSON value.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec): Promise<JsonValue> {
      const raw = args.parameters
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('toolbox: parameters must be an object keyed by parameter name')
      }
      const parameters = Object.fromEntries(Object.entries(raw).map(([key, value]) => {
        if (typeof value !== 'object' || value === null) {
          throw new Error(`toolbox: parameter ${JSON.stringify(key)} must be an object with a type field`)
        }
        const type = (value as { type?: unknown }).type
        if (typeof type !== 'string') {
          throw new Error(`toolbox: parameter ${JSON.stringify(key)} is missing its type field`)
        }
        return [key, { ...(value as object), type }]
      })) as Record<string, ToolboxParameterSpec>
      const unsupported = Object.entries(parameters)
        .filter(([, spec]) => !isSupportedSpec(spec))
        .map(([key]) => key)
      if (unsupported.length > 0) {
        throw new Error(`toolbox: unsupported parameter type(s) for ${unsupported.map(key => JSON.stringify(key)).join(', ')}; supported: string, number, integer, boolean, array, object, json`)
      }
      const sessionId = exec.agent?.session.id
      const record = await ctx.toolbox.publish({
        schema: {
          name: args.name,
          description: args.description,
          parameters,
        },
        program: args.program,
        origin: 'agent',
        ...sessionId !== undefined ? { sessionId } : {},
      })
      remount(args.name)
      await enqueueSync()
      return { id: record.id, name: record.schema.name, mounted: true }
    },
    presentCall: args => ({ card: 'generic', title: `Publish ${args.name}`, kind: 'other', rawInput: args.description }),
  })
  ctx.tools.register(publishTool)

  const retireTool = defineTool({
    name: 'toolbox_retire',
    description: 'Retire the active version of one project toolbox tool; it stops being callable and is unmounted.',
    parameters: {
      name: { type: 'string', required: true, description: 'The tool name whose active version is removed.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const retired = await ctx.toolbox.retire(args.name)
      if (retired) remount(args.name)
      await enqueueSync()
      return { name: args.name, retired }
    },
    presentCall: args => ({ card: 'generic', title: `Retire ${args.name}`, kind: 'delete', rawInput: '' }),
  })
  ctx.tools.register(retireTool)

  const listTool = defineTool({
    name: 'toolbox_list',
    description: 'List the active tools in the project toolbox with their versions and schemas.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const state = await ctx.toolbox.snapshot()
      return {
        tools: state.tools.map(tool => ({
          name: tool.name,
          version: tool.version.id,
          description: tool.version.schema.description,
          origin: tool.version.origin,
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List toolbox', kind: 'read', rawInput: '' }),
  })
  ctx.tools.register(listTool)

  if (mountOnLoad) await syncMount()

  let watcher: FSWatcher | undefined
  if (watchLibrary) {
    watcher = chokidar.watch(ctx.toolbox.path, {
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: watchStabilityMs, pollInterval: watchStabilityMs },
    })
    watcher.on('all', () => {
      syncChain = syncChain
        .then(() => syncMount())
        .catch((error: unknown) => { ctx.logger.error(`tool-toolbox: library watcher sync failed: ${String(error)}`) })
    })
  }

  ctx.effect(() => () => {
    void watcher?.close()
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
  }, 'tool-toolbox: unmount library tools')
}
