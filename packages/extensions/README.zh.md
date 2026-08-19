# extensions/：agent（智能体）修改自身运行时

[English](README.md) | 中文

agent 修改自身运行时：检查已加载的插件与服务接口、定义并运行模型编写的动态包（dynamic package）并再次撤下，外加受限 repository Plugin 运行时。两个浏览器半的包住在这里而不是 `packages/client/`，因为它们是本子系统双半包的其中一半；host 聚合把它们排除在外，让两个契约面各自保有独立的编译 program。设计居所：[工具集 Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | `cordis_inspect`／`cordis_define`／`cordis_run`／`cordis_stop`／`cordis_undefine` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的动态包 | 注册到 `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.md) | 定义注册表、host 半的 `node:vm` 沙箱，以及 request-run 往返 | 提供 `ctx.dynamicCordisRunner` |
| [`cordis-client-runner/`](cordis-client-runner/README.md) | 双半包的浏览器半：把定义求值成活的浏览器插件，并应答运行请求 | client 面；提供浏览器侧 `ctx.dynamicCordisRunner` |
| [`ui-cordis/`](ui-cordis/README.md) | 浏览器面：操作全部定义的全局面板，与只读的 define 卡片 | client 面；注册 slot |
| [`toolbox/`](toolbox/README.md) | 项目级持久化工具库：code-runtime seam 之上的 JSONL fold | 提供 `ctx.toolbox` |
| [`tool-toolbox/`](tool-toolbox/README.md) | 模型侧 publish/retire/list 工具与持久工具挂载 | 注册到 `ctx.tools` |
| [`refinery/`](refinery/README.md) | 项目级持久化改进提案流：propose/settle 事件的 JSONL fold | 提供 `ctx.refinery` |
| [`tool-refinery/`](tool-refinery/README.md) | 模型侧 run/list/settle 工具与只读提案编写 subagent | 注册到 `ctx.tools` |
