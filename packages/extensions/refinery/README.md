# @deepseek-ai/dsh-refinery

English | [中文](README.zh.md)

Project-level durable improvement-proposal stream. The refinery persists background-authored improvement proposals as one append-only JSONL stream per project root and folds it into the active proposal set. A proposal is analysis plus a proposed change — never an applied change: the stream exists so a human (or a human-authorized session) can review what a background analyst concluded before anything is modified.

## Composition

```yaml
- id: refinery
  name: '@deepseek-ai/dsh-refinery'
  config:
    path: './.dsh/refinery/proposals.jsonl'   # optional; defaults to the project root anchor
```

`path` defaults to `<nearest .git ancestor>/.dsh/refinery/proposals.jsonl` when omitted.

## Service API

`ctx.refinery` (class `RefineryService`, default export):

- `snapshot(): Promise<RefineryState>` — active (unsettled) proposals in insertion order plus the total event count. Every read re-validates the durable JSON boundary: a malformed line fails with `RefineryError` (`CORRUPT_STREAM`), never a silently wrong fold.
- `propose(input): Promise<RefineryProposal>` — append one `propose` event; `id` (`prop-<8 hex>`) and `createdAt` are minted here.
- `settle(input): Promise<RefineryProposal | undefined>` — append one `settle` event (`applied` or `discarded`); returns the annotated proposal, or `undefined` when the id is unknown or already settled.

Writes serialize through the cross-process file lock (`dsh-atomic-write`) and refresh the fold from disk under the lock before each append. The stream file lives outside the session log; it owns no session event stream.

## Extension points

Compose `dsh-tool-refinery` for the model-facing surface and the background proposal author; this stream seam carries nothing model-visible.

## Model Experience

None, as the service persists a project file; the seam carries no model-visible surface. Compose the Consumer for the tools and the author.

#### KV Cache effect

None; the service adds nothing to any request prefix.

## Known Limitations and Deferred Work

- **No author trigger built in** — the service only persists; when a proposal author runs (on load, on a timer, after N failures) belongs to the Consumer or the composing deployment, not to storage.
