# @deepseek-ai/dsh-toolbox

English | [中文](README.zh.md)

Project-level durable tool library. One append-only JSONL stream per project root — `.dsh/toolbox/toolbox.jsonl` under the nearest `.git` ancestor — folded into the active tool set on every read. Each tool version carries a model-authored program (an async function body executed through the code-runtime seam) and its model-facing schema. A later session re-mounts the active versions as real tools without re-authoring them.

## Composition

```yaml
- id: toolbox
  name: '@deepseek-ai/dsh-toolbox'
  config:
    path: './.dsh/toolbox/toolbox.jsonl'   # optional; defaults to the project root anchor
```

`path` defaults to `<nearest .git ancestor>/.dsh/toolbox/toolbox.jsonl` when omitted.

## Service API

`ctx.toolbox` (class `ToolboxService`, default export):

- `snapshot(): Promise<ToolboxState>` — the active version per tool name plus the total event count. Every read re-validates the durable JSON boundary: a malformed line fails with `ToolboxError` (`CORRUPT_LIBRARY`), never a silently wrong fold.
- `publish(input): Promise<ToolboxRecord>` — append one `publish` event, replacing any active version of the same name; `id` (`tool-<8 hex>`) and `createdAt` are minted here.
- `retire(name): Promise<boolean>` — append one `retire` event removing the name's active version; returns whether one was removed (a name without an active version appends nothing).

Writes serialize through the cross-process file lock (`dsh-atomic-write`) and refresh the fold from disk under the lock before each append, so concurrent writers observe one serialized order. The library file lives outside the session log; it owns no session event stream.

## Tool names and versions

Tool names match `^[a-z][a-z0-9_]{2,63}$`. A `publish` to an existing name supersedes the active version (the supersession rides history); the stream keeps every event, and the fold exposes only the active set. `origin`: `agent` (model call) or `human` (external edit or future human surface).

## Extension points

Compose `dsh-tool-toolbox` for the model-facing surface and the live mount; this library seam carries nothing model-visible.

## Model Experience

### Request context and condition

#### What the model sees

None. This package defines the library seam; model-facing tools belong to `dsh-tool-toolbox`.

#### Token effect

None — no model request is built from this package.

#### KV Cache effect

None — no model request is built from this package.

## Known Limitations and Deferred Work

- **Single library file per project** — one stream serves every concurrent process through the file lock; per-directory scoping is deferred until a real workload needs it.
- **No listing API for history** — the fold exposes the active set only; a history query over superseded versions is deferred until a consumer exists.
