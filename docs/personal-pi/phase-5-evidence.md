# Personal PI Phase 5 Evidence

## Task results

| Task | Result | Evidence |
|---|---|---|
| T5.1 | PASS | 原子 JSON PersistentStateStore 覆盖 Project/Task/Graph/Dispatch/Run/Result/Evidence/Verification/Decision/Role/Effect；新实例可重新读取任务和决策。 |
| T5.2 | PASS | 同一 Task ID 产生 attempt 1/2 两条 Run，失败 Result 写回 Run 状态，重试不会生成新 Task ID。 |
| T5.3 | PASS | 新 Store 实例扫描未关闭 Run；Worker 消失时 Run 变为 CRASHED，任务通过状态机进入 BLOCKED，留下恢复决定。 |
| T5.4 | PASS | Snapshot 以 state digest 绑定；Restore Drill 故意污染任务和决策后恢复原状态，篡改 digest 会被拒绝。 |
| T5.5 | PASS | 隔离的全新 Store 实例仅凭持久化状态重建 READY/RUNNING/BLOCKED/Decision 索引，可继续识别下一步控制状态。 |

## Commands

```text
npm run build --workspace=@personal-pi/core                             PASS
npm run test --workspace=@personal-pi/core -- --config vitest.config.ts PASS (57/57)
```

## Stage Gate

**Phase 5: PASS**

核心状态不再依赖聊天上下文或单一 Controller 进程；Run 历史、崩溃回收和可验证快照均已落盘。Phase 6 Context Projection 已解锁。
