# Agent Note: Exploration hygiene for coding agents

Status: implemented

[English](2026-08-17-exploration-hygiene.md) | 中文

## Problem

随产品交付的 coding agent persona 只有一句身份说明（`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`）。各工具提示词段落说明如何调用 `read` 或 `glob`，而不说明何时停止阅读。唯一的循环卫生消费方 [`dsh-repeat-tool-reminder`](../../../../packages/guard/repeat-tool-reminder/README.md) 只统计连续的*完全相同*调用；模型若读取文件 A、再 grep 模式 B、再反向工程引擎 UUID，永远不会触发它。

这正是产品实际表现出来的失败：一次把现有 UI prefab 移植过来的请求，把整轮花在重构 Cocos Creator 内部机制、并在主机上搜索编辑器安装上，既没有计划也没有编辑，只能被中止。这一类问题是无效探索——穷尽式探查、忽略专门工具、对受阻的环境细节做反向工程——而不是某一个 Cocos 任务。

[同会话 goal 驱动器](2026-07-16-harness-level-loop.md) 已经记录：自动无进展启发式和卡住模式检测推迟到那里。那些属于 goal round。本决策覆盖普通编码回合，中止就发生在那里。

## Decision

一个 guard 插件 `@deepseek-ai/dsh-exploration-hygiene`（位于 `packages/guard/exploration-hygiene/`）拥有同一关注点的两层：

1. **操作契约提示词段落** `harness:coding-guidance`，顺序为 10（在 persona 之后、各工具指导之前）。它要求模型走最简单路径、先定向再动手、优先使用专门和 MCP 工具，并在环境受阻时提问而不是反向工程。当可见工具包含 `mcp__<server>__*` 时，同一段落追加当前服务器列表。空的 `section` 配置关闭该贡献。
2. **探查停滞提醒**，挂在 `tools/post-execute` 上，投递路径与 repeat-tool-reminder 相同（`additionalContexts`、插件来源的 `user/message`、第一阈值简短、后续阈值详细）。连续的、不属于 `progress` 的被跟踪调用会增加每个 agent 的计数器；匹配 `progress` 或用户提示会重置它。默认 `progress` 为 `write`、`edit`、`str_replace_editor`、`ask_user_question`、`run_code`、`mcp__*`。默认 `exclude` 为 `todo_write`。默认 `thresholds` 为 `[8, 14, 22]`。空的 `thresholds` 关闭提醒。当计数继续增长、超过所配置的最高阈值后，每隔 `thresholds[0]` 次会再触发一次更强的「链式」提醒（默认 `[8, 14, 22]` 时会在 30、38、46… 触发），建议的下一动作按四个严重度递增——这样卡住的循环不会保持沉默。

该插件挂在 [`dsh-base`](../../../../packages/bundle/base/cordis.patch.yml) 中，因此每个叠加共享核心的 profile 都会收到它，并挂在 ACP 示例组合中以使该表面一致。`minimal` preset 的 `complete: true` persona 仍会抑制该段落。具体的 `dsh-agent-loop` 不变。

MCP 偏好由这里拥有，而不是 `dsh-mcp-client`，因为习惯是「专门工具存在时优先使用它们」，而当前服务器列表是 `ctx.tools.schemas()` 的投影。连接用户的编辑器 MCP 服务器仍是组合：在 profile 或 home patch 中为每个服务器放一行 `dsh-mcp-client`。本决策不自动导入 Cursor 的 MCP 配置。

## Alternatives considered

- **只在各 preset 和模式组合包里扩展 YAML persona** — 操作契约会变成三份复制字符串，只要一个表面改了就会漂移。[提示词所有权决策](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) 已经把角色与行为散文交给单一所有者；插件段落就是该所有者。
- **Cocos 专用 skill 或只针对 MCP 的提示词** — 只处理一个领域。这次中止与任何「移植这个 / 接上那个 / 编辑器 API 已存在」的任务是同一模式。
- **给 `dsh-agent-loop` 加步数预算** — 违反已文档化的扩展点规则，硬上限还会切断合理的大型代码库定向。建议性提醒复用 repeat-tool-reminder 路径。
- **把停滞检测放到 goal reflector 上** — [harness 级循环决策](2026-07-16-harness-level-loop.md) 中推迟的 reflector 评估的是 goal round，不是普通第一回合。这次中止从未创建 goal。
- **只统计 `read`/`grep`/`glob`** — 一次经由 `pwsh` 的主机搜索会重置链，而这正是 UUID/安装的兔子洞。把非进展定义为显式 `progress` 列表的补集，才能抓住混合探查。
- **自动把 Cursor 的 MCP 服务器导入 dsh** — 那是另一块产品表面（设置、信任、进程寿命），harness 组合里目前没有消费方。用户添加 `dsh-mcp-client` 行；操作契约在这些服务器存活时点名它们。

## Consequences

- 默认的 web、headless 和 ACP coding agent 在每次请求中都会收到一段短操作契约，并在连续八次非进展调用后收到停滞提醒。
- Token 成本是契约加上可选的 MCP 附录；停滞提醒在达到阈值后作为只追加的历史。
- 除非部署把 `bash`/`pwsh` 加入 `progress`，shell 变更仍计为探查。这是为抓住主机搜索兔子洞而做的取舍；主要靠 shell 实现的部署覆盖 `progress`。
- Repeat-tool-reminder 仍是完全相同调用的检测器。两个 guard 可能在一长串完全相同的 read 上同时触发；接受这一重叠。

## Testing

包测试通过真实 agent loop 对脚本化 mock adapter 驱动：默认与空段落、存活 MCP 附录、fiber 处置段落、连续混合探查、进展重置、exclude 透明、按 agent 分键、用户提示重置、无 agent 的 execute、错误配置快速失败、空阈值关闭、最高阈值之后的链式提醒、严重度递增，以及 Loader `unwrapExports`。把插件挂入 `dsh-base` 和 ACP 示例，使该段落出现在这些表面的已组装系统提示词快照中。
