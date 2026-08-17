# @deepseek-ai/dsh-exploration-hygiene

[English](README.md) | 中文

这是一个循环卫生插件，而非面向模型的工具：它不会出现在工具列表中，也不会否决或改写调用。它只增加两种同属「无效探索」的行为。

1. 一段提示词，说明 coding agent（智能体）应如何工作：走最简单路径、先定向再动手、优先使用专门或 MCP 工具，并在环境受阻时提问，而不是反向工程。
2. 当某个 agent 连续发起不算任务进展的工具调用时（默认不是 `write` / `edit` / `str_replace_editor` / `ask_user_question` / `run_code` / `mcp__*`），注入建议性提醒。是否动手、提问或改换路径，仍由模型决定。

决策记录见 [exploration-hygiene Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-exploration-hygiene.md)。

## 配置

```yaml
- id: exploration-hygiene
  name: '@deepseek-ai/dsh-exploration-hygiene'
  config:
    section: |                          # default: the shipped operating contract; empty disables the section
      Complete the user's task by the simplest path that works.
    thresholds: [8, 14, 22]             # default; consecutive non-progress counts that trigger a reminder
    progress: [write, edit, str_replace_editor, ask_user_question, run_code, mcp__*]
    exclude: [todo_write]               # default; transparent to the stall chain
```

插件加载时，`thresholds` 会对错误配置快速失败：非整数、小于 2 的值或重复值都会抛出错误。空列表关闭停滞提醒并保留提示词段落。`progress` 同样拒绝空列表，避免每个被跟踪的调用都默默算作探查。条目支持 `*` 通配符，是调用时对工具名的谓词。

## 停滞链语义

匹配 `progress` 的被跟踪调用会重置该 agent 的连续计数；其他被跟踪调用则加一。未跟踪（`exclude`）的调用对链透明：既不加一也不重置，因此 `read → todo_write → grep` 仍计为两次连续探查。被拒绝的调用会计数。没有 agent 的调用会被忽略。用户提示（`agent/pre-step`）会重置提交方 agent 的链。链以存活的 `Agent` 对象为键。

提醒作为 `tools/post-execute` 的 `additionalContexts` 传递，来源为 `{kind: 'plugin', plugin: 'exploration-hygiene'}`，从不替换 `content`。第一个阈值只发送简短提醒；后续每个阈值都会给出最后一次工具名和连续次数。

当计数超过所配置的最高阈值后，链不会保持沉默：每隔 `thresholds[0]` 次会再触发一次更强提醒（默认值 `[8, 14, 22]` 时会再在 30、38、46… 触发）。每次触发都会升级建议的下一动作，避免模型反复收到相同提示。

## Model Experience

### 系统提示词

#### 模型看到什么

只要本插件仍加载且 `section` 非空，每次组装都会在部署 persona 之后包含下面的操作契约段落。当至少有一个可见工具名为 `mcp__<server>__*` 时，该段落会追加当前服务器列表。

##### 操作契约段落

```markdown
Complete the user's task by the simplest path that works.

Orient with a few targeted searches, then act. Do not exhaustively read a project before changing it. Prefer copying and adapting existing files over reverse-engineering engine internals, undocumented encodings, or installation layouts.

When specialized tools are listed — including MCP tools named mcp__* — use them instead of reconstructing that domain with read, grep, glob, or shell.

If a missing editor, UUID scheme, or external program blocks progress, ask the user with ask_user_question rather than searching the machine. If the current approach is not converging, change approach or ask; do not gather more of the same kind of evidence.
```

##### MCP 附录

```markdown
Specialized MCP servers in this session: <sorted-server-names>. Prefer those mcp__<server>__* tools for their domains.
```

#### Token 影响

契约文本是固定的每次请求成本。MCP 附录随数据变化，在没有 MCP 工具可见时省略。

#### KV Cache 影响

在段落文本（含 MCP 附录）渲染结果不变时前缀稳定。注册或移除 MCP 服务器可能从此段落起使复用失效。

### 第一阈值上下文消息

#### 模型看到什么

达到所配置的第一个连续探查阈值时，该 agent 会收到下面的提醒。

##### 第一阈值提醒

```markdown
You have made several inspection calls without writing, editing, or asking the user. Stop gathering the same kind of evidence. Take the simplest action with what you already know, ask the user the blocking question, or change approach.
```

#### Token 影响

阈值之前为零。提醒会作为该 agent 的保留历史。

#### KV Cache 影响

只追加；新可见内容跟在可复用请求前缀之后，不会使已有 KV-cache 条目失效。

### 后续阈值上下文消息

#### 模型看到什么

后续阈值使用下面的详细提醒模板。

##### 后续阈值提醒

```markdown
Inspection stall detected:
- last_tool: <toolName>
- consecutive_inspection_calls: <count>
The recent calls are not making task progress. Do not continue exploring. Write or edit, ask the user, use a specialized tool if one fits, or conclude with the simplest viable approach.
```

#### Token 影响

每条提醒都是保留历史。各 agent 有独立计数器。

#### KV Cache 影响

只追加；新可见内容跟在可复用请求前缀之后，不会使已有 KV-cache 条目失效。

### 超过最高阈值后的上下文消息

#### 模型看到什么

当计数继续增长、超过所配置的最高阈值后，每隔 `thresholds[0]` 次会再触发一次更强提醒，链不会保持沉默。严重度按 `floor((count - highest) / thresholds[0])` 升级。

##### 超过最高阈值提醒

```markdown
Inspection chain past the highest configured threshold:
- last_tool: <toolName>
- consecutive_inspection_calls: <count>
- reminders_ignored: <count - highest>
You are now in a loop. <escalating next-action sentence>
```

##### 动作严重度

```markdown
Pick the simplest viable action and write it now. Stop exploring.
Stop exploring. Either write a working draft, ask the user the blocking question, or conclude with the current best guess.
Hard stop. Do not make another inspection call. Ask the user or write a minimal working answer.
You have ignored earlier reminders. Conclude this turn with text only: state the blocker, ask one question, or hand back the simplest answer you have.
```

#### Token 影响

每条链式提醒都是保留历史。

#### KV Cache 影响

只追加；新可见内容跟在可复用请求前缀之后，不会使已有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **进展是名字模式允许列表** — 会改文件的 shell 命令仍计为探查，除非 `progress` 包含 `bash`/`pwsh`。默认的 `mcp__*` 把每个 MCP 工具都视为进展。
- **仅建议** — 尚未在高阈值升级为 `block`，尽管 `PostToolDecision` 已支持阻止。
- **合理的大型代码库定向仍会在超过阈值后收到提醒** — 压力阀是 `thresholds`/`progress`/`exclude` 配置。
