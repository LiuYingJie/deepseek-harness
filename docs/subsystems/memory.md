# Project Memory Ledger

English | [中文](memory.zh.md)

The project memory ledger — a [capability seam](../../.agents/notes/implemented/feature/2026-08-18-project-memory-ledger.md) that persists a project's unresolved problems, standing decisions, and lessons as one append-only JSONL stream, folded into the active record set, split across packages: Service Definition and Provider ([dsh-memory](../../packages/memory/memory), `ctx.memory`), Consumer ([dsh-tool-memory](../../packages/memory/tool-memory), the model-facing tools, step injection, and turn-failure capture). The ledger is durable cross-session improvement input: a later session — or a background improvement agent — consumes the active records as standing context. The seam itself carries nothing model-visible; the Consumer owns every model-facing surface.

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## The record

```ts type-equiv
/** One ledger record as folded from the stream. */
interface MemoryRecord {
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
```

`kind` classifies the record: `problem` (unresolved issue awaiting work), `decision` (standing choice), `lesson` (durable takeaway). `origin` names the author: `agent` (model call through `memory_record`), `auto` (turn-failure capture), `human` (external edit). A resolved record keeps its annotation in the returned value but never re-enters the active set.

## The ledger stream

```ts type-equiv
/** Ledger event shapes as persisted to the JSONL stream. */
type MemoryLedgerEvent
  = | { readonly type: 'open'; readonly record: MemoryRecord }
    | {
      readonly type: 'resolve'
      readonly id: string
      readonly at: number
      readonly note: string
      readonly sessionId?: string
    }
```

```ts type-equiv
/** Folded ledger state. */
interface MemoryLedgerState {
  readonly active: readonly MemoryRecord[]
  readonly total: number
}
```

The fold keeps active (unresolved) records only: an `open` inserts its record, a `resolve` removes its target from the active set, and the resolved annotation rides the returned record. `total` counts every event in the stream. Writes serialize through the cross-process file lock and re-read the fold under the lock before each append; every `snapshot()` re-reads and re-folds the complete stream because the file is externally editable. A malformed line fails as `MemoryLedgerError` (`CORRUPT_LEDGER`), never a silently wrong fold.

## Placement in the tree

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice"></a>

### `ctx.memory` — `MemoryService`

Memory service (`ctx.memory`): one durable project ledger. Writes serialize through the cross-process file lock; the in-process fold is refreshed under the lock before each append so concurrent writers never fold a stale prefix.

```ts cordis-catalog
/**
 * Snapshot of the folded ledger state. Every snapshot re-reads and re-folds
 * the stream: the ledger is a cross-session, externally editable file, so a
 * cached fold would hide both external edits and corruption.
 * @returns active records in insertion order plus the total event count.
 */
async snapshot(): Promise<MemoryLedgerState>

/**
 * Append one `open` event.
 * @param input - record fields; `id` and `createdAt` are minted here.
 * @returns the persisted record.
 */
async add(input: MemoryAddInput): Promise<MemoryRecord>

/**
 * Append one `resolve` event.
 * @param input - record id and resolution note.
 * @returns the resolved record with its annotation, or `undefined` when the
 *   id is unknown or already resolved.
 */
async resolve(input: MemoryResolveInput): Promise<MemoryRecord | undefined>
```

Source: [`packages/memory/memory/src/index.ts:227`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
