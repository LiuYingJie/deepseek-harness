/**
 * Coding-agent operating contract and advisory inspection-stall reminders.
 * It never appears in the tool list, never vetoes or rewrites a call, and
 * adds two behaviors: a prompt section stating how to work, and post-execute
 * reminders when consecutive non-progress tool calls hit configured counts.
 * @module @deepseek-ai/dsh-exploration-hygiene
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { PostToolDecision, ToolExecution, ToolSchema } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'exploration-hygiene'

/** Prompt registry for the operating-contract section; tool registry for MCP listing and stall detection. */
export const inject = ['systemPrompt', 'tools']

/** Prompt section name this plugin registers. */
export const SECTION_NAME = 'harness:coding-guidance'

/** Order band after persona (0) and before per-tool guidance (100–199). */
export const SECTION_ORDER = 10

/**
 * Default operating contract. Deployments replace it with `section`; an empty
 * string disables the prompt contribution without disabling stall reminders.
 */
export const DEFAULT_SECTION = [
  "Complete the user's task by the simplest path that works.",
  '',
  'Orient with a few targeted searches, then act. Do not exhaustively read a project before changing it. Prefer copying and adapting existing files over reverse-engineering engine internals, undocumented encodings, or installation layouts.',
  '',
  'When specialized tools are listed — including MCP tools named mcp__* — use them instead of reconstructing that domain with read, grep, glob, or shell.',
  '',
  'If a missing editor, UUID scheme, or external program blocks progress, ask the user with ask_user_question rather than searching the machine. If the current approach is not converging, change approach or ask; do not gather more of the same kind of evidence.',
].join('\n')

/** Consecutive non-progress counts that trigger a reminder when `thresholds` is omitted. */
export const DEFAULT_THRESHOLDS = [8, 14, 22] as const

/** Tool-name patterns that count as task progress when `progress` is omitted. */
export const DEFAULT_PROGRESS = ['write', 'edit', 'str_replace_editor', 'ask_user_question', 'run_code', 'mcp__*'] as const

/** Tool-name patterns transparent to the stall chain when `exclude` is omitted. */
export const DEFAULT_EXCLUDE = ['todo_write'] as const

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply`. Empty `thresholds` disables stall reminders.
 * Empty `section` disables the prompt contribution. `progress` must name at
 * least one pattern so every tracked call cannot silently count as inspection.
 */
export interface Config {
  /** Operating-contract prompt text; empty disables the section (default {@link DEFAULT_SECTION}). */
  section?: string
  /** Consecutive non-progress counts that trigger a reminder (default {@link DEFAULT_THRESHOLDS}). */
  thresholds?: number[]
  /** Tool-name patterns that reset the stall chain as task progress (default {@link DEFAULT_PROGRESS}). */
  progress?: string[]
  /** Tool-name patterns transparent to the chain (default {@link DEFAULT_EXCLUDE}). */
  exclude?: string[]
}

export const Config: z<Config> = z.object({
  section: z.string().default(DEFAULT_SECTION),
  thresholds: z.array(z.number()).default([...DEFAULT_THRESHOLDS]),
  progress: z.array(z.string()).default([...DEFAULT_PROGRESS]),
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
})

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'exploration-hygiene' }

const GENTLE_REMINDER =
  'You have made several inspection calls without writing, editing, or asking the user. '
  + 'Stop gathering the same kind of evidence. Take the simplest action with what you already know, '
  + 'ask the user the blocking question, or change approach.'

function detailedReminder(toolName: string, count: number): string {
  return 'Inspection stall detected:\n'
    + `- last_tool: ${toolName}\n`
    + `- consecutive_inspection_calls: ${count}\n`
    + 'The recent calls are not making task progress. Do not continue exploring. '
    + 'Write or edit, ask the user, use a specialized tool if one fits, or conclude with the simplest viable approach.'
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

function matches(patterns: RegExp[], toolName: string): boolean {
  return patterns.some(pattern => pattern.test(toolName))
}

/**
 * Server namespaces currently visible as `mcp__<server>__*` tools.
 * @param schemas - the scope's visible tool schemas.
 * @returns sorted unique server names, omitting malformed public names.
 */
export function mcpServerNames(schemas: readonly ToolSchema[]): string[] {
  const servers = new Set<string>()
  for (const schema of schemas) {
    if (!schema.name.startsWith('mcp__')) continue
    const rest = schema.name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) continue
    servers.add(rest.slice(0, sep))
  }
  return [...servers].sort()
}

function renderSection(base: string, schemas: readonly ToolSchema[]): string {
  const servers = mcpServerNames(schemas)
  if (servers.length === 0) return base
  return `${base}\n\nSpecialized MCP servers in this session: ${servers.join(', ')}. Prefer those mcp__<server>__* tools for their domains.`
}

function validateThresholds(values: number[]): number[] {
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`exploration-hygiene: invalid threshold ${value} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('exploration-hygiene: `thresholds` must not contain duplicates')
  }
  return [...values].sort((a, b) => a - b)
}

function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/** One agent's consecutive non-progress run length. */
interface Stall {
  count: number
}

/**
 * Install the operating-contract section and stall-reminder listeners.
 * @param ctx - plugin context; registrations and listeners dispose with it.
 * @param config - validated {@link Config}; `thresholds` and `progress` are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const section = config.section as string
  const thresholds = validateThresholds(config.thresholds as number[])
  const progressPatterns = (config.progress as string[]).map(wildcardToRegExp)
  if (progressPatterns.length === 0) {
    throw new Error('exploration-hygiene: `progress` must not be empty')
  }
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const thresholdSet = new Set(thresholds)

  if (section.length > 0) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context: AssembleContext) => renderSection(section, ctx.tools.schemas(context.scope)),
    })
  }

  if (thresholds.length === 0) return

  const stalls = new WeakMap<Agent, Stall>()

  function tracked(toolName: string): boolean {
    return !matches(excludePatterns, toolName)
  }

  function observe(exec: ToolExecution): UserMessage | undefined {
    if (!exec.agent) return undefined
    if (!tracked(exec.name)) return undefined
    if (matches(progressPatterns, exec.name)) {
      stalls.delete(exec.agent)
      return undefined
    }
    const count = (stalls.get(exec.agent)?.count ?? 0) + 1
    stalls.set(exec.agent, { count })
    if (!thresholdSet.has(count)) return undefined
    const text = count === thresholds[0] ? GENTLE_REMINDER : detailedReminder(exec.name, count)
    /* jscpd:ignore-start */
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `inspection × ${count}` },
    })
  }

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const reminder = observe(exec)
    const downstream = await next()
    if (!reminder) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts),
    }
  })

  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) stalls.delete(agent)
    return next()
  })
  /* jscpd:ignore-end */
}
