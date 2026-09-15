# Phase 4 Stage Gate — Verification

Final verdict: **PASS / CLOSED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；审计补丁保持未提交。

## Requirements / tasks

`T4.1` Evidence System、`T4.2` Verification Engine、`T4.2-A` Verifier Context Isolation、`T4.3` Acceptance Gate、`T4.4` revision binding/TOCTOU、`T4.5` Verification Recipe。

## Scope / implementation location

- Evidence and command result: `packages/personal-pi/src/evidence.ts`、`src/pipeline.ts:399-469`。
- Verifier whitelist: `src/verification.ts:65-103` (`buildVerifierInput`, `sanitizeResultForVerification`)。
- Acceptance/revision/receipt gate: `src/verification.ts:197-232`。
- Tests: `test/verification.test.ts`、`test/verifier-isolation.integration.test.ts`。

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/verifier-isolation.integration.test.ts test/verification.test.ts
expected: deterministic verification and isolation pass
actual: included in targeted v3 run (6 files/19 tests) and full core run (25/142)
```

## Static Validation

Core build and protocol metadata isolation pass. Verifier input construction is a typed whitelist and the pipeline no longer passes the raw Worker result to the verifier.

## Failure injection

The Worker emits a convincing but false explanation while the deterministic command exits 1. Verification remains `FAIL`; the explanation is absent from the verifier DTO. Removing the explanation produces the same `FAIL` reasons. A successful result with no observable work is blocked as `work_receipt_anomaly`; a valid no-op is allowed only with a reason.

## Persistence / recovery evidence

Command evidence is collected before verification and persisted in the Evidence Record. Pipeline verification consumes the persisted evidence (`commandRunner: undefined` at that boundary), so a Worker cannot self-report an independent command. Verification and Decision Records are persisted for replay.

## Bound Coverage

Verifier failure feeds B1 only through explicit Recovery; it cannot silently re-enter Worker. Repeated command checks are B3 and pass through `beforeToolCall`. Missing or failing command evidence yields UNKNOWN/FAIL rather than an unbounded or falsely green loop.

## Regression results

Verifier isolation, acceptance, revision, recipe, pipeline and full core tests pass. `npm run check:protocol-isolation` also passes.

## Known upstream failures

The inherited `google-shared.ts:402` error and coding-agent PPH migration/runtime failures remain repository-level Phase 0 findings. They are not suppressed by verification tests.

## Unresolved issues

No open Personal PI Phase 4 code defect was found. Operational evidence from a live external Provider is outside this package gate and remains disclosed in the aggregate report.

## Evidence collection / final verdict

The verifier metamorphic test, Work Receipt acceptance test, persisted command evidence and exact source locations are the evidence. **PASS / CLOSED**.

## v3.1 delta update — 2026-09-15

`T4.2-B` is implemented in `packages/personal-pi/src/lifecycle-hooks.ts` and
is integrated around pipeline verification commands. Only deterministic
`script` and `static_check` hooks can register. `on_start`, `pre_tool_use`,
`post_tool_use` and `on_cwd_change` are covered; pre-tool failures block the
current call, cwd changes reload scoped rules, and a missing post-tool checker
emits warning plus Evidence while allowing the Run to continue. Command risk
classification is supplied to `pre_tool_use`, and post-tool checks receive
changed-file context. `lifecycle-hooks.test.ts` and
`v3.1-pipeline-controls.test.ts` pass. B10 binds a later retry to the existing
tool budget. **PASS / CLOSED for local implementation/evidence scope**.
