# Agent Note: Project memory ledger — durable self-improvement input

Status: implemented

English | [中文](2026-08-18-project-memory-ledger.zh.md)

## Problem

Sessions ended with their failures. A flaky build, a decision made under uncertainty, a workaround that must not be repeated — all of it lived only in that session's log, so the next session (or a later optimization pass on the same project) started from zero. The repo had no seam where "what was not solved" could persist per project and re-enter the model's context. Users also wanted the failures themselves to be collected without relying on the model remembering to write anything down.

## Decision

A capability pair, following the [capability-seam rule](../../../../docs/glossary.md):

- **`dsh-memory`** (`ctx.memory`) owns one append-only JSONL ledger per project root (`<root>/.dsh/memory/ledger.jsonl`, rooted at the nearest `.git` ancestor). The fold keeps active (unresolved) records only; a `resolve` event removes its target from the active set and the annotation rides the returned record, never the active list. Writes serialize through the cross-process `withFileLock`, and the in-process fold is re-read under the lock before every append so concurrent writers never fold a stale prefix. Every `snapshot()` re-reads and re-folds the stream: the ledger is a cross-session, externally editable file, so a cached fold would hide external edits and corruption. Malformed lines fail loud as `CORRUPT_LEDGER`.
- **`dsh-tool-memory`** publishes the model-facing surface on the existing extension points: three `defineTool` tools (`memory_record`, `memory_list`, `memory_resolve`), an `agent/pre-step` waterfall listener that injects the active ledger as a `user`-role message carrying the `memory-ledger` `MessageSourceMap` entry, and — when `autoCaptureFailures` (default true) — a `session/event` listener that appends one `auto`-origin problem record per failed `turn/end`. The injection is deduplicated by a digest over the durable entry list (not the rendered prose), so replay and compaction see a stable identity; tool-visibility gating mirrors the skill catalog, so a restricted tool view also removes the ledger guidance.

The ledger is deliberately dumb: it stores records, not behavior. Phase 2 (a persistent tool library) and Phase 3 (a background improvement agent that produces proposals only) both consume this same ledger as their input stream, which is why the service is a plain capability seam rather than a model-facing plugin alone.

## Alternatives considered

- **Session-log mining instead of a dedicated ledger** — the logs exist and are durable, but extracting "unsolved problems" from a full transcript requires interpretation at read time, every session pays that cost, and the extractor would be a second projection with no write path for the model to correct it. A first-class ledger with explicit tools makes both read and write cheap and inspectable.
- **SQLite (session-store precedent) instead of JSONL** — rejected for this seam: one file, human-editable, diff-friendly in code review, and the cross-process lock already exists in `dsh-atomic-write`. The event-sourced shape (`open`/`resolve` events folded into active state) keeps the on-disk format trivially appendable by future writers (the background agent of Phase 3).
- **Auto-capture only (no `memory_record`)** — failures are a narrow slice of what deserves recording; decisions and lessons are model judgments. Both origins write the same ledger, distinguished by the `origin` field, so a later reader can weigh them differently.

## Consequences

- Every new session on the project wakes with the unresolved-problem list already in context (bounded by `maxInjectEntries`, default 32; detail clipped at `maxDetailChars`, default 240) — a standing cost of roughly one short system-reminder per step, refunded when records are resolved.
- The injected message is `user`-role with a dedicated source kind, so Model-visible ⟺ logged holds with no new event type: `user/message` logging, replay, and transcript rows all come free.
- The empty-ledger case injects nothing on a first publication (no noise), but a `memory_record` in-session triggers a replacement ledger message marked `update: true`, so the model sees its own write immediately.
- Auto-capture is fire-and-forget: a capture failure logs a warning and never fails the session. A pathological model that loops failures can grow the ledger; `maxInjectEntries` bounds the context cost, and the ledger is a plain file a human can prune.
- `resolve` on an unknown id appends nothing and returns `undefined` — the fold stays clean without tombstone events.
