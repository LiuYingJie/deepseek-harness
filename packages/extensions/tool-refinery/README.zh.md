# @deepseek-ai/dsh-tool-refinery

[English](README.md) | 中文

模型可见的 refinery 工具与后台提案编写者。`refinery_run` 从项目记忆台账读取未解决问题，经 subagent seam 派生一个只读分析子 agent，并把其结构化结果持久为一条改进提案。`refinery_list` 与 `refinery_settle` 读取并结算活跃提案集。一次 refinery 运行绝不修改项目：编写子 agent 的工具被限定为只读白名单，且每条提案都等待显式的人工侧结算。

## 组合

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

需要一个具备 `outputSchema`、`toolFilter` 与 `persona` 能力的已注册 subagent 提供方；缺失时 `refinery_run` 会大声失败并指名缺失的提供方。

## 工具

| 工具 | 契约 |
|---|---|
| `refinery_run` | 运行一个后台提案编写者。从记忆台账读取活跃 `problem` 记录，派生限定作用域的分析者，并持久一条结构化提案（标题、正文、所针对的记录）。可选 `focus` 把编写者引向某个领域。 |
| `refinery_list` | 活跃提案及其 id、标题和所针对的台账记录。 |
| `refinery_settle` | 结算一条提案：`applied`（说明落地了什么）或 `discarded`（为何不）。未知 id 返回 `settled: false`。`applied` 结算返回 `restartRecommended`——默认为 true，因为源码/配置变更无法热加载；纯数据或文档编辑时模型传入 `restartRecommended: false`，为 true 时必须转达给用户。 |

## 编写者语义

编写子 agent 收到渲染进提示词的台账问题、禁止修改的分析者 persona 和工具白名单——其余工具从其提示词移除并拒绝执行（单一可见性）。结构化输出必须满足提案 schema；没有有效捕获的运行会让工具调用失败，而不是持久一条残缺提案。持久化的提案记录调用会话，因此这条流可以指明是哪个会话委托了该分析。

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
