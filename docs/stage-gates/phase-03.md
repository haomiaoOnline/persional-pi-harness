# Phase 3 Stage Gate — Worker Runtime

Final verdict: **PARTIAL / REOPENED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮没有 commit。

## Requirements / tasks

`T3.1` Worker Adapter、`T3.2` PI Worker/Role 注入、`T3.3` Result Contract、`T3.4` idempotency/effect journal、`T3.5` Work Receipt/No-op Receipt。

## Scope / implementation location

- Adapter/result contracts：`packages/personal-pi/src/worker.ts`、`src/result.ts:69-122`、`src/types.ts`。
- Effect persistence/idempotency：`src/effects.ts:19-99`。
- Pipeline admission and receipt acceptance：`src/pipeline.ts:362-528`、`src/verification.ts:197-232`。
- Tests: `test/worker.test.ts`, `test/effects-persistence.integration.test.ts`, `test/pipeline.test.ts`, `test/verification.test.ts`。

## Commands / expected / actual

```text
npm run test --workspace @personal-pi/core
expected: worker/result/effect/receipt tests pass
actual: 25 files, 142 tests passed

npm run build --workspace @personal-pi/core
expected: runtime contract compiles
actual: passed
```

## Static Validation

Core TypeScript build and `git diff --check` pass. The repository-wide known TypeScript error is outside the Personal PI Worker/Result surface.

## Failure injection

Malformed output, worker failure, missing idempotency key, action digest mismatch, false verification and successful-but-empty work were injected. The Work Receipt case with `status=success`, no artifact, `state_changed=false`, `no_op=false`, and no valid reason raises `work_receipt_anomaly`; `no_op=true` with a non-empty reason is accepted.

## Persistence / recovery evidence

Effect records are persisted as pending/committed/failed and a new journal reuses a committed effect without rerunning the action. Cross-Run Loop Budget and controller restart evidence is in Phases 1 and 5.

## Bound Coverage

Worker execution enters B1/B2 through `beforeRun`/`beforeModelCall`; verification commands enter B3; Recovery reassignment enters B4. Each has a Task-level persisted bound. Independent command failures remain missing evidence/UNKNOWN; they are never converted into PASS.

## Regression results

Worker, pipeline, verification, effects and full core regression pass. The local Phase 7 E2E launches three child-process tasks, not five production Worker tasks.

## Known upstream failures

Repository-wide static and coding-agent failures remain exactly as listed in the bundle. They are outside `packages/personal-pi` and were not skipped.

## Unresolved issues

The v3 task list asks T3.2 to demonstrate five real small tasks and Role boundary behavior. This audit has three real local child-process tasks in Phase 7 and unit/integration coverage, but no external Provider/production Worker evidence. Therefore this Phase cannot be closed at the strict architecture evidence level.

## Evidence collection / final verdict

Evidence is the core test output plus receipt/effect/rejection assertions. **PARTIAL / REOPENED** until five strict real-worker tasks and their independent evidence are captured.

## Closure update — 2026-09-14

The repository-level coding-agent differential and known-upstream gate are now
closed as described in Phase 0. The strict Phase 3 blocker is unchanged:
local Worker/Result/Receipt tests pass, but no authorized real Provider path
exists for the required five real Worker tasks. No mock or local synthetic
provider is promoted as real evidence. T3.2-A phased permission escalation is
tracked in [`v3.1-gap-matrix.md`](./v3.1-gap-matrix.md) and is not yet
implemented at this baseline.

## v3.1 delta update — 2026-09-15

`T3.2-A` is implemented in `packages/personal-pi/src/permission-phases.ts`.
The controller advances only `exploring → planning → acting`; Explore and Plan
deny writes, network, credentials, unknown/composed shell and mutating Git;
Act still delegates to the Task permission ceiling, and simple tasks have a
deterministic Act fast path. A denied non-Act request is explicitly retryable
only after an allowed phase advance. `permission-phases.test.ts` passes all
three cases, and B9 covers the bounded retry path.

This is a local contract test result, not the required real Worker evidence.
The strict five-task matrix remains **BLOCKED_EXTERNAL**: no authorized real
Provider/credential path is available, and the two native Worker attempts
stopped at the account usage limit before producing usable evidence. **Phase 3
remains PARTIAL / REOPENED**.
