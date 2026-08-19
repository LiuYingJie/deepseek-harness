# memory/ — 项目级持久问题台账

[English](README.md) | 中文

锚定项目根的跨会话改进记忆：未解决问题、长期决策与经验教训以单条追加式 JSONL 流持久化于 `.dsh/memory/ledger.jsonl`，并注入同项目的后续会话。台账是自我强化循环消费的持久输入——由 agent（`memory_record`）、turn 失败捕获或人类写入，由后续每个会话通过步骤注入消费。

| 包 | 角色 | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | 台账 Service Definition + JSONL fold | `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | 模型侧工具 + 会话注入 + turn 失败捕获 | — |
