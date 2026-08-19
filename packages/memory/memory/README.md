# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

Project-level durable issue ledger. One append-only JSONL stream per project root — `.dsh/memory/ledger.jsonl` under the nearest `.git` ancestor — folded into the active record set on every read. The ledger is cross-session improvement memory: unresolved problems, standing decisions, and lessons that a later session consumes as standing context.

## Composition

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'
  config:
    path: './.dsh/memory/ledger.jsonl'   # optional; defaults to the project root anchor
```

`path` defaults to `<nearest .git ancestor>/.dsh/memory/ledger.jsonl` when omitted.

## Service API

`ctx.memory` (class `MemoryService`, default export):

- `snapshot(): Promise<MemoryLedgerState>` — active (unresolved) records in fold order plus the total event count. Every read re-validates the durable JSON boundary: a malformed line fails with `MemoryLedgerError` (`CORRUPT_LEDGER`), never a silently wrong fold.
- `add(input): Promise<MemoryRecord>` — append one `open` event; `id` (`mem-<8 hex>`) and `createdAt` are minted here.
- `resolve(input): Promise<MemoryRecord | undefined>` — append one `resolve` event; returns the annotated record, or `undefined` when the id is unknown or already resolved (nothing is appended).

Writes serialize through the cross-process file lock (`dsh-atomic-write`) and refresh the fold from disk under the lock before each append, so concurrent writers observe one serialized order. The ledger file lives outside the session log; it owns no session event stream.

## Record kinds and origins

`kind`: `problem` (unresolved issue awaiting work), `decision` (standing choice), `lesson` (durable takeaway). `origin`: `agent` (model call), `auto` (turn-failure capture), `human` (external edit or future human surface).

## Extension points

Compose `dsh-tool-memory` for the model-facing surface; the ledger seam itself carries nothing model-visible.

## Model Experience

### Request context and condition

#### What the model sees

None. This package defines the ledger seam; model-facing injection belongs to `dsh-tool-memory`.

#### Token effect

None — no model request is built from this package.

#### KV Cache effect

None — no model request is built from this package.

## Known Limitations and Deferred Work

- **Single ledger file per project** — one stream serves every concurrent process through the file lock; sharding by topic or project area is deferred until a real workload needs it.
- **No watch/hot-reload of external edits** — the fold refreshes on the next `snapshot()` after a write; a human edit between sessions is picked up on the next load, but live sessions do not re-read on external change.
