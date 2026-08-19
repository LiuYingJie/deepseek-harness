# Agent Note: Background refinement — a proposal-only self-improvement loop

Status: implemented

[English](2026-08-18-background-refinery-proposal-stream.md) | 中文

## Problem

自我强化栈已有两个持久输入，却没有闭合回路的消费方：[记忆台账](2026-08-18-project-memory-ledger.md)积累未解决问题（模型记录与自动捕获的 turn 失败），[持久工具库](2026-08-18-persistent-project-toolbox.md)保存模型编写的工具——但没有东西把积累的问题转化为改进工作。缺失的一环是后台"精炼"工作区：一个接收这些 AI 反馈、自行改进项目的后台 agent。为它选定的约束是：**仅提案** ——后台 agent 可以分析与提议，绝不修改，因为无人值守的代码库自我修改是最不安全的自治级别，也最容易后悔。

## Decision

一对能力包，沿用栈内其余部分的同一存储惯用法：

- **`dsh-refinery`**（`ctx.refinery`）拥有每个项目根一条追加式 JSONL 流（`<root>/.dsh/refinery/proposals.jsonl`）。每条 `propose` 事件携带完整提案——标题、正文及所针对的台账记录 id；一条 `settle` 事件（`applied`/`discarded`）把它从活跃集移除。折叠、锁纪律、损坏失败与快照语义与 `dsh-memory`、`dsh-toolbox` 刻意一致：整个自我强化栈一个存储惯用法。
- **`dsh-tool-refinery`** 发布模型可见表面与后台编写者：`refinery_run` 从 `ctx.memory` 读取活跃 `problem` 记录，渲染进一份编写者提示词，并经 `ctx.subagents` 启动一个 subagent，带三个限定决策：
  - **以 `toolFilter` 强制只读** ——编写子 agent 只保留只读工具白名单；其余工具从其提示词移除*并且*拒绝执行（进程内提供方的单一可见性限制）。安全性是派生作用域的属性，不是提示词里的建议。
  - **结构化输出** ——子 agent 必须返回提案 schema（`title`、`body`、`addresses`）；没有有效捕获的运行会让工具调用失败，而不是持久一条残缺提案。
  - **分析者 persona** ——仅作用于该子 agent 的限定 persona，遮蔽部署 persona，在其自身的指令中声明永不修改的约定。

  `refinery_list` 与 `refinery_settle` 读取并结算这条流；结算是人工侧的门，记录落地了什么（或为何丢弃）。

自治接线刻意不做内置：没有定时器、没有空闲触发、没有加载即跑。编写者在模型调用 `refinery_run` 时运行——用户 turn、preset 或 schedule 插件都可以驱动它。后台自我强化成为组合决策（接上你信任的触发器），而不是包行为。

应用提案按变更内容分流：数据面事实（库文件、台账记录）经快照与 watcher 到处热加载，但运行中的进程无法热加载自己的源码或配置。因此 `refinery_settle` 返回 `restartRecommended`——`applied` 结算默认为 true，纯数据或文档编辑可显式传 `false`——工具契约要求模型把 true 转达给用户。这就是重启提示的位置：精确，且落在唯一可知的点上。

## Alternatives considered

- **插件内置定时器/空闲触发** ——[schedule 包](../../../../packages/schedule/schedule/README.md)的 AGENTS.md 规则说明正确的后台触发有多重：live-owner 认领、持久化屏障、拆卸静默。把它烤进 refinery 会把存储、编写与调度耦合进一个包，并强迫每个部署接受该触发策略。基于 subagent 的编写者让插件保持同步、可测、无触发。
- **后台 agent 自行应用提案** ——按已批准的自治级别拒绝：无人值守的 agent 修改项目没有审查门，坏提案会变成坏提交。settle 事件是显式的人工侧审查记录；`applied` 需要一条说明落地内容的注记。
- **用 `goal-round-driver` 的同会话 Round 作为编写回路** ——goal 驱动器让*一个* agent 的会话朝目标继续；提案编写是带 schema 校验结果的有界一次性委派，正是 subagent 一次性 seam（带 `outputSchema` 的 `ctx.subagents.start`）。复用 seam 免费继承取消、深度限制与销毁。
- **Ralph 式新 agent 迭代** ——固定的多 Round 工作流为迭代付费，而单提案任务不需要；台账可以积累很多问题，但每次 `refinery_run` 刻意产出一份聚焦提案。

## Consequences

- 回路闭合且安全：问题在台账积累，`refinery_run` 把它们转化为持久提案，`refinery_settle` 记录人工裁决。链条中没有任何环节会无人值守地修改项目。
- 触及源码或配置的已应用提案显式给出重启建议，而不是静默假装已生效；模型（或组合它的部署）决定重启时机，纯数据应用不会带来错误的重启要求。
- 编写子 agent 的安全性是结构性的（工具作用域 + 输出 schema），即使子模型对指令很有"创造力"也依然成立；persona 为模型的利益重述约定，而不是作为执行层。
- 一次 `refinery_run` 花费一个子会话；没有批处理、没有对既有提案的去重、没有跨提案冲突检测——真实使用决定这些是否值得构建。
- 提案流引用委托会话 id，因此持久记录无需回放子会话即可回答"哪个会话委托了这份分析"。
- 想要无人值守运行的部署，用自己信任的触发器（schedule、goal 驱动器、cron）与本包组合；包本身在被调用前保持惰性。
