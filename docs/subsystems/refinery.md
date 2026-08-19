# Improvement Proposal Stream

English | [中文](refinery.zh.md)

The refinery — a [capability seam](../../.agents/notes/implemented/feature/2026-08-18-background-refinery-proposal-stream.md) that stores a project's background-authored improvement proposals as one append-only JSONL stream, folded into the active proposal set, split across packages: Service Definition and Provider ([dsh-refinery](../../packages/extensions/refinery), `ctx.refinery`), Consumer ([dsh-tool-refinery](../../packages/extensions/tool-refinery), the model-facing management tools and the read-only author subagent). A proposal is analysis plus a proposed change — never an applied change: the stream exists so a human (or a human-authorized session) reviews what a background analyst concluded before anything is modified. The seam itself carries nothing model-visible; the Consumer owns every model-facing surface.

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

`sessionId` cites the commissioning session, so the durable record answers "which session asked for this analysis" without replaying the author child. A settled proposal keeps its annotation in history but never re-enters the active set.

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

The fold keeps the unsettled proposals in insertion order: a `propose` appends one, a `settle` removes one. `total` counts every event in the stream. Writes serialize through the cross-process file lock and re-read the fold under the lock before each append; every `snapshot()` re-reads and re-folds the complete stream because the file is externally editable. A malformed line fails as `RefineryError` (`CORRUPT_STREAM`), never a silently wrong fold.

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
