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

## Closure update — 2026-09-14

Phase 0's 76 PPH-only differential failures are no longer a blocker; the
exact coding-agent suite and commit gate are recorded in the Phase 0 evidence.
Phase 7 remains **PARTIAL / REOPENED** because the available evidence is three
local child-process E2 paths. A real self-development run that changes and
re-verifies this project, plus strict real Provider/Worker and long-running
Trigger/Routine evidence, is still unavailable. T7.5 Background Memory
Consolidation is a v3.1 delta and is not started at this baseline.

## v3.1 delta update — 2026-09-15

`T7.5` is implemented in `packages/personal-pi/src/memory-consolidation.ts`.
It reuses `TriggerGateway` and the Task/Run/Result/Work Receipt identity
checks, summarizes completed work into bounded hot memory, archives raw
Evidence through an in-memory or file cold archive without deletion, records
token/context deltas, and treats duplicate content as a deterministic
`NO_OP`. Both webhook and controlled scheduled paths are tested, including a
schedule miss that creates no Task and a retry that remains a no-op. The
controlled local cycle passes all four `memory-consolidation.test.ts` tests;
B11 covers schedule/retry exhaustion.

This is E2/local control-plane evidence, not a claim of a production
background service. The required T7.2 disposable self-development run,
real-provider Worker pipeline and long-running Trigger/Routine cycle remain
unavailable. **Phase 7 remains PARTIAL / REOPENED**.

## External Evidence Closure update — 2026-09-15

Phase 3's real Worker hard gate remained unsatisfied after the capability and
auth inventory. Consequently this round created no disposable self-development
worktree, made no self-change, and ran no real Provider E2E or accelerated
Trigger/Routine cycle. The three existing child-process paths remain explicitly
E2/local evidence. **Phase 7 remains BLOCKED_EXTERNAL / PARTIAL / REOPENED.**

The exact prerequisite and release conditions are in
[`evidence/external-worker-inventory-2026-09-15.md`](./evidence/external-worker-inventory-2026-09-15.md).

## Real Provider / self-development update — 2026-09-15

After the Type A Phase 3 gate, the committed runner
`packages/personal-pi/scripts/phase-7-real-worker.mjs` executed the real
`PI Agent + opencodex + ArkCoding/deepseek-v4-flash-ga-260731` route using only
synthetic/public conformance input. The run is bound to
`3567eb29ce0753a864510ad707fafbe615cd4e4c`; full sanitized records are in
[`evidence/phase-07-real-worker-2026-09-15.json`](./evidence/phase-07-real-worker-2026-09-15.json).

### T7.1 real Provider E2E

Three independent pipeline executions reached `DONE` with `PASS/strong`
verification. The first initial attempt was intentionally retained as a real
malformed-Result failure (`unsupported fields: evidence_refs`); its one
declared follow-up produced a valid `PHASE7_PROVIDER_E2E_FOLLOW_UP` result.
The other two initial attempts passed. Final conformance is `3/3`, with no
unbounded retry or provider expansion.

### T7.2 disposable self-development

One real Worker write was permitted, and only in a detached disposable
worktree: `packages/personal-pi/test/self-development-marker.test.ts`. The
new marker test passed through targeted Vitest; the Controller then continued
to dispatch the following real trigger task. The sanitized patch is retained
at [`evidence/phase-07-self-development-2026-09-15.patch`](./evidence/phase-07-self-development-2026-09-15.patch), SHA-256
`6a0f9d0b5eea1904298c2d2943828b0080c3bdb2fc585422d416c95031f3e8c6`. The
worktree was removed after capture and the patch was not applied to this
branch.

### T7.3 / T7.4 / T7.5 accelerated cycle

`TriggerGateway.createFromSchedule` created one task at controlled timestamp
`2040-01-01T08:07:00.000Z`; replaying the same schedule produced
`duplicate idempotency_key` and no second task. That triggered task then went
through the real Type A Worker pipeline to `DONE`/`PASS`. `RoutineCapture`
captured and reused a topic parameter in memory with the explicit approval
flag required by its contract. `MemoryConsolidator` archived one raw Evidence
record, produced a compact record with token delta `44`, and the same schedule
retry returned legal `NO_OP`. This is controlled accelerated-time and
production-equivalent trigger logic, not a claim that an always-on production
service was deployed; no production Playbook was persisted.

The updated bounded result is **`PASS_REAL_TYPE_A_BOUNDED`**. Phase 7 remains
not a T13 promotion decision because Type B and the repository-level inherited
gate are still unresolved.
