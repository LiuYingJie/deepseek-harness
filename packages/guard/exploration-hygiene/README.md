# @deepseek-ai/dsh-exploration-hygiene

English | [中文](README.zh.md)

A loop-hygiene plugin, not a model-facing tool: it never appears in the tool list and never vetoes or rewrites a call. It adds two behaviors that share one concern — unproductive exploration — and nothing else.

1. A prompt section stating how a coding agent should work: take the simplest path, orient then act, prefer specialized or MCP tools, and ask rather than reverse-engineer a blocked environment.
2. Advisory reminders when one agent makes consecutive tool calls that are not task progress (not `write` / `edit` / `str_replace_editor` / `ask_user_question` / `run_code` / `mcp__*` by default). The model still decides whether to act, ask, or change approach.

Decision record: [the exploration-hygiene Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-exploration-hygiene.md).

## Config

```yaml
- id: exploration-hygiene
  name: '@deepseek-ai/dsh-exploration-hygiene'
  config:
    section: |                          # default: the shipped operating contract; empty disables the section
      Complete the user's task by the simplest path that works.
    thresholds: [8, 14, 22]             # default; consecutive non-progress counts that trigger a reminder
    progress: [write, edit, str_replace_editor, ask_user_question, run_code, mcp__*]
    exclude: [todo_write]               # default; transparent to the stall chain
```

`thresholds` fails loud at plugin load: a non-integer, a value below 2, or a duplicate throws. An empty list disables stall reminders and keeps the prompt section. `progress` equally rejects an empty list so every tracked call cannot silently count as inspection. `include`/`exclude`-style entries support `*` wildcards and are predicates over tool names at call time.

## Stall-chain semantics

A tracked call that matches `progress` resets the agent's consecutive counter. Any other tracked call increments it. Untracked (`exclude`) calls are transparent: they neither increment nor reset, so `read → todo_write → grep` still counts as two consecutive inspection calls. Denied calls count. Calls without an agent are ignored. A user prompt (`agent/pre-step`) resets the submitting agent's chain. Chains are keyed by the live `Agent` object.

Reminders ride `tools/post-execute` `additionalContexts` with source `{kind: 'plugin', plugin: 'exploration-hygiene'}`, never a `content` replacement. The first threshold delivers a short nudge; every later threshold names the last tool and the run length.

When the counter keeps growing past the highest configured threshold, the chain does not go silent: a stronger reminder fires every `thresholds[0]` calls (e.g. with defaults `[8, 14, 22]` it also fires at 30, 38, 46…). Each repetition escalates the suggested next action so the model does not keep receiving an identical nudge.

## Model Experience

### System prompt

#### What the model sees

Every assembly that keeps this plugin loaded includes the operating-contract section below after the deployment persona, unless `section` is empty. When at least one visible tool is named `mcp__<server>__*`, the section appends a live server list.

##### Operating-contract section

```markdown
Complete the user's task by the simplest path that works.

Orient with a few targeted searches, then act. Do not exhaustively read a project before changing it. Prefer copying and adapting existing files over reverse-engineering engine internals, undocumented encodings, or installation layouts.

When specialized tools are listed — including MCP tools named mcp__* — use them instead of reconstructing that domain with read, grep, glob, or shell.

If a missing editor, UUID scheme, or external program blocks progress, ask the user with ask_user_question rather than searching the machine. If the current approach is not converging, change approach or ask; do not gather more of the same kind of evidence.
```

##### MCP appendix

```markdown
Specialized MCP servers in this session: <sorted-server-names>. Prefer those mcp__<server>__* tools for their domains.
```

#### Token effect

Fixed per-request cost for the contract. The MCP appendix is data-dependent and omitted when no MCP tools are visible.

#### KV Cache effect

Prefix-stable while the section text, including the MCP appendix, renders identically. Registering or dropping an MCP server may invalidate reuse from this section.

### First-threshold context message

#### What the model sees

At the first configured consecutive-inspection threshold, that agent receives the reminder below.

##### First-threshold reminder

```markdown
You have made several inspection calls without writing, editing, or asking the user. Stop gathering the same kind of evidence. Take the simplest action with what you already know, ask the user the blocking question, or change approach.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below.

##### Later-threshold reminder

```markdown
Inspection stall detected:
- last_tool: <toolName>
- consecutive_inspection_calls: <count>
The recent calls are not making task progress. Do not continue exploring. Write or edit, ask the user, use a specialized tool if one fits, or conclude with the simplest viable approach.
```

#### Token effect

Each reminder is retained history. Agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Past-the-highest context message

#### What the model sees

When the counter keeps growing past the highest configured threshold, a stronger reminder fires every `thresholds[0]` calls so the chain does not go silent. Severity escalates with `floor((count - highest) / thresholds[0])`.

##### Past-the-highest reminder

```markdown
Inspection chain past the highest configured threshold:
- last_tool: <toolName>
- consecutive_inspection_calls: <count>
- reminders_ignored: <count - highest>
You are now in a loop. <escalating next-action sentence>
```

##### Action severities

```markdown
Pick the simplest viable action and write it now. Stop exploring.
Stop exploring. Either write a working draft, ask the user the blocking question, or conclude with the current best guess.
Hard stop. Do not make another inspection call. Ask the user or write a minimal working answer.
You have ignored earlier reminders. Conclude this turn with text only: state the blocker, ask one question, or hand back the simplest answer you have.
```

#### Token effect

Each chained reminder is retained history.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Progress is a name-pattern allowlist** — shell commands that mutate files still count as inspection unless `progress` includes `bash`/`pwsh`. Default `mcp__*` treats every MCP tool as progress.
- **Advisory only** — escalating to `block` at a high threshold is not implemented, though `PostToolDecision` already supports blocking.
- **Legitimate large-codebase orientation still draws nudges** past the thresholds — the pressure valves are `thresholds`/`progress`/`exclude` config.
