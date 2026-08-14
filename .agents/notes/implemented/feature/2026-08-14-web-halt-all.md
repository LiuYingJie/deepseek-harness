# Agent Note: Web Halt all

Status: implemented

English | [中文](2026-08-14-web-halt-all.zh.md)

## Problem

Web Stop generating aborts only the current ordinary-session turn and preserves Queue so the next item runs after settlement ([Web stop preserves pending Queue](../bug-fix/2026-07-31-web-stop-preserves-queue.md)). That control disappears once the parent is idle, even while continuable descendants or owned background jobs keep running. A human who opened many child threads therefore had no composer action that stopped the tree, cleared queued follow-ups, and requested job cancellation together.

Queue send while running, per-row edit/delete, and strict steer already exist ([Steer a queued Web message](2026-07-30-web-queue-steer-action.md)). The missing product action is a whole-session halt, not a second Queue.

## Decision

Ordinary InputBar keeps Stop generating as the turn-preserving control. It additionally shows Halt all to the left of that control while the addressed session is an ordinary parent that is running, has a live job in its `session/jobs` list, or has a running descendant. Addressed children do not show Halt all; a continuable child's Stop remains `subagent.interrupt` ([Continuable subagent interrupt](2026-08-06-continuable-subagent-interrupt.md)).

Halt all calls `session.cancel` with `scope: 'all'`. Omitted `scope` and `scope: 'turn'` keep the previous keepInbox mapping. Session-backed subagents still reject every scope with `agent-busy`.

Host `haltSession` starts `drainContinuableDescendants` first so admission cutoff and descendant cancellation run before the parent can go idle and be woken by child settlement, then `kill`s live jobs whose `ownerSession` equals this agent, then `agent.cancel({ kind: 'user' })` without `keepInbox`. Unowned jobs stay running. Drain handle release and job settlement stay in the background; the RPC returns `{ accepted: true }` once those signals are issued. A later drain or kill failure is logged and does not change that acceptance.

## Alternatives considered

**Replace Stop generating with Halt all.** Rejected because the keepInbox stop is the intended skip-this-turn control; overloading it would destroy queued intent the Queue already exposes as explicit delete.

**Await descendant drain and job quiescence before returning.** Rejected because cooperative cancellation is unbounded; the caller only needs the signals issued, matching interrupt's fire-and-return posture.

**Interrupt each descendant instead of draining the tree.** Rejected because interrupt parks each child's inbox and leaves Activations live; Halt all is a teardown of the continuable subtree, not a per-child pause.

**Show Halt all only while the parent reports `running`.** Rejected because that hides the control in the idle-parent, live-descendants case that made the tree unstoppable.

**Kill every job `list(agent)` returns.** Rejected because that list includes unowned jobs visible to every caller; Halt all owns only this session's jobs.

## Consequences

A running ordinary composer shows two stop controls: Stop generating skips the current turn and keeps Queue; Halt all clears Queue, drains continuable descendants, and requests owned-job cancellation. Halt all can remain after the parent is idle while descendants or live jobs remain. `accepted` does not mean the tree is already quiet. The session job list still includes unowned jobs, so Halt all can stay visible for a job it will not kill.

## Testing

Host coverage proves omitted/`turn` keepInbox without drain or kill, `all` drains then kills owned live jobs then cancels without keepInbox, drain failure still accepts, and subagent-owned sessions reject every scope. Client coverage proves the wire payload, Halt all visibility for running parents, idle parents with descendants or live jobs, absence on continuable children, and `conversation.halt` mapping. The keyless Web scenario hangs one turn, queues follow-ups, activates Halt all, and proves the Queue is gone and no later queued turn starts.
