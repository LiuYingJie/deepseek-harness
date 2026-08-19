# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

模型侧台账工具、active 台账的步骤注入与 turn 失败捕获。台账是持久的改进记忆：持续存在的问题、已作出的决策、保留的经验——由模型写入或自动捕获，注入同项目的后续每个会话。

## 组合

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

## 工具

| 工具 | 契约 |
|---|---|
| `memory_record` | 追加一条记录（`kind`：problem/decision/lesson，`title`，可选 `detail`）。跨会话存活；后续注入。 |
| `memory_list` | fold 后台账的 active 记录。 |
| `memory_resolve` | 以说明修复内容的注释标记一条记录已解决；未知或已解决的 id 返回 `resolved: false`。 |

## 注入

会话首个 `agent/pre-step` 将 active 台账发布为一条 `<system-reminder>` 框架的 `<memory_ledger>` 用户消息（source 为 `memory-ledger`，`catalog` 形上下文，精确记录发布的条目）。后续步骤仅在持久条目列表变化时重发布——对 `[id, kind, title, origin]` 计算 digest，绝非渲染文本——并替换早前发布。发布以 `memory_record` 工具注册对该 agent 可见为前提，与技能目录一致：受限工具视图同时移除台账指引。从未发布过的空台账不注入。

## Turn 失败捕获

`autoCaptureFailures` 开启时，`reason.kind === 'error'` 的 `turn/end` 追加一条 `auto` 来源的 problem 记录（`Turn <n> failed: <前 160 字符>`，`detail` 含 code）。捕获为 fire-and-forget：台账写入失败仅记录警告，绝不使会话失败。

## Model Experience

### Request context and condition

#### What the model sees

每会话一条保留的 user 角色 `<system-reminder>` 块（active 集变化时附一条替换），以 `- [mem-xxxx] (kind/origin) 标题` 列出 active 记录与截断的 detail，后接常驻指引。

#### Token effect

有上限：至多 `maxInjectEntries` 行加每条 `maxDetailChars` 的 detail；台账为空且从未发布时为零。

#### KV Cache effect

会话内 active 集不变时 append-only：发布块位于保留前缀，每步复用。台账变化会替换早前发布（追加新消息；从 decision messages 移除旧消息），从此点起失效复用。

## Known Limitations and Deferred Work

- **无跨项目可见性** —— 台账锚定单个项目根；用户级或多项目汇总推迟。
- **自动捕获仅按 resolve 去重** —— 重复的相同 turn 失败各追加一条记录；按错误 code 折叠重复推迟到真实使用呈现噪声画像后。
