# @deepseek-ai/dsh-tool-refinery

English | [中文](README.zh.md)

Model-facing refinery tools plus the background proposal author. `refinery_run` reads the unresolved problems from the project memory ledger, spawns one read-only analyst subagent through the subagent seam, and persists its structured result as a durable improvement proposal. `refinery_list` and `refinery_settle` read and settle the active proposal set. A refinery run never modifies the project: the author child is tool-scoped to a read-only allow list, and every proposal waits for an explicit human-side settlement.

## Composition

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'

- id: tool-memory
  name: '@deepseek-ai/dsh-tool-memory'

- id: refinery
  name: '@deepseek-ai/dsh-refinery'

- id: tool-refinery
  name: '@deepseek-ai/dsh-tool-refinery'
  config:
    provider: spawn                    # ctx.subagents provider for authors
    authorToolAllow:                   # read-only tools the author keeps
      - fs_read
      - fs_search
      - session_search
      - memory_list
    maxLedgerEntries: 16               # ledger problems rendered into the prompt
```

A registered subagent provider with `outputSchema`, `toolFilter`, and `persona` capabilities is required; without one, `refinery_run` fails loud naming the missing provider.

## Tools

| Tool | Contract |
|---|---|
| `refinery_run` | Run one background proposal author. Reads active `problem` records from the memory ledger, spawns the scoped analyst, and persists one structured proposal (title, body, addresses). Optional `focus` steers the author toward one area. |
| `refinery_list` | Active proposals with their ids, titles, and addressed ledger records. |
| `refinery_settle` | Settle one proposal: `applied` (name what landed) or `discarded` (why not). Unknown ids report `settled: false`. An `applied` settlement returns `restartRecommended` — true by default because source/config changes cannot hot-load; the model passes `restartRecommended: false` for pure data or documentation edits and must relay a true value to the user. |

## Author semantics

The author child receives the ledger problems rendered into its prompt, an analyst persona that forbids modification, and a tool allow list — every other tool is removed from its prompt and refuses execution (one visibility). The structured output must satisfy the proposal schema; a run ending without a valid capture fails the tool call rather than persisting a partial proposal. The persisted proposal records the calling session, so the stream can cite which session commissioned the analysis.

## Model Experience

### Request context and condition

#### What the model sees

The three management tools — `refinery_run`, `refinery_list`, `refinery_settle` — whenever this plugin is registered. The author child additionally sees its analyst persona and the allow-listed read tools, never the full tool surface.

#### Token effect

Three fixed tool schemas per tool-listing request. A `refinery_run` call costs one child session whose size is bounded by the subagent seam and the model's own discipline, not by this package.

#### KV Cache effect

Stable while the plugin is registered: the three schemas sit in the request prefix. The author child is a fresh session each run; it never shares the parent's prefix.

## Known Limitations and Deferred Work

- **No autonomous trigger** — the author runs when the model (or a composing workflow) calls `refinery_run`; wiring an idle/timer-driven trigger belongs to the schedule or goal plugins, deliberately not baked in here.
- **Ledger coupling is one-way** — the author consumes `problem` records but nothing auto-resolves them when a proposal settles; the model decides and records that with `memory_resolve`.
- **Single proposal per run** — one `refinery_run` call persists exactly one proposal; batching several analyses into one run is deferred until real usage shows the need.
