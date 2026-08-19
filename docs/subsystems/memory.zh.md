# 项目记忆台账

[English](memory.md) | 中文

项目记忆台账是一项[能力 seam](../../.agents/notes/implemented/feature/2026-08-18-project-memory-ledger.md)，把项目的未解决问题、长期决策与经验教训持久为一条追加式 JSONL 流，并折叠出活跃记录集；该能力拆分到两个包：Service Definition 与 Provider（[dsh-memory](../../packages/memory/memory)，`ctx.memory`）、Consumer（[dsh-tool-memory](../../packages/memory/tool-memory)，模型侧工具、步骤注入与 turn 失败捕获）。台账是跨会话的持久改进输入：后续会话——或后台改进 agent——把活跃记录作为常驻上下文消费。seam 本身不携带任何模型可见内容；所有模型侧表面归 Consumer 所有。

源码：[`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

## 记录

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

`kind` 为记录分类：`problem`（待处理的未解决问题）、`decision`（长期决策）、`lesson`（持久经验）。`origin` 标明作者：`agent`（经 `memory_record` 的模型调用）、`auto`（turn 失败捕获）、`human`（外部编辑）。已解决的记录在返回值中保留注记，但从不重新进入活跃集合。

## 台账流

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

折叠只保留活跃（未解决）记录：`open` 插入其记录，`resolve` 把目标从活跃集合移除，解决注记附在返回的记录上。`total` 统计流中全部事件。写入经跨进程文件锁串行化，且每次追加前在锁内重读折叠；每次 `snapshot()` 都重新读取并折叠完整流，因为该文件可被外部编辑。畸形行以 `MemoryLedgerError`（`CORRUPT_LEDGER`）失败，绝不静默给出错误折叠。

## 在目录中的位置

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
