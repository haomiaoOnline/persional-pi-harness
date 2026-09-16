# Personal PI Harness — Self-Hosting Readiness Gate

Date: 2026-09-16

Decision: **SELF_HOSTING_READY**

Baseline: `feature/t1-task-contract` at `4553b93981004b2683ff58ca2088910e0e1cd4f4`

Immutable reference: annotated tag `personal-pi-v3.2-phase15-baseline`

Tag object: `b0596147e59e9284d05857bdc8935cffe7a005bf`

Baseline tree: `f85676dc8a88d757c3534f3ec0fd8f46fb284b36`

## Scope

This checkpoint covers only Self-Hosting readiness. Product Shell, Multi-CLI discovery, and new Multi-CRI work did not start. The Phase 12–15 baseline tag was not modified. At checkpoint capture, no commit, push, merge, or tag operation had been performed.

## Gate results

| Requirement | Result | Evidence |
| --- | --- | --- |
| Baseline attestation | PASS | branch/HEAD/status/stash/tag/tree and origin divergence are in the JSON evidence |
| Successful self-development | PASS | Task `self-hosting-readiness-success-20260916`, Run `29518e96-7ba6-4ad4-a690-fe8fd9403ed9`, Worker Instance `self-hosting-success-worker-instance` |
| Independent Verification / Acceptance | PASS | Verification `PASS/strong`, task `DONE`, non-no-op effects=1 |
| Failure rollback | PASS | Task `self-hosting-readiness-failure-20260916`, Verification `FAIL`, Acceptance rejected: `verification is FAIL, not PASS` |
| Snapshot/readback | PASS | Snapshot `670ce751-e5c0-4566-80c2-736d99cfc3ae`, digest `f34a9002b94d2095811f056e3d6955ec02857fb77634fbc9576c87295a231d36` |
| Digest mismatch rejection | PASS | `snapshot digest mismatch`; post-reject digest equals restored digest |
| Regression/build/boundary | PASS | core 39 files/209 tests, Personal PI regression 3 files/23 tests, scripts 29/29, build and boundary checks |
| Known debt handling | PASS | inherited TS2322 and two process-worker warnings retained exactly |

## Successful self-development chain

PPH `PersonalPiPipeline` created the Task Contract, ran plan gate and assessment, selected `SINGLE_WORKER/cheap/low`, leased a local process Worker, and executed one write only in a detached disposable worktree.

Target: `packages/personal-pi/test/self-hosting-readiness-success.test.ts`

The independent Vitest process exited 0. Result, Work Receipt, Evidence, Verification, trace, task state, and digests are recorded in the machine-readable artifact.

Cleanup evidence: `worktree_removed=true`, `worktree_list_contains_path=false`, `parent_removed=true`.

The patch was not applied to the baseline. A sanitized copy is retained at `evidence/self-hosting-readiness-success-2026-09-16.patch`.

## Failure and rollback chain

The second PPH Task Contract wrote a deliberately failing isolation test in a separate disposable worktree. The Worker Result was `success` with a non-no-op Work Receipt, but independent Vitest exited 1.

The pipeline recorded Verification `FAIL`, persisted the task as `FAILED`, and did not mark it `DONE`. An explicit Acceptance probe rejected it with `verification is FAIL, not PASS`.

Failure cleanup: `worktree_removed=true`, `worktree_list_contains_path=false`, `parent_removed=true`.

## Snapshot / restore

The historical T5.4 artifact is retained for reference but has no current baseline commit/tree binding. A new checkpoint snapshot was created, read back from persistent state, mutated, restored, and challenged with a tampered digest. Readback, restore equality, and digest mismatch rejection all passed.

## Regression boundary

- Focused self-development/control-plane tests: 5 files, 35 tests.
- Personal PI core: 39 files, 209 tests.
- Personal PI regression: 3 files, 23 tests.
- Repository scripts: 29/29.
- Personal PI build, protocol isolation, dependency/entry/boundary checks, browser smoke, and `git diff --check`: PASS.

The inherited `packages/ai/src/api/google-shared.ts:402` TS2322 remains untouched. The two existing `process-worker.ts` Biome warnings remain untouched. The full root `check` was not invoked because its `biome --write` step mutates the checkout; its required read-only portions were run separately.

## Delivery status

The checkout was clean before the drills and remained at the baseline commit/tree after both drills. At checkpoint capture, the requested evidence files and optional patch were uncommitted; this closeout archives only those four declared artifacts. No source or baseline files are changed.

## Closeout status and operator handoff

This is the current scope boundary after Phase 15 and Self-Hosting Readiness:

