# Personal PI Harness — Self-Hosting Readiness Engineering Log

Date: 2026-09-16

Decision: **SELF_HOSTING_READY**

## 1. Boundary and baseline

- Branch: `feature/t1-task-contract`
- HEAD: `4553b93981004b2683ff58ca2088910e0e1cd4f4`
- Baseline tag object: `b0596147e59e9284d05857bdc8935cffe7a005bf`
- Baseline tree: `f85676dc8a88d757c3534f3ec0fd8f46fb284b36`
- Start status: clean; stash: empty
- `origin/feature/t1-task-contract`: `71b3e44297d20b43faf31a677c2f5224a9e57481`
- `origin/main`: `71b3e44297d20b43faf31a677c2f5224a9e57481`
- Divergence for both refs: current branch ahead 35 / behind 0; raw `--left-right` count is `35 0`
- Upstream tracking: none configured

The Phase 12–15 gate/evidence SHA-256 values and historical T5.4 digest are in `baseline_attestation` in the JSON artifact. The historical snapshot does not bind to the current baseline, so the checkpoint created a new bound snapshot.

## 2. Execution policy

- Data class: synthetic public conformance only
- Provider allowlist: local-only
- Provider route: local process Worker
- Network: denied
- Credentials: denied
- Scope: one low-risk test file per disposable worktree
- Worker mode: single Worker, cheap tier, low reasoning depth
- No CLI discovery, Multi-CLI, Product Shell, or new Multi-CRI work
- No baseline-branch writes from either Worker

The existing PPH `PersonalPiPipeline` was used. No alternate orchestration path was introduced.

## 3. Successful self-development

- Task ID: `self-hosting-readiness-success-20260916`
- Task Contract digest: `944d0ff3c25781a75afa2407de473887f4d0ee317c27aca4c1c860af7baa80d2`
- Assessment/policy digest: `e2880ad9803dae12d2e0eff83cd486fa83b5afe49bcd820203b8c1a9f7898f84`
- Run ID: `29518e96-7ba6-4ad4-a690-fe8fd9403ed9`; lease epoch: `1`
- Worker ID / instance: `self-hosting-success-worker` / `self-hosting-success-worker-instance`
- Worker session digest: `4e6167bbe79bb376`
- Result digest: `ebf8909cd99f26606d550c24799223b9833530e869ef64ed742262f5e04f7621`
- Work Receipt digest: `c9c72713f35e755b15fffd71d7f4df665079e14079fa400d0d05578f8741a095`
- Evidence ID / digest: `a3e59b5f-7690-4a8d-b22b-8299785c4ffb` / `8007e74fc2d1156dd3665cd3fce82f767c1e8e5665086941db26c518dd0a6699`
- Verification ID / digest: `e4e582ee-2ff2-4fa3-9c87-4644459895a6` / `05aa2acb8f6be49580fd3ce302f6af12f4474be7ceab04cd7bbd855e57cf7dec`
- Trace ID / digest: `9b294109-1192-4d8b-9155-4dbc6afcc912` / `0c91de7119afc707d95f0c1fff8943de0dcf5ad8c376539a3a3e997c6a4c866f`
- Result: `success`; effects: `1`; Verification: `PASS/strong`; Acceptance: `true`
- Target: `packages/personal-pi/test/self-hosting-readiness-success.test.ts`
- Patch SHA-256: `4b9086d6419cb6e5f5b267cacc8277cf9b3dda1b220e368d05ff20a8fd7c2fdc`
- Cleanup: `worktree_removed=true`, `worktree_list_contains_path=false`, `parent_removed=true`

## 4. Deliberate failure and rollback

- Task ID: `self-hosting-readiness-failure-20260916`
- Task Contract digest: `917e9d944d0a8d126e1895edef288691a7dce80b8564283c36bc32319729613d`
- Assessment/policy digest: `b173d40306feef821713dca536bf62e93d4230a692639a79f758502bd8867194`
- Run ID: `4c46d04b-a807-48a1-bf07-a636cbca8650`; lease epoch: `1`
- Worker ID / instance: `self-hosting-failure-worker` / `self-hosting-failure-worker-instance`
- Worker session digest: `60362753c2a6929c`
- Result digest: `61230696f86b20a64584667bbe12bfe0d94c2040fedd9a38cad46fa0fba7019e`
- Work Receipt digest: `8c54c3050b5500933dcaa2fc813cdac0d16ae480b09bf8088000f47e3580f717`
- Evidence ID / digest: `d91ccc47-5cad-4330-ae70-3f9c4af3abbf` / `bfb535f93b1bf796c48bffadcada85bb066c9ec328b45f13ee7c657fc709e478`
- Verification ID / digest: `1ed4e076-f303-4b17-9b7a-2d264af8893b` / `7faad5002ceeeb01ecf32fdd6fb29e99062805dd4fe85f79517f0d5e41eb87bf`
- Trace ID / digest: `1a375303-3e13-442c-8a54-dd37408dea24` / `1396406ce3942a30b062240643e61e7c385ea31f7aa5c72a23e6e0c4cd3e512b`
- Result: `success`; independent command exit: `1`; Verification: `FAIL`; persisted task: `FAILED`; Acceptance: `verification is FAIL, not PASS`
- Target: `packages/personal-pi/test/self-hosting-readiness-failure.test.ts`
- Patch SHA-256: `98b1214fdae1021ef70d3f815b5b4941404f46f78b7a4816c1527f880f549e8a`
- Cleanup: `worktree_removed=true`, `worktree_list_contains_path=false`, `parent_removed=true`

## 5. T5.4 snapshot / restore checkpoint

- Implementation: `PersistentStateStore.createSnapshot + restoreSnapshotFromStore`
- Snapshot ID: `670ce751-e5c0-4566-80c2-736d99cfc3ae`
- Snapshot digest: `f34a9002b94d2095811f056e3d6955ec02857fb77634fbc9576c87295a231d36`
- Baseline commit/tree binding: `4553b93981004b2683ff58ca2088910e0e1cd4f4` / `f85676dc8a88d757c3534f3ec0fd8f46fb284b36`
- Readback matches: `true`
- Pre-restore digest: `f34a9002b94d2095811f056e3d6955ec02857fb77634fbc9576c87295a231d36`
- Mutated digest: `9e65b9a8f454a177d5b62286dc8079f41e1f65dd1b23a88c8a9cf5b8240e27ca`
- Restored digest: `f34a9002b94d2095811f056e3d6955ec02857fb77634fbc9576c87295a231d36`
- Restore verified: `true`
- Digest mismatch rejected: `true`
- Mismatch reason: `snapshot digest mismatch`
- Post-reject digest: `f34a9002b94d2095811f056e3d6955ec02857fb77634fbc9576c87295a231d36`

## 6. Verification record

| Check | Result |
| --- | --- |
| focused self-development/control-plane tests | PASS — 5 files / 35 tests |
| Personal PI core full test | PASS — 39 files / 209 tests |
| Personal PI regression | PASS — 3 files / 23 tests |
| repository script tests | PASS — 29 / 29 |
| Personal PI core build | PASS |
| protocol isolation | PASS |
| dependency/entry/boundary checks | PASS |
| git diff --check before artifact delivery | PASS |
| inherited google-shared TS2322 | retained exact known upstream failure |
| process-worker Biome warnings | retained exact two existing warnings |

No `--no-verify`, broad lint bypass, source cleanup, or known-upstream repair was used.

## 7. Final boundary

Only the requested stage-gate artifacts and optional sanitized success patch are intended to persist. The baseline branch/tag was not committed, pushed, merged, or retagged. Final decision: **SELF_HOSTING_READY**.
