# Agent Note: Background refinement — a proposal-only self-improvement loop

Status: implemented

English | [中文](2026-08-18-background-refinery-proposal-stream.zh.md)

## Problem

The self-reinforcement stack had two durable inputs and no consumer that closes the loop: the [memory ledger](2026-08-18-project-memory-ledger.md) accumulates unresolved problems (model-recorded and auto-captured turn failures), and the [persistent toolbox](2026-08-18-persistent-project-toolbox.md) keeps model-authored tools — but nothing turns accumulated problems into improvement work. The missing piece was a backend "refinement" workspace: a background agent that receives this AI feedback and improves the project on its own. The constraint chosen for it: **proposal-only** — the background agent may analyze and propose, never modify, because unattended self-modification of a codebase is the least safe autonomy level and the easiest to regret.

## Decision

A capability pair over the same storage idiom as the rest of the stack:

- **`dsh-refinery`** (`ctx.refinery`) owns one append-only JSONL stream per project root (`<root>/.dsh/refinery/proposals.jsonl`). Each `propose` event carries a complete proposal — title, body, and the ledger record ids it addresses; a `settle` event (`applied`/`discarded`) removes it from the active set. The fold, lock discipline, corruption failure, and snapshot semantics are deliberately identical to `dsh-memory` and `dsh-toolbox`: one storage idiom for the whole self-improvement stack.
- **`dsh-tool-refinery`** publishes the model-facing surface and the background author: `refinery_run` reads the active `problem` records from `ctx.memory`, renders them into one author prompt, and starts one subagent through `ctx.subagents` with three scoping decisions:
  - **Read-only enforcement by `toolFilter`** — the author child keeps only an allow list of read tools; everything else is removed from its prompt *and* refuses execution (the in-process provider's one-visibility restriction). Safety is a property of the spawned scope, not a prompt suggestion.
  - **Structured output** — the child must return the proposal schema (`title`, `body`, `addresses`); a run ending without a valid capture fails the tool call instead of persisting a partial proposal.
  - **Analyst persona** — scoped persona shadowing the deployment persona for the child alone, stating the never-modify contract in the child's own instructions.

  `refinery_list` and `refinery_settle` read and settle the stream; settling is the human-side gate that records what applied (or why discarded).

The autonomy wiring is deliberately not built in: no timer, no idle trigger, no load-time run. The author runs when the model calls `refinery_run` — which a user turn, a preset, or the schedule plugin can drive. Background self-improvement becomes a composition decision (wire the trigger you trust), not a package behavior.

Applying a proposal splits by what changed: data-plane facts (library files, ledger records) hot-load everywhere through their snapshots and watchers, but a running process cannot hot-load its own source or configuration. `refinery_settle` therefore returns `restartRecommended` — true by default for an `applied` settlement, overridable to `false` for pure data or documentation edits — and the tool contract requires the model to relay a true value to the user. That is the restart prompt: precise, at the only point where it is knowable.

## Alternatives considered

- **A built-in timer/idle trigger inside the plugin** — the [schedule package's](../../../../packages/schedule/schedule/README.md) AGENTS.md rules show how heavy correct background triggering is: live-owner claims, durability barriers, teardown quiescence. Baking that into the refinery would couple storage, authoring, and scheduling into one package and force every deployment to accept the trigger policy. The subagent-based author keeps the plugin synchronous, testable, and trigger-free.
- **The background agent applying its own proposals** — rejected on the approved autonomy level: an unattended agent modifying the project has no review gate, and a bad proposal becomes a bad commit. The settle event is the explicit human-side review record; `applied` requires a note naming what landed.
- **`goal-round-driver` same-session rounds as the author loop** — the goal driver continues *one* agent's session toward an objective; proposal authorship is a bounded one-shot delegation with a schema-checked result, which is exactly the subagent one-shot seam (`ctx.subagents.start` with `outputSchema`). Reusing the seam inherits cancellation, depth limits, and disposal for free.
- **Ralph-style fresh-agent iteration** — a fixed multi-round workflow pays for iteration the single-proposal task does not need; the ledger can accumulate many problems, but each `refinery_run` deliberately produces one focused proposal.

## Consequences

- The loop is closed and safe: problems accumulate in the ledger, `refinery_run` converts them into durable proposals, and `refinery_settle` records the human verdict. Nothing in the chain modifies the project unattended.
- Applied proposals that touched source or configuration surface an explicit restart recommendation instead of silently pretending to be live; the model (or the composing deployment) decides the restart moment, and data-only applications carry no false restart demand.
- The author child's safety is structural (tool scope + output schema), so it holds even if the child model is creative about its instructions; the persona restates the contract for the model's benefit, not as the enforcement layer.
- One `refinery_run` costs one child session; there is no batching, no deduplication against existing proposals, and no cross-proposal conflict detection — real usage decides whether those become worth building.
- The proposal stream cites the commissioning session id, so the durable record can answer "which session asked for this analysis" without replaying the child.
- Deployments wanting unattended operation compose this with their own trigger (schedule, goal driver, cron); the package itself stays inert until called.
