# Improvement Proposal Stream

[English](refinery.md) | 中文

refinery——一个[能力 seam](../../.agents/notes/implemented/feature/2026-08-18-background-refinery-proposal-stream.md)，把项目的后台编写改进提案存为一条追加式 JSONL 流并折叠出活跃提案集，拆分为包：Service Definition 与 Provider（[dsh-refinery](../../packages/extensions/refinery)，`ctx.refinery`）、Consumer（[dsh-tool-refinery](../../packages/extensions/tool-refinery)，模型可见管理工具与只读编写者 subagent）。提案是分析加建议的变更——绝不是已应用的变更：这条流的存在，是为了让人类（或经人类授权的会话）在任何修改之前审查后台分析者的结论。seam 本身不携带任何模型可见内容；Consumer 拥有全部模型可见表面。

Source: [`packages/extensions/refinery/src/index.ts`](../../packages/extensions/refinery/src/index.ts)

## The proposal

```ts type-equiv
/** One immutable proposal as folded from the stream. */
interface RefineryProposal {
  /** Proposal identity, stable across processes. */
  readonly id: string
  /** One-line summary naming the improvement. */
  readonly title: string
  /** Complete proposal body: analysis, proposed change, and effort estimate. */
  readonly body: string
  /** Memory-ledger record ids this proposal addresses, when known. */
  readonly addresses: readonly string[]
  readonly createdAt: number
  /** Session that authored the proposal, when known. */
  readonly sessionId?: string
  /** Settlement annotation; presence and value mark the proposal inactive. */
  readonly settled?: { status: RefineryProposalStatus; at: number; note: string }
}
```

`sessionId` 引用委托会话，因此持久记录无需回放编写子会话即可回答"哪个会话委托了这份分析"。已结算提案在历史中保留注记，但绝不重新进入活跃集。

## The proposal stream

```ts type-equiv
/** Stream event shapes as persisted to the JSONL stream. */
type RefineryEvent
  = | { readonly type: 'propose'; readonly proposal: RefineryProposal }
    | {
      readonly type: 'settle'
      readonly id: string
      readonly status: RefineryProposalStatus
      readonly at: number
      readonly note: string
    }
```

```ts type-equiv
/** Folded stream state: active (unsettled) proposals. */
interface RefineryState {
  readonly active: readonly RefineryProposal[]
  readonly total: number
}
```

折叠按插入顺序保留未结算提案：一条 `propose` 追加一条，一条 `settle` 移除一条。`total` 统计流中全部事件。写入通过跨进程文件锁串行化，并在每次追加前于锁内重新读取折叠；每次 `snapshot()` 都重新读取并重新折叠完整流，因为该文件可被外部编辑。格式错误的行以 `RefineryError`（`CORRUPT_STREAM`）失败，绝不产生静默错误的折叠。

## Placement in the tree

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxrefinery--refineryservice"></a>

### `ctx.refinery` — `RefineryService`

Refinery service (`ctx.refinery`): one durable project proposal stream. Writes serialize through the cross-process file lock; the in-process fold is refreshed under the lock before each append so concurrent writers never fold a stale prefix.

```ts cordis-catalog
/**
 * Snapshot of the folded stream state. Every snapshot re-reads and re-folds
 * the stream: it is a cross-session, externally editable file, so a cached
 * fold would hide both external edits and corruption.
 * @returns active proposals in insertion order plus the total event count.
 */
async snapshot(): Promise<RefineryState>

/**
 * Append one `propose` event.
 * @param input - proposal fields; `id` and `createdAt` are minted here.
 * @returns the persisted proposal.
 */
async propose(input: RefineryProposeInput): Promise<RefineryProposal>

/**
 * Append one `settle` event.
 * @param input - proposal id, terminal status, and settlement note.
 * @returns the settled proposal with its annotation, or `undefined` when the
 *   id is unknown or already settled.
 */
async settle(input: RefinerySettleInput): Promise<RefineryProposal | undefined>
```

Source: [`packages/extensions/refinery/src/index.ts:227`](../../packages/extensions/refinery/src/index.ts)
<!-- END GENERATED cordis-surface -->
