# Agent Note: Exploration hygiene for coding agents

Status: implemented

English | [中文](2026-08-17-exploration-hygiene.zh.md)

## Problem

The shipped coding-agent persona is one sentence of identity (`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`). Per-tool prompt sections say how to invoke `read` or `glob`, not when to stop reading. The only loop-hygiene consumer, [`dsh-repeat-tool-reminder`](../../../../packages/guard/repeat-tool-reminder/README.md), counts consecutive *identical* calls; a model that reads file A, greps pattern B, then reverse-engineers an engine UUID never trips it.

That is the failure the product actually showed: a request to port an existing UI prefab spent a full turn reconstructing Cocos Creator internals and searching the host for an editor install, produced no plan and no edit, and had to be aborted. The class is unproductive exploration — exhaustive inspection, ignoring specialized tools, reverse-engineering blocked environment details — not one Cocos task.

The [same-session goal driver](2026-07-16-harness-level-loop.md) already records that automatic no-progress heuristics and stuck-pattern detection are deferred there. Those belong to goal rounds. This decision covers the ordinary coding turn, which is where the abort happened.

## Decision

One guard plugin, `@deepseek-ai/dsh-exploration-hygiene` at `packages/guard/exploration-hygiene/`, owns both layers of the same concern:

1. **Operating-contract prompt section** `harness:coding-guidance` at order 10 (after persona, before per-tool guidance). It tells the model to take the simplest path, orient then act, prefer specialized and MCP tools, and ask rather than reverse-engineer a blocked environment. When visible tools include `mcp__<server>__*`, the same section appends the live server list. Empty `section` config disables the contribution.
2. **Inspection-stall reminders** on `tools/post-execute`, matching the repeat-tool-reminder delivery path (`additionalContexts`, plugin-sourced `user/message`, first threshold gentle, later thresholds detailed). Consecutive tracked calls that are not `progress` increment a per-agent counter; a `progress` match or a user prompt resets it. Default `progress` is `write`, `edit`, `str_replace_editor`, `ask_user_question`, `run_code`, `mcp__*`. Default `exclude` is `todo_write`. Default `thresholds` are `[8, 14, 22]`. Empty `thresholds` disables reminders.

The plugin is mounted in [`dsh-base`](../../../../packages/bundle/base/cordis.patch.yml) so every profile that stacks the shared core receives it, and in the ACP example composition so that surface matches. The `minimal` preset's `complete: true` persona still suppresses the section. The concrete `dsh-agent-loop` is unchanged.

MCP preference is owned here, not by `dsh-mcp-client`, because the habit is "prefer specialized tools when they exist" and the live server list is a `ctx.tools.schemas()` projection. Connecting a user's editor MCP server remains composition: one `dsh-mcp-client` row per server in a profile or home patch. This decision does not auto-import Cursor MCP configs.

## Alternatives considered

- **Only expand the YAML persona in each preset and mode bundle** — the operating contract would live in three copy-pasted strings and drift the moment one surface edits it. The [prompt-ownership decision](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) already assigned role-and-behavior prose to a single owner; a plugin section is that owner.
- **A Cocos-specific skill or MCP-only prompt** — treats one domain. The abort is the same pattern as any "port this / wire that / the editor API exists" task.
- **Change `dsh-agent-loop` with a step budget** — forbids the documented extension-point rule, and a hard cap cuts legitimate large-codebase orientation. Advisory reminders reuse the repeat-tool-reminder path.
- **Put stall detection on the goal reflector** — the deferred reflector in the [harness-level loop decision](2026-07-16-harness-level-loop.md) evaluates goal rounds, not ordinary first turns. This abort never created a goal.
- **Count only `read`/`grep`/`glob`** — a host-search via `pwsh` would reset the chain, which is exactly the UUID-install rabbit hole. Treating non-progress as the complement of an explicit `progress` list catches mixed inspection.
- **Auto-import Cursor MCP servers into dsh** — a different product surface (settings, trust, process lifetime) with no current consumer in the harness composition. Users add `dsh-mcp-client` rows; the operating contract then names those servers when they are live.

## Consequences

- Default web, headless, and ACP coding agents receive a short operating contract on every request, plus stall nudges after eight consecutive non-progress calls.
- Token cost is the contract plus an optional MCP appendix; stall reminders are append-only history after their thresholds.
- Shell mutations still count as inspection unless a deployment adds `bash`/`pwsh` to `progress`. That is the trade that catches host-search rabbit holes; deployments that implement primarily through the shell override `progress`.
- Repeat-tool-reminder remains the identical-call detector. The two guards can both fire on a long identical-read run; that overlap is accepted.

## Testing

Package tests drive a real agent loop against a scripted mock adapter: default and empty sections, live MCP appendix, fiber disposal of the section, consecutive mixed inspection, progress reset, exclude transparency, per-agent keying, user-prompt reset, agentless executes, fail-loud config, empty-threshold disable, and Loader `unwrapExports`. Mounting the plugin in `dsh-base` and the ACP example makes the section appear in those surfaces' assembled system-prompt snapshots.
