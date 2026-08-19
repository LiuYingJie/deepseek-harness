# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

Model-facing memory ledger tools, the step injection of the active ledger, and turn-failure capture. The ledger is durable improvement memory: problems that persisted, decisions taken, lessons kept — written by the model or captured automatically, injected into every later session on the same project.

## Composition

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'

- id: tool-memory
  name: '@deepseek-ai/dsh-tool-memory'
  config:
    maxInjectEntries: 32      # active records rendered per publication
    maxDetailChars: 240       # per-record detail budget inside the block
    autoCaptureFailures: true # turn/end reason.kind=error appends one `auto` problem
```

## Tools

| Tool | Contract |
|---|---|
| `memory_record` | Append one record (`kind`: problem/decision/lesson, `title`, optional `detail`). Survives this session; injected later. |
| `memory_list` | Active records from the folded ledger. |
| `memory_resolve` | Mark one record resolved with a note naming the fix; unknown or already-resolved ids report `resolved: false`. |

## Injection

The first `agent/pre-step` of a session publishes the active ledger as one `<system-reminder>`-framed `<memory_ledger>` user message (source `memory-ledger`, a `catalog`-form context recording exactly the entries published). Later steps republish only when the durable entry list changed — digest over `[id, kind, title, origin]`, never the rendered prose — replacing the earlier publication. Publication is gated on the exact `memory_record` tool registration being visible to the agent, mirroring the skill catalog: a restricted tool view also removes the ledger guidance. An empty, never-published ledger injects nothing.

## Turn-failure capture

When `autoCaptureFailures` is on, a `turn/end` with `reason.kind === 'error'` appends one `auto`-origin problem record (`Turn <n> failed: <first 160 chars>`, code in `detail`). Capture is fire-and-forget: a ledger write failure logs a warning and never fails the session.

## Model Experience

### Request context and condition

#### What the model sees

One retained user-role `<system-reminder>` block per session (plus a replacement when the active set changes), listing active records as `- [mem-xxxx] (kind/origin) title` with clipped detail, followed by standing guidance.

#### Token effect

Capped: at most `maxInjectEntries` lines plus per-record `maxDetailChars` of detail; zero when the ledger is empty and was never published.

#### KV Cache effect

Append-only within a session while the active set is unchanged: the published block sits in the retained prefix and each step reuses it. A ledger change replaces the earlier publication (a new message appended; the old one removed from the decision messages), invalidating reuse from that point.

## Known Limitations and Deferred Work

- **No cross-project visibility** — the ledger anchors to one project root; a user-level or multi-project rollup is deferred.
- **Auto capture deduplicates only by resolve** — repeated identical turn failures each append a record; folding duplicates by error code is deferred until real usage shows the noise profile.
