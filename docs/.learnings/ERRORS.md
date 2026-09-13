# Personal PI 工程错误与修复记录

## [ERR-20260913-001] Phase 1 初轮验证

**Logged**: 2026-09-13T21:20:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
初轮构建暴露 TypeBox 错误对象字段假设，Lease 测试暴露旧租约判定顺序错误。

### Error
```text
src/schema.ts(127,74): error TS2339: Property 'path' does not exist on type 'TLocalizedValidationError'.
Expected reason: stale_result
Received reason: worker_mismatch
```

### Context
- Operation: `npm run build --workspace=@personal-pi/core` and the Phase 1 Vitest suite.
- TypeBox 1.3.27 的所有本地化错误类型不都暴露 `path`。
- 旧 Worker 的 epoch 已落后时，错误类型应先判为 stale，再检查 worker 身份。

### Suggested Fix
读取错误路径前做结构化字段存在性检查；Lease 判定先比较 epoch，再比较 worker。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/schema.ts`, `packages/personal-pi/src/lease.ts`
- Tags: phase-1, typebox, fencing-token

### Resolution
- **Resolved**: 2026-09-13T21:24:00+08:00
- **Notes**: 已完成代码修复，等待同一验证命令重跑确认。

---

## [ERR-20260913-010] Phase 7 Worker Task Contract boundary

**Logged**: 2026-09-13T22:08:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: pipeline integration

### Summary
DoR 修复后，Worker 仍收到包含状态字段的 Task Record，导致所有闭环结果被拒绝。

### Error
```text
expected execution.task.state to be DONE
received FAILED
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: `PiWorker` 对执行请求执行严格 Task Contract 校验，`state/audit_log` 不能穿过 Worker 协议边界。

### Suggested Fix
WorkerProtocolRequest 使用原始 `request.task` Contract；Task Record 仅留在 Controller 的状态和持久化路径。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/pipeline.ts`, `packages/personal-pi/src/worker.ts`
- Tags: phase-7, pipeline, protocol-boundary

### Resolution
- **Resolved**: 2026-09-13T22:09:00+08:00
- **Notes**: 已切断 Task Record 到 Worker 的传递，待重跑闭环测试。

---

## [ERR-20260913-009] Phase 7 DoR Task Record boundary

**Logged**: 2026-09-13T22:07:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: pipeline integration

### Summary
完整闭环的 DoR 步骤把持久化 Task Record 传给只接受 Task Contract 的 schema 校验器。

### Error
```text
DOR: /: schema is false; /: schema is false; /: must not have additional properties
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: `TaskRecord` 的 `state` 和 `audit_log` 字段不属于 Versioned Task Contract，不能进入 Contract schema 校验。

### Suggested Fix
在 DoR 边界使用原始 `request.task` Contract；状态机只在 DoR 通过后处理 Task Record。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/pipeline.ts`, `packages/personal-pi/src/readiness.ts`
- Tags: phase-7, pipeline, task-contract

### Resolution
- **Resolved**: 2026-09-13T22:08:00+08:00
- **Notes**: 已修正管线调用边界，保留 Task Record 仅用于状态转换和持久化。

---

## [ERR-20260913-007] Phase 6 erasable TypeScript build gate

**Logged**: 2026-09-13T21:55:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: build

### Summary
Phase 6 测试通过后，包构建因参数属性不符合 `erasableSyntaxOnly` 失败。

### Error
```text
src/context.ts(160,14): error TS1294:
This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
```

### Context
- Operation: `npm run build --workspace=@personal-pi/core`
- Cause: `ContextResolver` used a constructor parameter property.

### Suggested Fix
使用显式的 `private readonly store` 字段和普通构造函数赋值，保持仓库的纯擦除 TypeScript 约束。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/context.ts`
- Tags: phase-6, typescript, build

### Resolution
- **Resolved**: 2026-09-13T21:56:00+08:00
- **Notes**: 已改为显式字段，待重跑构建和仓库检查。

---

## [ERR-20260913-006] Phase 6 context cache validation

**Logged**: 2026-09-13T21:54:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: context projection

### Summary
第二次解析压缩后的必需上下文没有命中缓存。

### Error
```text
expected second.cache_hit to be true
received false
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: cache validation compared compacted item content with the original content returned by the content-addressed store.

### Suggested Fix
缓存项只需按其内容地址重新读取并通过哈希完整性校验；不得把预算压缩后的投影文本与原文直接比较。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/context.ts`, `packages/personal-pi/test/context.test.ts`
- Tags: phase-6, context, cache

### Resolution
- **Resolved**: 2026-09-13T21:55:00+08:00
- **Notes**: 缓存校验改为 `ContextStore.get` 完整性结果，随后重跑测试与构建。

---

## [ERR-20260913-002] 仓库级 Biome 检查

