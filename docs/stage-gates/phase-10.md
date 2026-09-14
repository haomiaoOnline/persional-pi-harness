# Phase 10 Stage Gate — 安全与权限

Final verdict: **PASS / CLOSED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮未创建 commit。

## Requirements / tasks

`T10.1` Permission Contract、`T10.2` Least Privilege、`T10.3` sensitive information boundary and Role Profile permission upper bound。

## Scope / implementation location

权限类型和协议边界在 `packages/personal-pi/src/types.ts`；执行权限检查在 `src/permissions.ts`、`src/worker.ts` 和 `src/pipeline.ts`；验证在 `packages/personal-pi/test/security.test.ts`。

## Commands / expected / actual

```text
npm exec --workspace @personal-pi/core vitest -- run test/security.test.ts
expected: filesystem/shell/network/credential/role boundary tests pass
actual: included in the 25-file/142-test core pass
```

## Static Validation

Core build and protocol metadata isolation pass. No credential value is present in the changed source, tests, or audit artifacts.

## Failure injection

The suite attempts filesystem/shell/network/credential overreach, sensitive context exposure and a Task permission request exceeding its Role Profile. Expected result is DENIED/blocked with a recorded reason; actual assertions pass.

## Persistence / recovery evidence

Permission declarations and Decision Records remain part of the persisted Task/control-plane evidence. No credential value, token or secret was printed, copied or committed during the audit.

## Bound Coverage

Security rejection does not create a retry loop by itself. If recovery is explicitly requested after a denied Worker result, it enters B1 and must pass the persisted Task Loop Budget; no model explanation can widen permissions or terminate the gate.

## Regression results

Security tests, protocol isolation, full core tests and build pass.

## Known upstream failures

Repository-wide `google-shared.ts:402` and coding-agent PPH migration/runtime fingerprints remain open and are not masked by security tests.

## Unresolved issues

No open Personal PI security test defect was found. A production secret-manager integration is not claimed; the current evidence proves the contract and local boundary behavior.

## Evidence collection / final verdict

Evidence: `security.test.ts`, protocol isolation result, unchanged secret handling policy and core regression. **PASS / CLOSED**.
