# Phase 1 Stage Gate — Task Contract 与可靠性不变量

Final verdict: **PASS / CLOSED**（Personal PI core scope）
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；working-tree audit patch，未创建 commit。

## Requirements / tasks

`T1.1`、`T1.1-A`、`T1.1-B`、`T1.2`、`T1.3`、`T1.3-A`、`T1.3-B`、`T1.4`、`T1.5`、`T1.6`：完整 Task Contract/DoR、状态机、DAG 与原子 mutation、artifact handoff、lease fencing、protocol metadata isolation、Loop Budget、Bound Coverage Audit。

## Scope / implementation location

- Schema and budget fields：`packages/personal-pi/src/types.ts:104-190`。
- Loop executor：`src/loop-budget.ts:45-145`；persistent state usage is in `src/persistence.ts:227-261`。
- Lease/fencing：`src/lease.ts:4-58`。
- Contract/DoR/state/DAG tests：`test/task-contract.test.ts`。
- v3 integration and bound audit：`test/loop-budget.integration.test.ts:32-193`。

## Commands / expected / actual

```text
npm run test --workspace @personal-pi/core
expected: contract and reliability tests pass
actual: 25 files, 142 tests passed

npm run build --workspace @personal-pi/core
expected: typed core builds
actual: passed

npm run check:protocol-isolation --workspace @personal-pi/core
expected: protocol fields do not leak into prompt metadata
actual: protocol metadata isolation: PASS
```

## Static Validation

Personal PI TypeScript build and protocol metadata isolation pass. The full repository check reaches the known upstream TypeScript error only after all earlier static checks pass.

## Failure injection

The tests reject missing required contract fields, invalid state transitions, graph cycles, broken artifact handoff, stale lease epochs, missing loop budgets, model/tool/handoff admission after exhaustion, and uncovered active feedback paths. The Work Receipt anomaly test is retained in Phase 4 because it is attached to Acceptance Gate semantics.

## Persistence / recovery evidence

`loop_usage` is written through `PersistentStateStore` and rehydrated by a new `LoopBudgetController`. The cross-Run retry test reaches attempts=2, then the next `beforeRun` throws `LoopBudgetExhaustedError`. Controller SIGKILL/restart retention is independently verified in Phase 5.

## Bound Coverage

`auditBoundCoverage(V3_FEEDBACK_PATHS)` returns `passed=true` and `uncovered_paths=[]`. The detailed Feedback Path → Deterministic Bound → Runtime Enforcement → Persistence → Exhaustion → Test matrix is [`bound-coverage.md`](./bound-coverage.md).

## Regression results

Core test, build, protocol isolation, scripts and Personal PI regression pass. No broad skip, `|| true`, test deletion, or `--no-verify` was used.

## Known upstream failures

The repository-wide `google-shared.ts:402` TypeScript error and coding-agent PPH/rebrand/runtime failures remain outside this package and are recorded in [`evidence-bundle.md`](./evidence-bundle.md). They do not invalidate the core Phase 1 test result, but they keep Phase 0 open.

## Unresolved issues

The audit is closed only for the implemented Personal PI core. New feedback paths introduced by future phases must be added before activation; Phase 12 handoff is not a license to bypass `max_handoffs`.

## Evidence collection / final verdict

Evidence: task-contract tests, loop-budget integration, source locations above, and the aggregate bundle. **PASS / CLOSED** for this Phase’s Personal PI scope.