**Logged**: 2026-09-13T21:25:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
协议隔离递归检查的 `forEach` 回调隐式返回了递归调用结果，被仓库 lint 规则拒绝。

### Error
```text
lint/suspicious/useIterableCallbackReturn
This callback passed to forEach() iterable method should not return a value.
```

### Context
- Operation: `npm run check`.
- The failure was in `packages/personal-pi/src/protocol.ts` and was introduced by this Phase 1 implementation.

### Suggested Fix
使用块体回调显式丢弃递归调用返回值，保持遍历行为不变。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/protocol.ts`
- Tags: biome, phase-1, protocol-isolation

### Resolution
- **Resolved**: 2026-09-13T21:26:00+08:00
- **Notes**: 已改为块体回调，待完整 `npm run check` 重跑确认。

---

## [ERR-20260913-003] Phase 2 规则覆盖

**Logged**: 2026-09-13T21:29:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
初轮规划测试发现 API 关键词和 `integration` 依赖信号没有覆盖到预期路径。

### Error
```text
Expected dispatch mode: DECOMPOSE, received: PARALLEL
Expected worker tier: standard, received: cheap
```

### Context
- Operation: Phase 2 Vitest suite.
- The deterministic rule table did not treat a standalone API keyword as medium risk.
- The dependency regex used a prefix with a trailing word boundary and did not match `integration`.

### Suggested Fix
将 standalone `api` 纳入 API 风险信号，使用完整 `integration/integrate` 依赖词，并覆盖 `deploy to production` 的高风险表达。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/planning.ts`, `packages/personal-pi/test/planning.test.ts`
- Tags: phase-2, preclassifier, assessment, dispatch

### Resolution
- **Resolved**: 2026-09-13T21:30:00+08:00
- **Notes**: 已补齐规则并继续运行 Phase 2 测试。

---

## [ERR-20260913-004] Phase 3 Worker Contract 测试

**Logged**: 2026-09-13T21:36:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Phase 3 初测发现入口重复导出，以及 malformed Result 的分类字段断言位置不正确。

### Error
```text
The worker test expected "worker returned malformed result" in errors,
but the implementation returned schema details in errors and the classification in summary.
The index also exported worker.ts twice.
```

### Context
- Operation: `npm run test --workspace=@personal-pi/core -- --config vitest.config.ts`.
- Both issues were introduced in the new Phase 3 files.

### Suggested Fix
删除重复导出；按 Result Contract 语义在 `summary` 检查结果分类，保留 schema 详情在 `errors`。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/index.ts`, `packages/personal-pi/test/worker.test.ts`
- Tags: phase-3, worker, result-contract

### Resolution
- **Resolved**: 2026-09-13T21:37:00+08:00
- **Notes**: 已完成修复，待重跑测试。

---

## [ERR-20260913-005] Phase 3 lint warning

**Logged**: 2026-09-13T21:38:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
仓库级检查发现 Worker 文件遗留两个未使用导入。

### Error
```text
packages/personal-pi/src/worker.ts: unused createProtocolEnvelope import
packages/personal-pi/src/worker.ts: unused TaskContract type import
```

### Context
- Operation: `npm run check`.
- Biome reported two warnings and stopped before TypeScript verification.

### Suggested Fix
删除不参与 Worker 执行路径的导入。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/worker.ts`
- Tags: biome, phase-3, worker

### Resolution
- **Resolved**: 2026-09-13T21:39:00+08:00
- **Notes**: 已删除两个未使用导入，待完整检查确认。

---

## [ERR-20260913-008] Phase 6 repository lint gate

**Logged**: 2026-09-13T21:56:00+08:00
**Priority**: low
**Status**: resolved
**Area**: lint

### Summary
仓库级检查拒绝了缓存命中判断中的可选链风格告警。

### Error
```text
lint/complexity/useOptionalChain
Found 1 warning.
```

### Context
- Operation: `npm run check`
- Cause: Biome 要求对可能为空的缓存对象使用 optional chain。

### Suggested Fix
将 `cached && cached.items...` 改为 `cached?.items...`。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/context.ts`
- Tags: phase-6, biome, lint

### Resolution
- **Resolved**: 2026-09-13T21:57:00+08:00
- **Notes**: 已按仓库 lint 规则修正。

---

## [ERR-20260913-011] Phase 7 pipeline type import boundary

**Logged**: 2026-09-13T22:09:00+08:00
**Priority**: low
**Status**: resolved
**Area**: build

### Summary
Phase 7 包构建发现管线从错误模块导入两个运行时接口类型。

### Error
```text
'./types.ts' has no exported member named 'VerificationRecipeRegistry'
'./types.ts' has no exported member named 'WorkerAdapter'
```

### Context
- Operation: `npm run build --workspace=@personal-pi/core`
- Cause: Registry 和 Adapter 是各自模块的行为接口，不属于领域数据类型。

### Suggested Fix
分别从 `recipes.ts` 和 `worker.ts` 以 `import type` 引入，保持模块责任边界。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/pipeline.ts`
- Tags: phase-7, typescript, module-boundary

