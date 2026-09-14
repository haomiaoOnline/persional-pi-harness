# Personal PI Harness v3.0 Gap Matrix

审计日期：2026-09-14（Asia/Taipei）
审计基线：`71b3e44297d20b43faf31a677c2f5224a9e57481`
需求基线：用户提供的 v3.0 架构设计与可执行任务清单；文件路径和 SHA-256 见 [`evidence-bundle.md`](./evidence-bundle.md)。

## 追踪矩阵

| Architecture v3.0 requirement | Task ID | Implementation | Test / command | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| P0-15：任何会重新进入先前执行状态的反馈路径必须有确定性预算 | T1.1-B | `packages/personal-pi/src/types.ts:104-130`; `src/loop-budget.ts:45-145`; `src/pipeline.ts:321-428`; `src/recovery.ts:68-174` | `test/loop-budget.integration.test.ts`：跨 Run 重试、model/tool/handoff admission、缺失预算 | [`bound-coverage.md`](./bound-coverage.md)；loop-budget targeted run | **PASS / CLOSED**（Personal PI 核心范围） |
| Task 生命周期级、跨 Run 的累计 Loop Budget；restart 不清零；耗尽 BLOCKED + human escalation | T1.1-B | `PersistentState.loop_usage`、`BudgetUsageState`、`LoopBudgetController` | `test/loop-budget.integration.test.ts`；`test/controller-restart.integration.test.ts` | State JSON 中的 `loop_usage`、BLOCKED Decision Record、restart marker | **PASS / CLOSED** |
| Stage Gate 固定执行 Bound Coverage Audit，未知路径不得默认为 covered | T1.6 | `packages/personal-pi/src/bound-coverage.ts:1-104`；`src/index.ts` 导出 | `auditBoundCoverage(V3_FEEDBACK_PATHS)`；loop-budget integration | [`bound-coverage.md`](./bound-coverage.md) 的路径矩阵 | **PASS / CLOSED**（已启用路径） |
| Pipeline Green 不等于真实工作；成功但无 observable work 必须异常 | T3.5 | `src/result.ts:69-122`; `src/verification.ts:197-232`; `src/pipeline.ts:481-527` | `verification.test.ts`：无 artifact/无 state change/无合法 no-op reason；合法 no-op | `work_receipt_anomaly` Decision/Trace；DONE legal no-op assertion | **PASS / CLOSED** |
| Verifier 只接受白名单结构化输入，不读取 Worker 私有解释 | T4.2-A | `src/verification.ts:65-103`; pipeline passes sanitized result and persisted command evidence | `test/verifier-isolation.integration.test.ts`：错误解释与移除解释的 deterministic FAIL 一致 | Verifier DTO 无 `summary`；两次 FAIL reasons 相等 | **PASS / CLOSED** |
| 从真实 Trace 派生 graph/coordination metrics，不手工伪造接口 | T11.4-A | `src/trace.ts:140-198, 412-464`; `src/pipeline.ts:535-543` | `trace.test.ts` exact derivation；`phase-7-real-e2e.test.ts`; `single-vs-multi.eval.test.ts` | [`evidence-bundle.md`](./evidence-bundle.md) 的 baseline 表 | **PASS / CLOSED**（local E2 evidence） |

## 结论解释

矩阵中的 PASS 只表示当前 Personal PI 自有层有实现、可执行测试和可复核证据，不表示整个仓库已经通过发布门，也不表示已有真实外部 Provider/生产流量证据。整体放行仍由 Phase 0–12 状态和 P0 硬 Gate 决定；本轮总结果是 **NOT READY FOR T13**。

## 未关闭缺口

1. 根仓库的完整 `npm run check` 仍命中已知上游 `google-shared.ts:402` 类型错误。
2. `./test.sh` 的 `packages/coding-agent` 仍有精确的 PPH rebrand/上游 runtime 失败；没有 broad skip，也没有删除测试。
3. T3.2/T7.2/T7.3/T7.4/T12 的更高等级真实 Provider、五任务、自举和长期 always-on 证据尚未在本轮形成；local process E2 证据不能冒充生产证据。
