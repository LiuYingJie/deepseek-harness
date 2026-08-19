# Persistent Project Toolbox

English | [中文](toolbox.zh.md)

The persistent project toolbox — a [capability seam](../../.agents/notes/implemented/feature/2026-08-18-persistent-project-toolbox.md) that stores a project's model-authored tools as one append-only JSONL stream, folded into the active tool set, split across packages: Service Definition and Provider ([dsh-toolbox](../../packages/extensions/toolbox), `ctx.toolbox`), Consumer ([dsh-tool-toolbox](../../packages/extensions/tool-toolbox), the model-facing management tools and the mount that re-registers active library tools as real `ctx.tools` entries). The library is durable cross-session capability: a later session — or a background improvement agent — re-mounts the active versions without re-authoring them. The seam itself carries nothing model-visible; the Consumer owns every model-facing surface.

Source: [`packages/extensions/toolbox/src/index.ts`](../../packages/extensions/toolbox/src/index.ts)

## The tool version

```ts type-equiv
/** One immutable tool version as folded from the stream. */
interface ToolboxRecord {
  /** Version identity, stable across processes. */
  readonly id: string
  readonly schema: ToolboxToolSchema
  /**
   * Program source: the body of an async function receiving `(args, exec)`.
   * Executed through the code-runtime seam at call time.
   */
  readonly program: string
  readonly origin: ToolboxOrigin
  readonly createdAt: number
  /** Session that authored the version, when known. */
  readonly sessionId?: string
  /** Supersession annotation; presence marks the version inactive. */
  readonly superseded?: { at: number; by: string }
}
```

`origin` names the author: `agent` (model call through `toolbox_publish`), `human` (external edit). A superseded version keeps its annotation in history but never re-enters the active set. The stored `schema` uses the `ToolboxParameterSpec` descriptor form; the Consumer validates it at publish time and narrows it into the `defineTool` parameter DSL when mounting.

## The library stream

```ts type-equiv
/** Ledger event shapes as persisted to the JSONL stream. */
type ToolboxEvent
  = | { readonly type: 'publish'; readonly record: ToolboxRecord }
    | {
      readonly type: 'retire'
      readonly name: string
      readonly at: number
      /** Version that supersedes the active one, when this retire accompanies a publish. */
      readonly by?: string
    }
```

```ts type-equiv
/** Folded library state: the active version per tool name. */
interface ToolboxState {
  readonly tools: readonly { readonly name: string; readonly version: ToolboxRecord }[]
  readonly total: number
}
```

The fold keeps one active version per tool name: a `publish` replaces the name's active entry, a `retire` removes the name. `total` counts every event in the stream. Writes serialize through the cross-process file lock and re-read the fold under the lock before each append; every `snapshot()` re-reads and re-folds the complete stream because the file is externally editable. A malformed line fails as `ToolboxError` (`CORRUPT_LIBRARY`), never a silently wrong fold.

## Placement in the tree

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtoolbox--toolboxservice"></a>

### `ctx.toolbox` — `ToolboxService`

Toolbox service (`ctx.toolbox`): one durable project tool library. Writes serialize through the cross-process file lock; the in-process fold is refreshed under the lock before each append so concurrent writers never fold a stale prefix.

```ts cordis-catalog
/**
 * Snapshot of the folded library state. Every snapshot re-reads and re-folds
 * the stream: the library is a cross-session, externally editable file, so a
 * cached fold would hide both external edits and corruption.
 * @returns the active version per tool name plus the total event count.
 */
async snapshot(): Promise<ToolboxState>

/**
 * Append one `publish` event, retiring any active version of the same name.
 * @param input - schema, program, and authorship; `id` and `createdAt` are minted here.
 * @returns the persisted version record.
 */
async publish(input: ToolboxPublishInput): Promise<ToolboxRecord>

/**
 * Append one `retire` event removing the active version of one tool name.
 * @param name - the tool name whose active version is removed.
 * @returns whether an active version was removed.
 */
async retire(name: string): Promise<boolean>
```

Source: [`packages/extensions/toolbox/src/index.ts:260`](../../packages/extensions/toolbox/src/index.ts)
<!-- END GENERATED cordis-surface -->