### Resolution
- **Resolved**: 2026-09-13T22:10:00+08:00
- **Notes**: 已纠正类型导入路径，待重跑构建和仓库检查。

---

## [ERR-20260913-012] Phase 7 Routine Capture naming collision

**Logged**: 2026-09-13T22:12:00+08:00
**Priority**: low
**Status**: resolved
**Area**: build

### Summary
Routine Capture 的内部回归数组与公开读取方法使用了相同名称。

### Error
```text
src/routines.ts(84,19): error TS2300: Duplicate identifier 'regressions'.
src/routines.ts(164,2): error TS2300: Duplicate identifier 'regressions'.
```

### Context
- Operation: `npm run build --workspace=@personal-pi/core`
- Cause: TypeScript 不允许类字段和方法共享同名标识符。

### Suggested Fix
将字段重命名为 `regressionCases`，保留 `regressions()` 作为读取 API。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/routines.ts`
- Tags: phase-7, routine-capture, typescript

### Resolution
- **Resolved**: 2026-09-13T22:13:00+08:00
- **Notes**: 已完成内部字段重命名。

---

## [ERR-20260913-013] Phase 7 trigger and routine test semantics

**Logged**: 2026-09-13T22:14:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Phase 7 行为测试发现重复 Trigger 返回值和同步异常断言的语义不准确。

### Error
```text
duplicate.created was true
RoutineCaptureError escaped before a Promise rejection assertion
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: Gateway 返回了首次结果对象而非 duplicate 结果；RoutineCapture 的 API 是同步校验。

### Suggested Fix
重复事件返回 `created=false` 且保留原 Task 引用；同步 RoutineCapture 使用 `toThrow` 断言。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/triggers.ts`, `packages/personal-pi/test/triggers-routines.test.ts`
- Tags: phase-7, trigger, routine-capture

### Resolution
- **Resolved**: 2026-09-13T22:15:00+08:00
- **Notes**: 已修正重复幂等结果与测试断言。

---

## [ERR-20260913-014] Phase 7 failed-trigger retry assertion

**Logged**: 2026-09-13T22:15:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
Trigger 创建失败后，同键调用正确进入 duplicate 分支，但测试仍要求重复返回原失败文本。

### Error
```text
expected duplicate.reason to equal task creation failed: invalid task contract
received duplicate idempotency_key
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: 测试没有体现“创建失败后不自动重试，避免重复触发”的任务约束。

### Suggested Fix
断言第二次调用为 duplicate 且告警数量保持 1。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/test/triggers-routines.test.ts`
- Tags: phase-7, trigger, idempotency

### Resolution
- **Resolved**: 2026-09-13T22:16:00+08:00
- **Notes**: 已修正为不重试语义的断言。

---

## [ERR-20260913-015] Phase 7 repository lint warnings

**Logged**: 2026-09-13T22:16:00+08:00
**Priority**: low
**Status**: resolved
**Area**: lint

### Summary
仓库检查在 Phase 7 新增文件中发现 5 条未使用导入/参数告警。

### Error
```text
Found 5 warnings.
lint/correctness/noUnusedImports
lint/correctness/noUnusedFunctionParameters
```

### Context
- Operation: `npm run check`
- Cause: Trigger 未使用的 UUID 导入、Routine 参数替换辅助函数的冗余参数，以及测试夹具的未使用参数。

### Suggested Fix
删除未使用导入，简化辅助函数签名，对有意忽略的测试参数使用下划线命名。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/triggers.ts`, `packages/personal-pi/src/routines.ts`, `packages/personal-pi/test/pipeline.test.ts`
- Tags: phase-7, biome, lint

### Resolution
- **Resolved**: 2026-09-13T22:17:00+08:00
- **Notes**: 已清理 5 条告警，待重跑仓库检查。

---

## [ERR-20260913-016] Phase 8 graph intelligence semantics

**Logged**: 2026-09-13T22:26:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: graph intelligence

### Summary
Phase 8 初测发现子任务只通过结构 schema 不足以满足 DoR；终态任务被 `resolveAll` 误映射为 READY；预算错误缺少维度标识。

### Error
```text
invalid child with empty acceptance criteria was accepted
DONE dependencies were reported as READY
budget error did not identify its exceeded dimension
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: DynamicDecomposer 未执行子任务最小 DoR 语义，DependencyResolver 的汇总只调用 READY 判定，BudgetExceededError 消息未带维度。

### Suggested Fix
拒绝空验收子任务；`resolveAll` 保留 DONE 终态；预算错误消息包含 `max_*` 维度，便于 Controller 留痕和人工调升。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/graph-intelligence.ts`, `packages/personal-pi/test/graph-intelligence.test.ts`
- Tags: phase-8, graph, budget, readiness

