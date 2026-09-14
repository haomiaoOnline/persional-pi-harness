# Phase 7 Stage Gate — 第一个完整闭环

Final verdict: **PARTIAL / REOPENED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；审计补丁未提交。

## Requirements / tasks

`T7.1` End-to-End、`T7.2` Self-Development、`T7.3` Trigger Gateway、`T7.4` Demonstration-based Routine Capture。闭环目标是 Requirement→Contract→DoR→Assessment→Dispatch→Context→Worker→Result/Work Receipt→Evidence→Independent Verification→Persistent State→DONE，并可由 Trace 反向重建。

## Scope / implementation location

- Full orchestration: `packages/personal-pi/src/pipeline.ts:192-543`。
- Real local process drivers: `scripts/local-e2e-worker.mjs`, `scripts/local-e2e-verifier.mjs`。
- E2E test: `test/phase-7-real-e2e.test.ts:114-151`。
- Trigger/routine and existing pipeline tests: `test/triggers-routines.test.ts`, `test/pipeline.test.ts`。

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/phase-7-real-e2e.test.ts test/triggers-routines.test.ts test/pipeline.test.ts
expected: three complete independent-verification E2E paths and trigger receipt behavior pass
actual: included in targeted v3 run; all assertions passed
```

## Static Validation

Core build and protocol isolation pass; the local E2 scripts are executable Node drivers and are not imported as production package runtime dependencies.

## Failure injection

Each local Worker is a child process that writes a distinct markdown, JSON or report artifact; a separate child process verifies it. Pipeline command evidence is persisted and required by the verifier. Existing pipeline tests inject Worker failure, invalid/empty work and verification rejection; the result is FAILED or BLOCKED rather than false DONE.

## Persistence / recovery evidence

The E2E state file contains three DONE Tasks, three Runs, three Evidence Records, three Verification Records and three replayable Traces. Phase 5 proves the same control plane survives SIGKILL/restart. Trigger tests verify a trigger creates a Task and cannot directly invoke a Worker.

## Bound Coverage

The E2E can enter B1 only through explicit Recovery; tool commands are B3; no automatic `INSUFFICIENT_CONTEXT` loop is enabled (B6). `auditBoundCoverage` passes with no uncovered active path.

## Regression results

The three local process tasks pass independent verification and trace replay. Full Personal PI core tests pass. This is real local process evidence (E2), not an external Provider or production repository claim.

## Known upstream failures

The exact repository-level `google-shared.ts:402` type error and coding-agent PPH rebrand/remote/fswatch failures remain open. They are not part of this local E2E process and were not skipped.

## Unresolved issues

Strict task-list evidence still lacks a real five-task T3.2 run, a T7.2 self-development run that changes and re-verifies the project itself, and a longer always-on/routine capture run. These gaps require reopening this Phase despite the three-task local E2E passing.

## Evidence collection / final verdict

Evidence is the child-process artifacts, independent verifier exits, persisted state counts and trace replay assertions. **PARTIAL / REOPENED** pending the strict real-worker/self-development evidence.
