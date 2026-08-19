# @deepseek-ai/dsh-refinery

[English](README.md) | 中文

项目级持久改进提案流。refinery 把后台编写的改进提案存为每个项目根一条追加式 JSONL 流，并折叠出活跃提案集。提案是分析加建议的变更——绝不是已应用的变更：这条流的存在，是为了让人类（或经人类授权的会话）在有任何修改之前，先审查后台分析者的结论。

## 组合

```yaml
- id: refinery
  name: '@deepseek-ai/dsh-refinery'
  config:
    path: './.dsh/refinery/proposals.jsonl'   # optional; defaults to the project root anchor
```

省略 `path` 时默认为 `<最近 .git 祖先>/.dsh/refinery/proposals.jsonl`。

## Service API

`ctx.refinery`（类 `RefineryService`，默认导出）：

- `snapshot(): Promise<RefineryState>` —— 按插入顺序返回活跃（未结算）提案加总事件数。每次读取都重新校验持久 JSON 边界：格式错误的行以 `RefineryError`（`CORRUPT_STREAM`）失败，绝不产生静默错误的折叠。
- `propose(input): Promise<RefineryProposal>` —— 追加一条 `propose` 事件；`id`（`prop-<8 位十六进制>`）与 `createdAt` 在此生成。
- `settle(input): Promise<RefineryProposal | undefined>` —— 追加一条 `settle` 事件（`applied` 或 `discarded`）；返回带注记的提案，id 未知或已结算时返回 `undefined`。

写入通过跨进程文件锁（`dsh-atomic-write`）串行化，并在每次追加前于锁内从磁盘刷新折叠。流文件位于会话日志之外；它不拥有会话事件流。

## 扩展点

组合 `dsh-tool-refinery` 获得模型可见表面与后台提案编写者；本流 seam 本身不携带任何模型可见内容。

## Model Experience

None, as the service persists a project file; the seam carries no model-visible surface. Compose the Consumer for the tools and the author.

#### KV Cache effect

None; the service adds nothing to any request prefix.

## Known Limitations and Deferred Work

- **No author trigger built in** — the service only persists; when a proposal author runs (on load, on a timer, after N failures) belongs to the Consumer or the composing deployment, not to storage.
