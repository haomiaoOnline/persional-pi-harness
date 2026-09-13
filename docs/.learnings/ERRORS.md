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
