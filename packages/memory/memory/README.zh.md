# @deepseek-ai/dsh-memory

[English](README.md) | 中文

项目级持久问题台账。每个项目根一条追加式 JSONL 流——最近的 `.git` 祖先下的 `.dsh/memory/ledger.jsonl`——每次读取时 fold 出 active 记录集。台账是跨会话的改进记忆：未解决的问题、长期决策与经验教训，作为后续会话的常驻上下文被消费。

## 组合

```yaml
- id: memory
  name: '@deepseek-ai/dsh-memory'
  config:
    path: './.dsh/memory/ledger.jsonl'   # optional; defaults to the project root anchor
```

省略 `path` 时默认为 `<最近的 .git 祖先>/.dsh/memory/ledger.jsonl`。

## 服务 API

`ctx.memory`（类 `MemoryService`，默认导出）：

- `snapshot(): Promise<MemoryLedgerState>` —— active（未解决）记录按 fold 顺序返回，附事件总数。每次读取都重新校验持久 JSON 边界：损坏行以 `MemoryLedgerError`（`CORRUPT_LEDGER`）失败，绝不静默给出错误 fold。
- `add(input): Promise<MemoryRecord>` —— 追加一条 `open` 事件；`id`（`mem-<8 hex>`）与 `createdAt` 在此铸造。
- `resolve(input): Promise<MemoryRecord | undefined>` —— 追加一条 `resolve` 事件；返回带注释的记录，id 未知或已解决时返回 `undefined`（不追加任何内容）。

写入通过跨进程文件锁（`dsh-atomic-write`）串行化，并在每次追加前于锁内刷新 fold，并发写者观察到同一串行顺序。台账文件在会话日志之外；不拥有任何会话事件流。

## 记录种类与来源

`kind`：`problem`（待处理的未解决问题）、`decision`（长期决策）、`lesson`（持久经验）。`origin`：`agent`（模型调用）、`auto`（turn 失败捕获）、`human`（外部编辑或未来的人类界面）。

## 扩展点

模型侧注入请组合 `dsh-tool-memory`；台账接缝本身不携带任何模型可见内容。

## Model Experience

### Request context and condition

#### What the model sees

None。本包定义台账接缝；模型侧注入属于 `dsh-tool-memory`。

#### Token effect

None——本包不构建任何模型请求。

#### KV Cache effect

None——本包不构建任何模型请求。

## Known Limitations and Deferred Work

- **每项目单一台账文件** —— 所有并发进程经文件锁共用一条流；按主题或项目域分片推迟到真实工作负载需要时再做。
- **外部编辑不热重载** —— fold 在写入后的下一次 `snapshot()` 刷新；会话间的人工编辑在下一次加载时拾取，活跃会话不因外部变更重读。