### Resolution
- **Resolved**: 2026-09-13T22:27:00+08:00
- **Notes**: 已修正拆解、依赖汇总和预算错误语义。

---

## [ERR-20260913-017] Phase 8 graph lint warning

**Logged**: 2026-09-13T22:27:00+08:00
**Priority**: low
**Status**: resolved
**Area**: lint

### Summary
仓库检查发现 Graph Intelligence 模块有一个未使用的 `GraphNode` 类型导入。

### Error
```text
lint/correctness/noUnusedImports
Found 1 warning.
```

### Context
- Operation: `npm run check`
- Cause: 实现使用 `graphNodeForTask` 的结构返回类型，没有直接引用 `GraphNode`。

### Suggested Fix
删除冗余类型导入。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/graph-intelligence.ts`
- Tags: phase-8, biome, graph

### Resolution
- **Resolved**: 2026-09-13T22:28:00+08:00
- **Notes**: 已删除未使用导入。

---

## [ERR-20260913-018] Phase 9 recovery fault test isolation

**Logged**: 2026-09-13T22:36:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Recovery 测试将 RESUME 与 REASSIGN 连续施加在同一 Task，触发了设计中的“两次失败后 BLOCKED”硬门。

### Error
```text
expected REASSIGN
received BLOCK
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: 测试场景混合了两个独立恢复策略；第二次回收同一 Task 必须阻断自动恢复。

### Suggested Fix
将 RESUME 与 REASSIGN 放入独立 Task 故障场景，并保留专门测试验证两次失败后 BLOCKED。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/test/recovery.test.ts`
- Tags: phase-9, recovery, fault-injection

### Resolution
- **Resolved**: 2026-09-13T22:37:00+08:00
- **Notes**: 已隔离故障场景，保留两次失败硬门测试。

---

## [ERR-20260913-019] Phase 9 recovery fencing window

**Logged**: 2026-09-13T22:37:00+08:00
**Priority**: high
**Status**: resolved
**Area**: recovery

### Summary
Recovery 生成 REASSIGN 计划后到下一次 Retry 启动前，旧 Lease 仍可能被判定为 current。

### Error
```text
expected old lease to be stale
received accepted=true, reason=current
```

### Context
- Operation: `npm test --workspace=@personal-pi/core`
- Cause: 回收只改变了 Run/Task 状态，没有立即推进 Lease epoch。

### Suggested Fix
Recovery 计划落地时先为下一 Worker（或原 Worker 的续做）取得新的 epoch；正式 `startRetry` 再领取执行 Lease。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/recovery.ts`, `packages/personal-pi/test/recovery.test.ts`
- Tags: phase-9, recovery, fencing

### Resolution
- **Resolved**: 2026-09-13T22:38:00+08:00
- **Notes**: 已在所有回收分支推进 Lease epoch，旧结果立即失效。

---

## [ERR-20260913-020] Phase 9 ValidationResult narrowing

**Logged**: 2026-09-13T22:39:00+08:00
**Priority**: low
**Status**: resolved
**Area**: build

### Summary
Recovery 的包构建要求显式收窄通过校验后的 `ValidationResult.value`。

### Error
```text
src/recovery.ts(188,7): error TS18048:
'validation.value' is possibly 'undefined'.
```

### Context
- Operation: `npm run build --workspace=@personal-pi/core`
- Cause: `ValidationResult<T>.value` 是可选字段，`valid=true` 并未让编译器自动推断其存在。

### Suggested Fix
同时检查 `validation.value` 并保存为局部 `admitted` 后再做身份比较。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/recovery.ts`
- Tags: phase-9, typescript, result-contract

### Resolution
- **Resolved**: 2026-09-13T22:40:00+08:00
- **Notes**: 已完成显式类型收窄。

---

## [ERR-20260913-021] Phase 9 recovery lint warnings

**Logged**: 2026-09-13T22:40:00+08:00
**Priority**: low
**Status**: resolved
**Area**: lint

### Summary
仓库检查发现 Recovery 实现和故障测试各有未使用导入。

### Error
```text
lint/correctness/noUnusedImports
Found 2 warnings.
```

### Context
- Operation: `npm run check`
- Cause: `ResultContract`、`createTaskRecord` 和 `Lease` 在最终实现中没有直接使用。

### Suggested Fix
删除三个冗余导入。

### Metadata
- Reproducible: yes
- Related Files: `packages/personal-pi/src/recovery.ts`, `packages/personal-pi/test/recovery.test.ts`
- Tags: phase-9, biome, recovery

### Resolution
- **Resolved**: 2026-09-13T22:41:00+08:00
- **Notes**: 已删除冗余导入。

---
