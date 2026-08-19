# 持久项目工具库

[English](toolbox.md) | 中文

持久项目工具库是一项[能力 seam](../../.agents/notes/implemented/feature/2026-08-18-persistent-project-toolbox.md)，把项目内模型编写的工具存为一条追加式 JSONL 流，并折叠出活跃工具集；该能力拆分到两个包：Service Definition 与 Provider（[dsh-toolbox](../../packages/extensions/toolbox)，`ctx.toolbox`）、Consumer（[dsh-tool-toolbox](../../packages/extensions/tool-toolbox)，模型侧管理工具，以及把活跃库工具重新注册为真实 `ctx.tools` 条目的挂载层）。工具库是跨会话的持久能力：后续会话——或后台改进 agent——直接重新挂载活跃版本，无需重新编写。seam 本身不携带任何模型可见内容；所有模型侧表面归 Consumer 所有。

源码：[`packages/extensions/toolbox/src/index.ts`](../../packages/extensions/toolbox/src/index.ts)

## 工具版本

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

`origin` 标明作者：`agent`（经 `toolbox_publish` 的模型调用）、`human`（外部编辑）。被取代的版本在历史中保留注记，但从不重新进入活跃集合。存储的 `schema` 使用 `ToolboxParameterSpec` 描述符形式；Consumer 在发布时校验，并在挂载时窄化为 `defineTool` 参数 DSL。

## 库流

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

折叠只保留每个工具名的一个活跃版本：`publish` 替换该名字的活跃条目，`retire` 移除该名字。`total` 统计流中全部事件。写入经跨进程文件锁串行化，且每次追加前在锁内重读折叠；每次 `snapshot()` 都重新读取并折叠完整流，因为该文件可被外部编辑。畸形行以 `ToolboxError`（`CORRUPT_LIBRARY`）失败，绝不静默给出错误折叠。

## 在目录中的位置

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
