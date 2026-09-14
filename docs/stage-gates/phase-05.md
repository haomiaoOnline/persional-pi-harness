# Phase 5 Stage Gate — Persistent Execution

Final verdict: **PASS / CLOSED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮未创建 commit。

## Requirements / tasks

`T5.1` Persistent Task Store、`T5.2` Run/Attempt persistence、`T5.3` Crash Recovery、`T5.4` Snapshot + Restore Drill、`T5.5` Control-Plane Reconstruction。

## Scope / implementation location

- State schema/load/atomic transactions: `packages/personal-pi/src/persistence.ts:28-190`。
- Snapshot/restore/recovery/reconstruction: `src/persistence.ts:289-417`。
- Persistent leases: `src/lease.ts:4-58`。
- Persistent effects: `src/effects.ts:19-99`。
- Process driver/test: `scripts/controller-process.mjs`; `test/controller-restart.integration.test.ts`; `test/effects-persistence.integration.test.ts`; `test/persistence.test.ts`.

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/controller-restart.integration.test.ts \
  test/effects-persistence.integration.test.ts test/persistence.test.ts
expected: kill/restart, restore, and idempotent effect tests pass
actual: included in targeted v3 run; all assertions passed
```

## Static Validation

Core TypeScript build, state schema compilation and lock/import checks pass. Snapshot digest and persistence changes introduce no repository static warning.

## Failure injection

`controller-process.mjs start` persists a RUNNING Task/Run, lease epoch 1, loop usage, committed Effect Journal record and full snapshot, then the test sends `SIGKILL`. A new process in `inspect` mode opens only the state file, reconstructs managers, checks the old lease before/after recovery, performs restore, and exits.

## Persistence / recovery evidence

Expected and observed: before recovery Run/Task are RUNNING; after recovery Run is CRASHED, Task is BLOCKED, lease is removed, stale result changes from accepted/current to rejected/unknown lease, effect remains committed, loop usage attempts=1, snapshot digest validates, restore returns the prior RUNNING state, and reconstructed snapshot IDs remain available. Effect restart separately proves the committed action is not rerun and digest mismatch is rejected.

## Bound Coverage

Crash/restart is B7; snapshot restore is B8. Loop usage, lease ownership/epoch history, effect records and snapshot payloads are persisted. Recovery never resets a Task budget to zero and never accepts a stale lease after the old lease is removed.

## Regression results

Controller restart, effects persistence, persistence unit tests, full core tests and build pass. The root `./test.sh` failure is confined to unrelated coding-agent tests and is not hidden.

## Known upstream failures

Exact known failures: `google-shared.ts:402` exhaustive-switch type error; coding-agent `pi` versus `pph`, `.pi` versus `.pph`, remote `demo-1`, and fswatch fingerprints. No Phase 5 code modifies or masks them.

## Unresolved issues

The test uses a local JSON Persistent State store and real process kill/restart; production database/host failover evidence is not claimed. Snapshot and controller reconstruction semantics are closed for the current core implementation.

## Evidence collection / final verdict

Evidence is the process-level integration test, state markers, digest checks, effect restart test and source locations above. **PASS / CLOSED**.
