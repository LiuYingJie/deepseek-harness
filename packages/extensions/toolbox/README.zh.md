# @deepseek-ai/dsh-toolbox

[English](README.md) | 中文

项目级持久化工具库。每个项目根目录一条只追加的 JSONL 流 —— 位于最近 `.git` 祖先下的 `.dsh/toolbox/toolbox.jsonl` —— 每次读取时折叠为活跃工具集。每个工具版本携带一段模型编写的程序（经 code-runtime seam 执行的 async 函数体）及其模型可见 schema。后续会话无需重新编写即可将活跃版本重新挂载为真实工具。

## 组合

```yaml
- id: toolbox
  name: '@deepseek-ai/dsh-toolbox'
  config:
    path: './.dsh/toolbox/toolbox.jsonl'   # optional; defaults to the project root anchor
```

省略 `path` 时默认为 `<最近 .git 祖先>/.dsh/toolbox/toolbox.jsonl`。

## Service API

`ctx.toolbox`（类 `ToolboxService`，默认导出）：

- `snapshot(): Promise<ToolboxState>` —— 每个工具名的活跃版本加总事件数。每次读取都重新校验持久 JSON 边界：格式错误的行以 `ToolboxError`（`CORRUPT_LIBRARY`）失败，绝不产生静默错误的折叠。
- `publish(input): Promise<ToolboxRecord>` —— 追加一条 `publish` 事件，替换同名工具的活跃版本；`id`（`tool-<8 位十六进制>`）与 `createdAt` 在此生成。
- `retire(name): Promise<boolean>` —— 追加一条 `retire` 事件移除该名称的活跃版本；返回是否移除（无活跃版本的名称不追加任何内容）。

写入通过跨进程文件锁（`dsh-atomic-write`）串行化，并在每次追加前于锁内从磁盘刷新折叠，因此并发写入者观察到同一个串行化顺序。库文件位于会话日志之外；它不拥有会话事件流。

## 工具名与版本

工具名匹配 `^[a-z][a-z0-9_]{2,63}$`。对已存在名称的 `publish` 会取代其活跃版本（取代关系记录在历史中）；流保留每个事件，折叠只暴露活跃集。`origin`：`agent`（模型调用）或 `human`（外部编辑或未来的人工界面）。

## 扩展点

组合 `dsh-tool-toolbox` 获得模型可见表面与实时挂载；本库 seam 本身不携带任何模型可见内容。

## Model Experience

### Request context and condition

#### What the model sees

无。本包定义库 seam；模型可见工具属于 `dsh-tool-toolbox`。

#### Token effect

无 —— 本包不构建任何模型请求。

#### KV Cache effect

无 —— 本包不构建任何模型请求。

## Known Limitations and Deferred Work

- **每项目单一库文件** —— 一条流通过文件锁服务所有并发进程；按目录划分作用域推迟到真实工作负载需要时再做。
- **无历史列表 API** —— 折叠只暴露活跃集；对被取代版本的历史查询推迟到出现消费者时再做。
