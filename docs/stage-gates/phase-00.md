# Phase 0 Stage Gate — Fork 与工程基线

Final verdict: **PARTIAL / REOPENED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`（本轮未创建 commit）

## Requirements / tasks

`T0.1` Personal PI fork、upstream remote、分支和 baseline tag；`T0.2` upstream upgrade gate、双套件和失败即停止合并。唯一需求基线是 v3.0 架构设计与任务清单，不采用历史“已完成”标签。

## Scope / implementation location

- Git state：`feature/t1-task-contract`；`origin` 指向 Personal fork，`upstream` 保留 `earendil-works/pi`。
- Baseline tags：`personal-pi-baseline`=`3b5bc5c8d2a7c4a236264022d73cb9e59b9365bd`；`PERSONAL_PI_V0.1_CORE_V1.1`=`c0c24d6743e6d6ed17a085a42e0e107d8a1dd17e0`。
- SOP：`docs/upstream-upgrade-gate.md`；本轮 v3 文档和逐 Phase 证据位于 `docs/stage-gates/`。

## Commands / expected / actual

```text
git rev-parse HEAD
expected: stable auditable base
actual: 71b3e44297d20b43faf31a677c2f5224a9e57481

npm run check
expected: repository static gate passes
actual: all preliminary checks pass; stops at
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.

./test.sh
expected: upstream compatibility + Personal PI regression both pass
actual: Personal PI core passes; packages/coding-agent has 18 failed files
and 77 failed tests with exact PPH/rebrand/runtime fingerprints.
```

## Static Validation

`git diff --check` passes. Repository static checks pass through dependency, import, graph, lockfile and browser-smoke stages, then stop at the recorded `google-shared.ts:402` TypeScript error.

## Failure injection

The repository-wide failure itself is the upgrade-gate injection: a known upstream TypeScript mismatch and the existing coding-agent PPH migration expectations remain visible. Expected behavior is to stop promotion, not to skip, delete, or weaken tests. Actual behavior matches the stop rule; no merge or release action was taken.

## Persistence / recovery evidence

No destructive reset or remote write was performed. The working tree records the audit patch on top of the base SHA, so the original baseline remains recoverable. A commit is intentionally left for review rather than silently treated as a release artifact.

## Bound Coverage

The audit invokes the active P0-15 matrix in [`bound-coverage.md`](./bound-coverage.md). No Phase 0 path is allowed to promote a later phase without a deterministic bound. B1–B5 are machine-audited; B6–B8 are explicitly controlled boundaries.

## Regression results

`npm run test --workspace @personal-pi/core` passed 25 files/142 tests; this does not clear the repository-wide gate. `npm run check:protocol-isolation`, browser smoke, scripts and Personal PI regression also passed. The full root run remains non-green for the exact failures above.

## Known upstream failures

- `google-shared.ts:402` `FinishReason.TOO_MANY_TOOL_CALLS` exhaustive-switch type error.
- coding-agent session/CLI expectations still say `pi` while runtime says `pph`.
- coding-agent package/resource/trust tests still expect `.pi`/old paths.
- experimental remote tests report `Unknown session: demo-1` and `No discovered server contains session demo-1`.
- fswatch reports `no FSWatcher found among active handles`.

## Unresolved issues

The repository-level upgrade gate must be rerun and closed from a committed SHA after those inherited failures are resolved under their exact fingerprints. This is a P0 blocker for T13.

## Evidence collection / final verdict

Evidence is in [`evidence-bundle.md`](./evidence-bundle.md) and the aggregate report. **PARTIAL / REOPENED**.

## Closure update — 2026-09-14

The historical baseline above is preserved. The remaining PPH differential was
closed on `bfde9ffbe`: the original **76** PPH-only coding-agent failures were
all classified as expected `pi`/`.pi` versus `pph`/`.pph` identity fixture
drift, and the complete suite now passes (`266/273` files, `2239/2293`
tests). See [`evidence/phase-00-pph-identity-closure-2026-09-14.md`](./evidence/phase-00-pph-identity-closure-2026-09-14.md).

The inherited `google-shared.ts:402` TS2322 remains non-green in the normal
repository check, but it is now governed by the exact fail-closed
Known-Upstream-Failure gate. The gate verified the pinned source digest and
revision, reproduced the exact failure in a pristine archive checkout, and
passed PPH build/core tests/regression/protocol proofs. Phase 0 is therefore
**PASS for PPH differential closure under the explicit known-upstream gate**;
the normal check is not relabeled as green and no `--no-verify` exception is
used.

## v3.1 regression confirmation — 2026-09-15

The latest standalone isolated coding-agent run remains green at `266/273`
test files and `2239/2293` tests. The original differential inventory is
unchanged: all `76` PPH-only failures are expected `pi`/`.pi` → `pph`/`.pph`
identity-projection fixture drift; actual PPH regression is `0`, and the
differential has `0` unexplained PPH-only failures. The detailed file/count
classification is in [`evidence/v3.1-runtime-controls-2026-09-15.md`](./evidence/v3.1-runtime-controls-2026-09-15.md).

The normal `npm run check` still exposes the exact inherited
`packages/ai/src/api/google-shared.ts:402` TS2322. The pre-commit hook now
invokes the exact fail-closed Known-Upstream-Failure gate, which verifies the
pinned revision and source digest, reproduces the error in a pristine archive,
and requires PPH build/core/regression/protocol proofs before allowing the
commit. The gate tests are `6/6` and script tests are `29/29`; no v3.1 commit
used `--no-verify`.

The latest isolated root `./test.sh` remains non-green only because
`packages/client/test/unix.test.ts` cannot resolve the existing
`@earendil-works/pi-agent-core` package entry during workspace aggregation.
This is the same client entry-resolution baseline found in pristine upstream;
it was not skipped or changed. Current Phase 0 result: **PASS for PPH
differential and exact known-upstream gate; repository aggregate remains
PARTIAL / REOPENED**.