- Phase 12: `PASS`; Phase 13 T13.4 Aggregate Gate: `PASS`; P0 Multi-Worker MVP: `PASS`; Phase 14 Level-C Multi-CRI: `PASS`; Phase 15 Adaptive Policy: `PASS`; Self-Hosting Readiness: `SELF_HOSTING_READY`.
- Frozen baseline: annotated `personal-pi-v3.2-phase15-baseline` -> `4553b93981004b2683ff58ca2088910e0e1cd4f4`. Closeout tag: `personal-pi-v3.2-self-hosting-ready` (local annotated tag on the closeout commit).
- Existing Multi-Agent/Multi-Worker capability remains supported. Multi-CLI discovery and new Multi-CRI work are frozen; Product Shell, UI, and new CLI work are not in scope.
- Known issues retained: `packages/ai/src/api/google-shared.ts:402` inherited `TS2322` (`FinishReason.TOO_MANY_TOOL_CALLS` is not assignable to `never`); two existing Biome warnings in `packages/personal-pi/src/process-worker.ts`; Codex `GAP-01` and Agy `GAP-03`, both `OPEN_NON_BLOCKING`.
- Phase 15 learned routing is advisory only. `RoutingRuleGuard` is the hard boundary; learned suggestions cannot change Task truth, permissions, Verification strength, Loop Budget, or Persistent State.
- Every future change follows: Task Contract -> isolated disposable worktree -> Result/Work Receipt/Evidence -> independent Verification -> Acceptance. Failure remains fail-closed; do not bypass Verification, Approval, Loop Budget, or Persistent State.

## Minimal operator runbook: direct PPH adaptive tuning

There is no generic operator CLI that accepts a Task Contract, lists runs, or performs arbitrary adaptive tuning. The smallest real path is host code calling the exported Personal PI API. The phase scripts below are fixed evidence runners, not a general task interface.

### A. Submit a self-development or tuning Task

1. Use [`task-contract.valid.json`](../../packages/personal-pi/examples/task-contract.valid.json) as the field template. For a self-development task, set the exact `scope.files`, filesystem write scope, working directory, allowed tools, verification commands, and `loop_budget` for the disposable worktree.
2. In host code, run `validateTaskContract()`, construct `new PersistentStateStore(statePath)`, a concrete `WorkerAdapter` (the existing `PiAgentWorkerAdapter` is the Pi-process adapter), and call `new PersonalPiPipeline({ state_store }).execute(request)`. The request must include the `Requirement`, `Task Contract`, plan checklist/approval, Worker, and workspace snapshot required by [`pipeline.ts`](../../packages/personal-pi/src/pipeline.ts).
3. The host owns creation and removal of the disposable worktree. No generic worktree or JSON-submit CLI exists. Treat the returned `PipelineExecution` as the complete Task -> Run -> Result -> Evidence -> Verification -> Acceptance record.

### B. Inspect Task, Run, and evidence

Read `PipelineExecution.task`, `.run`, `.result`, `.evidence`, `.verification`, and `.trace`, or reopen the same state file with `PersistentStateStore(statePath)` and use `read()`, `getTask()`, `listTasks()`, `getRuns()`, and `getTrace()`. There is no read-only inspection command. `controller-process.mjs inspect` performs recovery and writes a marker, so it is not a viewer.

### C. Calibrate policy, learned routing, and replay

- Fixed Phase 15 evidence runner: `npm run phase-15-adaptive-policy --workspace=@personal-pi/core`. It reads the repository's fixed historical evidence and writes the fixed Phase 15 report; it does not accept arbitrary operator observations.
- API-only policy path: `calibratePolicy()`; advisory route path: `LearnedRoutingAdvisor.recommend()` / `recommendRouting()` followed by the `RoutingRuleGuard` hard check.
- API-only regression path: `PlanRegressionDataset.ingest()`, `list()`, `summary()`, `replayPlanRegressionCase()`, and `replayDecisionRecordAdmission()`. The existing `npm run test:personal-pi-regression` command runs the fixed regression suite; it is not an arbitrary replay CLI.

### D. Failure, rejection, and rollback evidence

Inspect `task.state`, `verification.status`, `verification.reasons`, `result.errors`, and trace decisions. The existing API surfaces are `RecoveryManager.recover()`, `startRetry()`, `admitResult()`, `AcceptanceGate.markDone()`, and `PersistentStateStore.restoreSnapshotFromStore()`. These are state-changing control-plane calls, not viewer commands; invoke them only from the host workflow and retain their returned decision/reason and snapshot evidence. No generic rollback/reject CLI exists.

### E. Baseline integrity before and after a tuning run

From the repository or disposable worktree, record:

```text
git rev-parse HEAD
git status --short
git diff --check
git rev-parse refs/tags/personal-pi-v3.2-phase15-baseline^{}
git diff --name-only personal-pi-v3.2-phase15-baseline..HEAD -- packages scripts
```

The last command must be empty when checking this closeout's source boundary. Root `npm run check` includes `biome check --write`, so it is not a read-only baseline check; run it only where that mutation is intended, preferably in an isolated worktree.
