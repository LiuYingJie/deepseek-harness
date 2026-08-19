# Agent Note: 持久化项目工具箱 —— 自撰工具的持久库

Status: implemented

[English](2026-08-18-persistent-project-toolbox.md) | 中文

## Problem

agent 可以在会话中发明更好的工作流，却无法保留编码该工作流的工具。`ctx.dynamicCordisRunner` 能运行模型编写的插件并具备完整的生命周期语义，但只保留在内存中——重启即丢失所有动态工具。Skill 持久化在磁盘上，但描述的是模型要遵循的流程，而不是可执行的工具。缺口在于：一个按项目存续、重启可用、把条目挂载为真实可调用工具、并让模型像迭代代码一样迭代它们的工具库。

## Decision

遵循 [capability-seam 规则](../../../../docs/glossary.md)的能力对：

- **`dsh-toolbox`**（`ctx.toolbox`）拥有每个项目根一条只追加的 JSONL 库（`<root>/.dsh/toolbox/toolbox.jsonl`，锚定最近 `.git` 祖先）。每条 `publish` 事件携带一个完整的工具版本：模型可见 schema（名称、描述、参数映射）加程序——async 函数体。折叠为每个名称保留一个活跃版本；同名再发布则取代旧版。写入经跨进程 `withFileLock` 串行化，锁内在每次追加前刷新折叠；每次 `snapshot()` 都重读文件（跨会话、可被外部编辑）。格式错误的行以 `CORRUPT_LIBRARY` 大声失败。这与 `dsh-memory` 有意保持一致：整个自我强化栈使用同一种存储惯用法。
- **`dsh-tool-toolbox`** 发布模型可见表面与挂载：`toolbox_publish` / `toolbox_retire` / `toolbox_list` 工具，以及为每个活跃库版本注册一个真实 `defineTool` 工具的 `syncMount`。执行经 code-runtime seam（`ctx.codeRuntime`，经 `ctx.get` 惰性解析，后端加载顺序自由）：挂载的 `execute` 把校验后的调用参数以 JSON `const args = ...` 序言注入程序，因为 worker 后端的 async 函数外壳只参数化绑定命名空间和 `console`——没有该序言而引用 `args` 的程序会死于 `ReferenceError`。`execute` 在调用时解析该名称*当前*的活跃版本，因此挂载之后发布的程序无需重新挂载即可运行。

参数类型在发布时校验（执行者拥有该决策）：工具接受可映射到 DSL 的集合（`string`/`number`/`integer`/`boolean` 带 `enum`，`array`、`object`、`json`），其余在事件持久化之前被拒绝。初始挂载在 `apply` 内被等待，因此损坏的库会在插件加载时失败；被手工编辑出不可映射 schema 的库条目会以告警跳过，而不是阻塞其余挂载。

其他进程对库的编辑会热同步挂载：库文件上的 chokidar watcher 在写入稳定后（`watchLibrary`，默认开启；`watchStabilityMs` 去抖）重新运行挂载同步。同步经一条与发布/退役工具共享的 promise 队列串行化，watcher 触发与工具触发的同步不会竞态出重复注册。库是在线更新平面；运行中进程自己的源码不是——harness/插件代码变更需要重启。

## Alternatives considered

- **`dynamicCordisRunner` 加持久层** —— 其 `define`/`run` 往返与 `node:vm` 沙箱面向带 host/client 半的完整插件；工具形态的程序会付出包生命周期的代价却用不上它，持久化其内存注册表还会分叉其所有权模型。建立在 code-runtime seam 上的窄库保留了执行隔离（`worker-thread`、预算、中止）而没有插件机器。
- **用 Skill（`dsh-skill`）做存储** —— skill 是文字流程，不是可执行定义；模型每次使用都要重新推导程序。工具箱存储程序本身。
- **每会话一个模型可见的 `eval` 工具** —— 无持久性、后续调用无 schema 校验、每个调用方都要重新信任程序文本。经 `toolbox_publish` 发布则校验一次，并挂载为注册表已知道如何呈现、调度和记录的普通工具。

## Consequences

- 一次编写的工具在项目上的每个后续会话都可直接调用，无需重新编写：即"无限个人工具库"的表面。发布已存在名称会热替换正在运行的程序——对工具的迭代与创建它是同一个手势。
- 另一个会话发布的工具（或手工编辑的库文件）在写入稳定后无需重启即在此挂载；watcher 的稳定性去抖以有界延迟换取对半写状态的稳健，与 `skill-filesystem` 做的是同一取舍。
- 工具程序不接收宿主绑定（`bindings: []`）：库工具是对其参数的纯计算。将选定的宿主函数（fs、subprocess、web）桥接进库工具被有意推迟——持久化、模型编写的程序调用宿主能力的攻击面需要独立评审，且当前没有工具需要它。
- 程序在共享的 code-runtime 计算/墙钟预算下运行；失控的工具死于超时，而不是拖垮进程。
- 挂载描述携带版本 id（`(project toolbox tool, version tool-xxxxxxxx)`），模型与会话日志都能引用执行的确切版本。
- 每个活跃库工具的 schema 都会进入每次工具列表请求：固定 token 成本随活跃集线性增长，仅受 `toolbox_retire` 约束。这是为持久性付出的显式代价。
