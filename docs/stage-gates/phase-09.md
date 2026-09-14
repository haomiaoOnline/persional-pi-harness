# Phase 9 Stage Gate — Recovery

Final verdict: **PASS / CLOSED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮未创建 commit。

## Requirements / tasks

`T9.1–T9.4` Timeout、Retry、Resume、Reassign；统一冻结/验现场/下结论流程，配合 fencing token，连续失败后 BLOCKED。

## Scope / implementation location

- Recovery state machine and admission: `packages/personal-pi/src/recovery.ts:68-174`。
- Persistent crash recovery: `src/persistence.ts:363-404`。
- Lease fencing: `src/lease.ts:20-47`。
- Tests: `test/recovery.test.ts` and `test/loop-budget.integration.test.ts:104-145`。

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/recovery.test.ts test/loop-budget.integration.test.ts
expected: timeout/crash/malformed/wrong-result branches and bounds pass
actual: targeted run passed; full core 25 files/142 tests passed
```

## Static Validation

Core build, protocol isolation and import checks pass. Recovery additions remain within the Personal PI layer and do not alter unrelated upstream packages.

## Failure injection

All four required faults were exercised: `timeout`, `crash`, `malformed_output`, and `wrong_result`. The test checks correct terminal Run status, Decision Record, retry/resume/reassign choice, stale result rejection, and second failure escalation to BLOCKED. Reassign with `max_handoffs=0` is blocked before a replacement lease is acquired.

## Persistence / recovery evidence

Run attempt numbers, Task audit transitions, lease epochs and loop usage survive through the Persistent State store. A missing Worker after restart removes the active lease and blocks the Task; late output is not accepted. Phase 5 provides process-level evidence.

## Bound Coverage

Recovery retry is B1/B7; reassign is B4; all new Run or handoff admissions pass the relevant Loop Budget gate. There is no third automatic retry after the configured recovery limit.

## Regression results

Recovery unit/integration tests, core tests, build and Personal PI regression pass.

## Known upstream failures

The exact repository-wide AI TypeScript error and coding-agent `pi`/`pph`, path, remote-session and fswatch failures remain Phase 0 findings and are not hidden here.

## Unresolved issues

No open recovery defect was found in the current core. Host-level failover and a real external Worker crash are not claimed beyond the local process restart evidence.

## Evidence collection / final verdict

Evidence: four fault-injection branches, persisted Decision Records, lease assertions and restart test. **PASS / CLOSED**.
