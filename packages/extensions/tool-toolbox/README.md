# @deepseek-ai/dsh-tool-toolbox

English | [中文](README.zh.md)

Model-facing toolbox tools plus the persistent tool mount. The model publishes and retires tool versions through `toolbox_publish` / `toolbox_retire` / `toolbox_list`; every active version from the durable library mounts as a real tool whose `execute` runs the stored program through the code-runtime seam. Mounted tools survive restarts because the library is durable; publishing a name hot-swaps its mount to the new program.

## Composition

```yaml
- id: toolbox
  name: '@deepseek-ai/dsh-toolbox'

- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'

- id: tool-toolbox
  name: '@deepseek-ai/dsh-tool-toolbox'
  config:
    mountOnLoad: true   # mount the active library set when the plugin loads
    watchLibrary: true  # hot-sync the mount on library edits from other processes
    watchStabilityMs: 500
```

A code-runtime backend is required at call time; without one, calling a mounted tool fails loud naming the missing backend.

## Tools

| Tool | Contract |
|---|---|
| `toolbox_publish` | Publish one tool version (name, description, parameter map, program). The program is an async function body; the validated call arguments arrive as `args` and the completion `return` value must be lossless JSON. Publishing an existing name replaces its active version. |
| `toolbox_retire` | Remove the active version of one name; it stops being callable and is unmounted. Unknown names report `retired: false`. |
| `toolbox_list` | Active tools with their version ids, descriptions, and origins. |

Parameter types map onto the tool schema DSL: `string`, `number`, `integer`, `boolean` (with optional `enum`), plus `array`, `object`, `json`. A publish naming an unmappable type is rejected before anything is persisted.

## Mount semantics

On load the plugin folds the library and registers one real tool per active version; the initial mount settles before the plugin finishes loading, so a corrupt library fails loud at load. A later publish or retire re-syncs the mounted set, and library edits from other sessions or external editors hot-sync through a file watcher once writes settle (`watchLibrary`, default true, debounced by `watchStabilityMs`, default 500) — the library is a cross-process JSONL stream, so no restart is needed to see another session's tools. All syncs run through one serialized queue, so watcher-triggered and tool-triggered syncs never race duplicate registrations. Each mounted tool resolves the name's current active version at call time, so a program published after the mount runs without a remount; a name retired under a live mount reports the stale mount as an error on the next call. A stored schema that cannot map onto the registry DSL (hand-edited library) is skipped with a warning instead of blocking the remaining mounts.

What a running process cannot hot-load is its own source: harness or plugin code changes need a restart.

Programs run through the worker-thread code runtime with its compute/wall budgets and abort handling; a failed run surfaces as a tool error carrying the failure kind, message, and captured output.

## Model Experience

### Request context and condition

#### What the model sees

The three management tools always — `toolbox_publish`, `toolbox_retire`, `toolbox_list`; each active library tool as a normal tool with its stored description and parameters. The mounted description carries the version id so the model can cite the exact version it used.

#### Token effect

The three management tool schemas plus one schema per active library tool enter every request that lists tools. Programs and their outputs are bounded by the code runtime's output cap, not by this package.

#### KV Cache effect

Stable while the library is unchanged: tool schemas sit in the request prefix. A publish or retire — local or picked up from another process — changes the tool list from the next request on, invalidating reuse from that point.

## Known Limitations and Deferred Work

- **Programs receive no host bindings** — a mounted tool's program runs standalone with `args` only; bridging selected host functions into library tools is deferred until a concrete tool needs one.
- **No per-tool budget override** — every program runs under the shared code-runtime budgets; per-tool tuning is deferred until real usage shows the need.
