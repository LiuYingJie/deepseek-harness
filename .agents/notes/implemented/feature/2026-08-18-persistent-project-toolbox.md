# Agent Note: Persistent project toolbox — a durable self-authored tool library

Status: implemented

English | [中文](2026-08-18-persistent-project-toolbox.zh.md)

## Problem

The agent could invent a better workflow mid-session but had no way to keep the tool that encoded it. `ctx.dynamicCordisRunner` runs model-written plugins with full lifecycle semantics but keeps them in memory only — a restart loses every dynamic tool. Skills persist on disk but describe procedures for the model to follow, not executable tools. The gap: a per-project tool library that survives restarts, mounts its entries as real callable tools, and lets the model iterate on them the way it iterates on code.

## Decision

A capability pair, following the [capability-seam rule](../../../../docs/glossary.md):

- **`dsh-toolbox`** (`ctx.toolbox`) owns one append-only JSONL library per project root (`<root>/.dsh/toolbox/toolbox.jsonl`, rooted at the nearest `.git` ancestor). Each `publish` event carries a complete tool version: the model-facing schema (name, description, parameter map) plus the program — the body of an async function. The fold keeps one active version per name; a later publish of the same name supersedes it. Writes serialize through the cross-process `withFileLock` with a fold refresh under the lock before every append; every `snapshot()` re-reads the file (cross-session, externally editable). Malformed lines fail loud as `CORRUPT_LIBRARY`. This mirrors `dsh-memory` deliberately: one storage idiom for the whole self-improvement stack.
- **`dsh-tool-toolbox`** publishes the model-facing surface and the mount: `toolbox_publish` / `toolbox_retire` / `toolbox_list` tools, plus a `syncMount` that registers one real `defineTool` tool per active library version. Execution goes through the code-runtime seam (`ctx.codeRuntime`, resolved lazily via `ctx.get` so backend load order is free): the mounted `execute` injects the validated call arguments into the program as a JSON `const args = ...` prologue, because the worker backend's async-function shell parameterizes only binding namespaces and `console` — a program referencing `args` without the prologue would die on a `ReferenceError`. The `execute` resolves the name's *current* active version at call time, so a program published after the mount ran runs without a remount.

Parameter types validate at publish (the executor owns the decision): the tool accepts the DSL-mappable set (`string`/`number`/`integer`/`boolean` with `enum`, `array`, `object`, `json`) and rejects anything else before the event is persisted. The initial mount is awaited inside `apply`, so a corrupt library fails at plugin load, and a hand-edited library entry with an unmappable schema is skipped with a warning rather than blocking the remaining mounts.

Library edits from other processes hot-sync the mount: a chokidar watcher on the library file re-runs the mount sync once writes settle (`watchLibrary`, default true; `watchStabilityMs` debounce). Syncs serialize through one promise queue shared with the publish/retire tools so watcher-triggered and tool-triggered syncs never race duplicate registrations. The library is the online-update plane; the running process's own source is not — harness/plugin code changes need a restart.

## Alternatives considered

- **`dynamicCordisRunner` plus a persistence layer** — its `define`/`run` round trip and `node:vm` sandbox target full plugins with host/client halves; tool-shaped programs would pay the package lifecycle without needing it, and persisting its in-memory registries would fork its ownership model. A narrow library over the code-runtime seam keeps the execution isolation (`worker-thread`, budgets, abort) without the plugin machinery.
- **Skills (`dsh-skill`) as the storage** — skills are prose procedures, not executable definitions; the model would re-derive the program on every use. The toolbox stores the program itself.
- **A model-visible `eval` tool per session** — no durability, no schema validation on later calls, and every caller re-trusts the program text. Publishing through `toolbox_publish` validates once and mounts a normal tool the registry already knows how to present, schedule, and log.

## Consequences

- A tool authored once is callable in every later session on the project, without re-authoring: the "infinite personal tool library" surface. Publishing an existing name hot-swaps the running program — iteration on a tool is the same gesture as creating it.
- A tool published by another session (or a hand-edited library file) mounts here without a restart once the write settles; the watcher's stability debounce trades a bounded delay for robustness against partial writes, the same trade `skill-filesystem` makes.
- Tool programs receive no host bindings (`bindings: []`): a library tool is pure computation over its arguments. Bridging selected host functions (fs, subprocess, web) into library tools is deliberately deferred — the security surface of persisted, model-authored programs calling host capabilities needs its own review, and no current tool needs it.
- Programs run under the shared code-runtime compute/wall budgets; a runaway tool dies by timeout, not by starving the process.
- The mounted description carries the version id (`(project toolbox tool, version tool-xxxxxxxx)`), so the model and the session log can cite the exact version that executed.
- Every active library tool's schema rides every tool-listing request: the standing token cost grows linearly with the active set, bounded only by `toolbox_retire`. That is the explicit trade for persistence.
