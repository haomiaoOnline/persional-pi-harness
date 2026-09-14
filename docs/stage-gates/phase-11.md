# Phase 11 Stage Gate — Trace / Audit / Eval

Final verdict: **PASS / CLOSED**（local E2 baseline scope）
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮未创建 commit。

## Requirements / tasks

`T11.1–T11.3` Execution Trace、Decision Record、Regression Dataset；`T11.4` token/cache metrics；`T11.4-A` Graph Efficiency Metrics；`T11.5` Single-Agent baseline；`T11.6` Eval Isolation。

## Scope / implementation location

- Trace recorder, replay and derived metrics: `packages/personal-pi/src/trace.ts:62-198, 211-219, 412-464`。
- Pipeline writes computed metrics after finishing the trace: `src/pipeline.ts:535-543`。
- Types: `src/types.ts:370-382`。
- Tests: `test/trace.test.ts`, `test/phase-7-real-e2e.test.ts`, `test/single-vs-multi.eval.test.ts`。

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/trace.test.ts test/phase-7-real-e2e.test.ts \
  test/single-vs-multi.eval.test.ts
expected: trace replay, metric derivation, eval isolation and baseline pass
actual: targeted v3 run passed 6 files/19 tests; full core 25/142 passed
```

## Static Validation

Core build, trace type checks and browser smoke pass. Metric values are derived from Trace events and are not accepted from a free-form Worker explanation.

## Failure injection

Trace tests inject graph width/depth, active workers, retry, result useful/no-op, verification and cost/time fields, then assert the derived values. The v3 metric implementation does not rely solely on an interface: `computeGraphEfficiencyMetrics` reads events and `summarizeGraphEfficiency` aggregates stored metrics. Eval tests ensure held-out data is excluded.

## Persistence / recovery evidence

Pipeline persists the completed Trace, Evidence and Decision Records. Phase 7 proves three persisted traces can be replayed; Phase 5 proves the state container survives restart.

## Bound Coverage

Metrics observe B1–B8 but do not act as a termination mechanism. Their calculation cannot substitute for Loop Budget or decomposition budget; no metric result can authorize a new Worker/handoff.

## Regression results

Trace exact derivation, 15-task Single-Agent stability, graph brief, E2E trace replay and Single-vs-Multi tests pass. The current local baseline is:

| Metric | Single | Multi |
| --- | ---: | ---: |
| verified success rate | 1.0 | 1.0 |
| time per verified task (ms) | 75.45468066666666 | 44.99808333333332 |
| cost per verified task (USD) | 0 | 0 |
| handoffs / retries | 0 / 0 | 0 / 0 |
| verification first-pass rate | 1.0 | 1.0 |
| coordination efficiency | 1.0 | 1.0 |

Multi has graph width/peak active workers 2 versus 1 in Single. This three-task local sample is a policy observation, not a general superiority claim.

## Known upstream failures

The exact `google-shared.ts:402` TypeScript error and coding-agent PPH/rebrand/runtime fingerprints remain open. They do not affect the Personal PI metric tests but keep the repository release gate open.

## Unresolved issues

The required larger same-task/tool/permission/budget benchmark with real allowed Providers/Workers is not yet available. Cost is zero because the sample uses local processes; provider pricing, quota and real coordination cost remain unmeasured.

## Evidence collection / final verdict

Evidence: event-derived fields, trace replay, local three-task baseline and the full table in [`evidence-bundle.md`](./evidence-bundle.md). **PASS / CLOSED** for this local E2 evidence scope.
