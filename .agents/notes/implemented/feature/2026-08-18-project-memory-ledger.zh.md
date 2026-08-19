# Agent Note: 项目记忆台账 —— 持久化的自我强化输入

Status: implemented

[English](2026-08-18-project-memory-ledger.md) | 中文

## Problem

会话结束后，其中的失败也随之消失。不稳定的构建、在不确定下做出的决策、不能重复的绕行方案——这些都只存在于那次会话的日志里，因此下一次会话（或同一项目的后续优化）从零开始。仓库里没有任何一个接缝能让"未解决的东西"按项目持久化并重新进入模型上下文。用户还希望失败本身就能被收集，而不依赖模型记得去写。

## Decision

一对能力包，遵循 [capability-seam 规则](../../../../docs/glossary.md)：

- **`dsh-memory`**（`ctx.memory`）为每个项目根持有一个只追加的 JSONL 台账（`<root>/.dsh/memory/ledger.jsonl`，锚定在最近的 `.git` 祖先）。折叠只保留活跃（未解决）记录；`resolve` 事件把目标从活跃集合移除，注记附在返回的记录上，从不在活跃列表里。写入通过跨进程 `withFileLock` 串行化，且每次追加前在锁内重新读取进程内折叠，并发写者永远不会折叠过期的前缀。每次 `snapshot()` 都重新读取并重新折叠整个流：台账是跨会话、可被外部编辑的文件，缓存的折叠会隐藏外部编辑和损坏。畸形行以 `CORRUPT_LEDGER` 大声失败。
- **`dsh-tool-memory`** 在既有扩展点上发布模型可见面：三个 `defineTool` 工具（`memory_record`、`memory_list`、`memory_resolve`），一个 `agent/pre-step` 瀑布监听器把活跃台账作为携带 `memory-ledger` `MessageSourceMap` 条目的 `user` 角色消息注入，以及——当 `autoCaptureFailures`（默认 true）时——一个 `session/event` 监听器为每个失败的 `turn/end` 追加一条 `auto` 来源的 problem 记录。注入按持久化条目列表（而非渲染文本）的摘要去重，因此重放和压缩看到稳定身份；工具可见性门控与 skill catalog 一致，受限的工具视图同样移除台账指引。

台账刻意保持"笨"：它存记录，不存行为。阶段②（持久化工具库）和阶段③（只产出提案的后台改进 agent）都消费同一个台账作为输入流，这就是该服务是纯能力接缝而非仅模型可见插件的原因。

## Alternatives considered

- **会话日志挖掘而非专用台账** —— 日志存在且持久，但从完整转录里提取"未解决的问题"需要在读取时解释，每个会话都付这个成本，且提取器是第二个投影，模型没有写路径去纠正它。带显式工具的一等台账让读写都便宜且可检查。
- **SQLite（session-store 先例）而非 JSONL** —— 此接缝拒绝：单文件、人可编辑、代码评审中 diff 友好，跨进程锁已存在于 `dsh-atomic-write`。事件源形态（`open`/`resolve` 事件折叠为活跃状态）让磁盘格式可被未来的写者（阶段③的后台 agent）平凡地追加。
- **仅自动捕获（无 `memory_record`）** —— 失败只占值得记录内容的一小部分；决策和教训是模型判断。两种来源写同一个台账，用 `origin` 字段区分，后续读者可以不同地衡量它们。

## Consequences

- 项目上的每个新会话醒来时，未解决问题列表已在上下文中（由 `maxInjectEntries` 约束，默认 32；detail 截断于 `maxDetailChars`，默认 240）——每步约一条短 system-reminder 的常驻成本，记录被解决后返还。
- 注入消息是 `user` 角色并带专用 source kind，因此 Model-visible ⟺ logged 无需新事件类型成立：`user/message` 日志、重放和转录行全部免费获得。
- 空台账在首次发布时不注入任何内容（无噪音），但会话内的 `memory_record` 触发标记 `update: true` 的替换台账消息，模型立即看到自己的写入。
- 自动捕获是 fire-and-forget：捕获失败记录一条警告，从不让会话失败。病态的失败循环模型可能让台账增长；`maxInjectEntries` 约束上下文成本，台账是普通人可以修剪的纯文件。
- 对未知 id 的 `resolve` 不追加任何内容并返回 `undefined`——折叠保持干净，没有墓碑事件。
