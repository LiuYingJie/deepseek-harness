# Agent Note: Web 全部停止

Status: implemented

[English](2026-08-14-web-halt-all.md) | 中文

## 问题

Web「停止生成」只中止普通会话的当前轮次，并保留 Queue，以便结算后运行下一项（[Web 停止操作保留待处理 Queue](../bug-fix/2026-07-31-web-stop-preserves-queue.md)）。父会话一旦空闲，该控件就会消失，即使可继续的后代或它所拥有的后台 job 仍在运行。因此，打开许多子线程的人在编辑器上没有一个能同时停止整棵树、清空排队后续并请求取消 job 的操作。

运行中的 Queue 发送、逐行编辑／删除，以及严格 steering（中途引导）已经存在（[将 Web 已排队消息转为活动轮次的 steering](2026-07-30-web-queue-steer-action.md)）。缺少的产品操作是整会话停止，而不是第二条 Queue。

## 决策

普通 InputBar 仍把「停止生成」作为保留轮次队列的控件。当地址指向的会话是正在运行、其 `session/jobs` 列表中有仍在活动的 job、或有正在运行的后代的普通父会话时，它还会在该控件左侧显示「全部停止」。已寻址的 child 不显示「全部停止」；可继续 child 的停止仍走 `subagent.interrupt`（[Continuable subagent 当前轮次中断](2026-08-06-continuable-subagent-interrupt.md)）。

「全部停止」调用带 `scope: 'all'` 的 `session.cancel`。省略 `scope` 与 `scope: 'turn'` 保持原先的 keepInbox 映射。由会话支撑的 subagent 仍以 `agent-busy` 拒绝每一种 scope。

Host 的 `haltSession` 先启动 `drainContinuableDescendants`，使准入截止与后代取消发生在父会话进入空闲并被 child 结算唤醒之前，再 `kill` `ownerSession` 等于该 agent 的仍在活动的 job，然后调用不带 `keepInbox` 的 `agent.cancel({ kind: 'user' })`。无主 job 继续运行。drain 的句柄释放与 job 结算留在后台；RPC 在这些信号发出后即返回 `{ accepted: true }`。之后的 drain 或 kill 失败只记日志，不改变该接纳结果。

## 考虑过的替代方案

**用「全部停止」替换「停止生成」。** 之所以否决：keepInbox 停止是有意的「跳过本轮」控件；把它过载会毁掉 Queue 已用显式删除暴露的排队意图。

**在返回前等待后代 drain 与 job 完全停稳。** 之所以否决：协作式取消没有上限；调用方只需要信号已发出，这与 interrupt 的发出即返回姿态一致。

**对每个后代做 interrupt，而不是排空整棵树。** 之所以否决：interrupt 会停放每个 child 的 inbox 并让 Activation 继续存活；「全部停止」是可继续子树的拆卸，不是逐 child 暂停。

**仅在父会话报告 `running` 时显示「全部停止」。** 之所以否决：这会在「父空闲、后代仍在跑」的情况下隐藏该控件，而正是这种情况让整棵树停不掉。

**杀掉 `list(agent)` 返回的每一个 job。** 之所以否决：该列表包含对每个调用方可见的无主 job；「全部停止」只拥有本会话的 job。

## 后果

运行中的普通编辑器会显示两个停止控件：「停止生成」跳过当前轮次并保留 Queue；「全部停止」清空 Queue、排空可继续后代，并请求取消所拥有的 job。父会话空闲后，只要后代或仍在活动的 job 还在，「全部停止」就可以继续显示。`accepted` 并不表示整棵树已经安静。会话的 job 列表仍包含无主 job，因此「全部停止」可能因一个它不会杀掉的 job 而保持可见。

## 测试

Host 覆盖证明省略／`turn` 会 keepInbox 且不 drain、不 kill，`all` 会先 drain、再杀掉所拥有的仍在活动的 job、然后不带 keepInbox 取消，drain 失败仍接纳，以及由 subagent 拥有的会话拒绝每一种 scope。客户端覆盖证明线协议载荷、运行中父会话以及带后代或仍在活动 job 的空闲父会话的「全部停止」可见性、可继续 child 上的缺席，以及 `conversation.halt` 映射。无密钥 Web 场景会挂起一轮、排队后续、激活「全部停止」，并证明 Queue 已消失且之后不会再从排队项启动一轮。
