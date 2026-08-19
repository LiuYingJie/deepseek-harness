# memory/ — project-level durable issue ledger

English | [中文](README.zh.md)

Cross-session improvement memory anchored to the project root: unresolved problems, standing decisions, and lessons persist as one append-only JSONL stream under `.dsh/memory/ledger.jsonl` and are injected into later sessions on the same project. The ledger is the durable input a self-improvement loop consumes — it is written by the agent (`memory_record`), by turn-failure capture, or by humans, and consumed by every later session through the step injection.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Ledger Service Definition + JSONL fold | `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | Model-facing tools + session injection + turn-failure capture | — |
