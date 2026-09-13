# Personal PI Phase 9 Evidence

## Task results

| Task | Result | Evidence |
|---|---|---|
| T9.1 | PASS | `RecoveryManager.findTimedOut` 按 Task timeout 检测 RUNNING Run，标记 Run 为 TIMEOUT，并通过状态机回到 READY。 |
| T9.2 | PASS | 安全的部分改动选择 RESUME；崩溃且有候选 Worker 选择 REASSIGN；Recovery 立即推进 Lease epoch，旧 Worker 结果被 fencing 拒绝。 |
| T9.3 | PASS | malformed output 进入回收；错误 Task/epoch 的 Result 被拒绝并留下 Decision Record；校验与身份判断均在接受结果前完成。 |
| T9.4 | PASS | 同一 Task 连续两次回收后进入 BLOCKED，不能第三次自动 Retry；`retry_policy.max_attempts=1` 也会在首次失败后阻断；四类故障注入均通过。 |

## Commands

```text
npm test --workspace=@personal-pi/core              PASS (89/89)
npm run build --workspace=@personal-pi/core        PASS
npm run check                                       PARTIAL PASS
```

仓库级检查的 Biome、依赖、导入、入口图、shrinkwrap 和 install-lock 均通过；TypeScript 总检查仍只命中已确认的 upstream 基线错误：

```text
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

本 Phase 未修改 `packages/ai`，不判为 Personal PI 回归。

## Stage Gate

**Phase 9: PASS**

Recovery 已实现冻结、超时、重试、续做、改派、结果 fencing、结构化 Decision 与两次失败阻断。Phase 10 安全与权限已解锁。
