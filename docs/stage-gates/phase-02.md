# Phase 2 Stage Gate — Master 控制平面与规划治理

Final verdict: **PASS / CLOSED**（代码/测试范围）
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮修改未提交。

## Requirements / tasks

`T2.0`、`T2.0-A`、`T2.1`、`T2.2`、`T2.3`、`T2.3-A`、`T2.4`、`T2.5`、`T2.6`、`T2.7`：Fast/Slow preclassifier、false-negative tracking、Master 边界、Assessment/规则交叉校验、Dispatch/Role/Reasoning mapping、Requirement Contract、Plan Quality Gate、Role Profile。

## Scope / implementation location

实现位于 `packages/personal-pi/src/planning.ts`、`src/pipeline.ts:204-261`、`src/types.ts` 的 Role/Contract 类型；验证覆盖 `packages/personal-pi/test/planning.test.ts`。Pipeline 先通过 plan gate，再持久化 Task、DoR 和 Dispatch Decision。

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run test/planning.test.ts
expected: planning and role tests pass
actual: included in the 25-file/142-test core pass

npm run test --workspace @personal-pi/core
expected: planning changes do not regress the core
actual: 25 files, 142 tests passed
```

## Static Validation

The core build, dependency/import/entry-graph checks and protocol isolation pass. No extra LLM call or dynamic model-based rule was introduced for reasoning-depth mapping.

## Failure injection

The suite covers labeled Fast/Slow cases, high-risk keyword escalation, false-negative recording, rule-level risk floor, invalid Requirement/Plan Gate inputs, missing approval, and Role/permission boundary checks. A deterministic rule can reject an optimistic assessment; the model/summary cannot override the rule.

## Persistence / recovery evidence

Assessment, dispatch and plan decisions are structured records in Persistent State and Trace. There is no hidden model retry loop in reasoning-depth mapping. Recovery of the persisted control plane is tested in Phase 5.

## Bound Coverage

Planning does not enable an unbounded re-entry path. If a later decomposition replan is requested, it must go through the persistent graph budget path documented as B5 in [`bound-coverage.md`](./bound-coverage.md). Model completion is never used as a loop terminator.

## Regression results

Core package tests, build, protocol isolation and Personal PI regression passed. Repository-wide known failures remain isolated to Phase 0.

## Known upstream failures

The exact `packages/ai/src/api/google-shared.ts(402,10)` exhaustive-switch error and coding-agent `pi`/`pph`, `.pi`/`.pph`, remote-session and fswatch fingerprints are unchanged. No Phase 2 file is used to suppress them.

## Unresolved issues

This gate does not claim live LLM/provider accuracy, commercial assessment quality, or five consecutive human approvals. Those are empirical/operational evidence still required before a production readiness claim.

## Evidence collection / final verdict

Evidence: `planning.test.ts`, persisted Decision Records, pipeline plan path, and the command results in [`evidence-bundle.md`](./evidence-bundle.md). **PASS / CLOSED** at the current executable code/test scope.
