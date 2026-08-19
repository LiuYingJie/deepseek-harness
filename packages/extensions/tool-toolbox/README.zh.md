# @deepseek-ai/dsh-tool-toolbox

[English](README.md) | 中文

模型可见的 toolbox 工具与持久化工具挂载。模型通过 `toolbox_publish` / `toolbox_retire` / `toolbox_list` 发布和退役工具版本；持久库中的每个活跃版本都挂载为真实工具，其 `execute` 经 code-runtime seam 运行存储的程序。库是持久化的，因此挂载的工具在重启后依然可用；对同一名称的发布会热替换其挂载为新程序。

## 组合

```yaml
- id: toolbox
  name: '@deepseek-ai/dsh-toolbox'

- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'

- id: tool-toolbox
  name: '@deepseek-ai/dsh-tool-toolbox'
  config:
    mountOnLoad: true   # mount the active library set when the plugin loads
    watchLibrary: true  # hot-sync the mount on library edits from other processes
    watchStabilityMs: 500
```

调用时需要一个 code-runtime 后端；缺失时调用挂载工具会大声失败并指名缺失的后端。

## 工具

| 工具 | 契约 |
|---|---|
| `toolbox_publish` | 发布一个工具版本（名称、描述、参数映射、程序）。程序是 async 函数体；校验后的调用参数以 `args` 传入，完成时 `return` 的值必须是无损 JSON。发布已存在的名称会替换其活跃版本。 |
| `toolbox_retire` | 移除一个名称的活跃版本；它不再可被调用并解除挂载。未知名称返回 `retired: false`。 |
| `toolbox_list` | 活跃工具及其版本 id、描述和来源。 |

参数类型映射到工具 schema DSL：`string`、`number`、`integer`、`boolean`（可带 `enum`），以及 `array`、`object`、`json`。发布不可映射的类型会在持久化之前被拒绝。

## 挂载语义

加载时插件折叠库并为每个活跃版本注册一个真实工具；初始挂载在插件完成加载前落定，因此损坏的库会在加载时大声失败。后续的发布或退役会重新同步挂载集；其他会话或外部编辑器的库文件变更在写入稳定后（`watchLibrary`，默认开启，经 `watchStabilityMs` 默认 500 毫秒去抖）通过文件监视热同步——库是跨进程 JSONL 流，看到其他会话的工具无需重启。所有同步经一条串行队列执行，watcher 触发与工具触发的同步不会竞态出重复注册。每个挂载的工具在调用时解析该名称当前的活跃版本，因此挂载之后发布的程序无需重新挂载即可运行；在活跃挂载下被退役的名称在下次调用时报出陈旧挂载错误。无法映射到注册 DSL 的存储 schema（手工编辑的库）会被跳过并告警，而不是阻塞其余挂载。

运行中的进程无法热加载自己的源码：harness 或插件代码变更需要重启。

程序经 worker-thread code runtime 运行，受其计算/墙钟预算与中止处理约束；失败的运行以携带失败类别、消息和捕获输出的工具错误呈现。

## Model Experience

### Request context and condition

#### What the model sees

始终有三个管理工具——`toolbox_publish`、`toolbox_retire`、`toolbox_list`；每个活跃库工具作为普通工具以其存储的描述和参数呈现。挂载描述携带版本 id，模型可以引用它使用的确切版本。

#### Token effect

三个管理工具 schema 加每个活跃库工具的一个 schema 进入每个列出工具的请求。程序及其输出受 code runtime 的输出上限约束，不受本包约束。

#### KV Cache effect

库不变时稳定：工具 schema 位于请求前缀。发布或退役——本地或从其他进程感知——从下一个请求起改变工具列表，使该点之后的复用失效。

## Known Limitations and Deferred Work

- **程序不接收宿主绑定** —— 挂载工具的程序只带 `args` 独立运行；将选定的宿主函数桥接进库工具推迟到具体工具需要时再做。
- **无按工具的预算覆盖** —— 每个程序都在共享的 code-runtime 预算下运行；按工具调优推迟到真实使用显示需要时再做。
