# Phase 8 Stage Gate — Graph Intelligence

Final verdict: **PASS / CLOSED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮未创建 commit。

## Requirements / tasks

`T8.1` Dynamic Decomposition、`T8.2` Dependency Resolver、`T8.3` Artifact Dependency、`T8.4` Decomposition/Coordination Budgets。

## Scope / implementation location

- Decomposer and persistent budget: `packages/personal-pi/src/graph-intelligence.ts:90-320`。
- Graph types/store: `src/types.ts` and `src/persistence.ts`.
- Tests: `test/graph-intelligence.test.ts` and `test/loop-budget.integration.test.ts:154-187`.

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/graph-intelligence.test.ts test/loop-budget.integration.test.ts
expected: DAG, dependency, artifact and decomposition budgets pass
actual: targeted graph/loop/recovery/effect run passed 4 files/20 tests;
the v3 run and full core run also passed
```

## Static Validation

Core TypeScript build and entry-graph checks pass. Persistent budget state is part of the typed state schema; no free graph-cycle path was added.

## Failure injection

Invalid child contracts, dependency not ready, artifact mismatch, depth/children/open-task limits and a second replan after `max_replan_count=1` are rejected. The restarted `BudgetController` reads persisted usage and records a DENY decision rather than allowing another replan.

## Persistence / recovery evidence

`budget_usage[scope]` and `budget_decisions[scope]` are persisted through `PersistentStateStore`. `DynamicDecomposer.replan` requires a persistent controller; a new controller instance sees the previous replan count and throws `BudgetExceededError`.

## Bound Coverage

Graph re-entry is B5. The decomposition budget is separate from Task `loop_budget` but both are deterministic and persisted at their appropriate scope. No graph cycle or free-form replan is accepted.

## Regression results

Graph, loop-budget integration, full core tests and build pass. Existing DAG and dependency behavior is preserved.

## Known upstream failures

The full repository continues to report the exact inherited AI TypeScript error and coding-agent PPH migration/runtime failures; no graph test masks them.

## Unresolved issues

No open Personal PI graph code defect was found. A production-scale graph efficiency sample is recorded in Phase 11, but broader workload calibration remains future work.

## Evidence collection / final verdict

Evidence: graph tests, persistent replan test, DENY record and source locations above. **PASS / CLOSED**.
