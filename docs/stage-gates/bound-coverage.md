# v3.0 Bound Coverage Audit

审计日期：2026-09-14
基线 SHA：`71b3e44297d20b43faf31a677c2f5224a9e57481`（本轮没有创建新 commit）

## 判定规则

P0-15 的判定对象是“是否能重新进入先前执行状态”，而不是是否有一个看起来合理的 timeout。`timeout` 和 `retry_policy` 仍是单 Run 局部约束；`loop_budget` 是 Task 生命周期级、跨 Run 的累计上限。任何 active path 缺少以下任一项都必须 FAIL：确定性字段、运行时 admission、持久化、耗尽行为、可执行测试。

## Feedback Path → Bound → Enforcement → Persistence → Exhaustion → Evidence

| ID | Feedback path | State | Deterministic bound | Runtime enforcement | Persistence | Exhaustion behavior | Test evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Worker → Verifier FAIL → Repair/Retry → Worker | Active | `loop_budget.max_attempts`；`retry_policy.max_attempts` 只作局部上限 | `PersonalPiPipeline` 在 Run 前调用 `beforeRun`；`RecoveryManager.startRetry` 也调用 `beforeRun` | `PersistentState.loop_usage[task_id]` | `BLOCKED`，Decision Record，human escalation；不再获取 lease | `loop-budget.integration.test.ts` “bounds Worker → Verifier FAIL → Repair → Worker across Runs” |
| B2 | Worker/Controller → repeated model calls | Active | `max_model_calls` | `LoopBudgetController.beforeModelCall` 位于 Worker adapter 执行前 | `recordLoopUsage` 原子写回 state；新 Controller 从 state hydrate | 下一次调用前拒绝，Task `BLOCKED` | `loop-budget.integration.test.ts` model admission test |
| B3 | Verification → repeated tool/command calls | Active | `max_tool_calls` | Pipeline 每条 verification command 前调用 `beforeToolCall` | 同一 `loop_usage` 持久化 | 下一条工具调用前拒绝，Task `BLOCKED`；环境命令异常不伪造 PASS | `loop-budget.integration.test.ts`；pipeline failure/command evidence tests |
| B4 | Worker A → Worker B / Recovery REASSIGN → new Worker | Active（Recovery path） | `max_handoffs` + lease epoch | `RecoveryManager.recover(REASSIGN)` 在 acquire 新 lease 前调用 `beforeHandoff` | handoff usage、lease current/epoch 均写入 Persistent State | 超限转 `BLOCKED`，释放旧 lease，不创建新 lease | loop-budget integration “reassign handoff bound” |
| B5 | Decomposer → replan → Decomposer | Active（graph planning） | `decomposition_budget.max_replan_count` | `DynamicDecomposer.replan` 要求 persistent `BudgetController`，先检查再记录 replan | `budget_usage[scope]` 与 `budget_decisions[scope]`；新 Controller hydrate | `BudgetExceededError`，DENY Decision，不继续 replan | loop-budget integration persistent replan test；graph-intelligence tests |
| B6 | Worker → `INSUFFICIENT_CONTEXT` → later dispatch | Controlled / no automatic re-entry | 若人工重新进入，仍受 Task `max_attempts`/token bounds；当前自动路径没有第二次隐式 dispatch | Pipeline 将该结果置为 `BLOCKED`，不会把模型输出当成补上下文循环 | Task/Run/loop usage 持久化 | `BLOCKED`，等待显式人工动作 | `pipeline.ts:498-508`；Result Contract tests |
| B7 | Controller crash → restart → recovery → possible retry | Active recovery boundary | persisted `max_attempts`；lease epoch fencing | `recoverUnclosedRuns` 对 missing Worker 标记 CRASHED/BLOCKED；显式 Recovery retry 仍经过 `beforeRun` | Task/Run/lease/epoch/loop usage/effect journal/snapshot 全部在 state | stale lease 变 unknown；crashed Task BLOCKED；不接受迟到结果 | `controller-restart.integration.test.ts`；`persistence.test.ts` |
| B8 | Snapshot restore → control-plane reconstruction → execution | Restore is operator-controlled; no free cycle | Snapshot digest + Task loop budget | `restoreSnapshotFromStore` 校验 digest；重建只读 Persistent State + versioned contract | snapshot payload and metadata persist; digest excludes recursive snapshot metadata | digest mismatch throws；restore 不自动继续执行 | `persistence.test.ts` restore drill；controller restart integration |

## Machine audit result

`auditBoundCoverage(V3_FEEDBACK_PATHS)` 返回 `passed: true`、`uncovered_paths: []`。当前代码清单的五个 active re-entry paths 是 B1–B5；B6–B8 是额外审计到的受控边界，均明确为 BLOCKED/人工触发或 restore-only，而不是未登记的自由循环。

这不等于允许自由 Agent cycle、Swarm、Event Bus 或 T13 Batch/Parallel。任何新路径在启用前必须加入这张表并通过同样的 machine audit；否则对应 Phase Gate 只能是 **FAIL / BLOCKED**。

## Current verdict

**PASS / CLOSED for active v3.0 Personal PI paths.**
**Repository release gate remains PARTIAL / REOPENED**，原因是完整仓库存在已知上游失败，详见 [`v3-retroactive-audit.md`](./v3-retroactive-audit.md)。
