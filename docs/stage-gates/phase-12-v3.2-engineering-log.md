# Personal PI Harness — v3.2 Engineering Log

## Goal

FACT: Implement and verify only the missing v3.2 Phase 12 Level-B requirements: real same-Adapter Worker Instances, process/session/workspace/context isolation, lifecycle, persistent lease fencing, crash recovery, coordination budget, T12.6 quota/backpressure/circuit-breaker integration, and unchanged Result/Receipt/Verification invariants.

DECISION: GAP-01 Codex runtime identity telemetry remains mvp_impact=NON_BLOCKING and resolution=Phase 14 Multi-CRI. Phase 13 is not part of the Phase 12 implementation wave.

## Prerequisites

FACT: The authoritative inputs are the user-supplied v3.2 architecture design and executable task list. Their SHA-256 values are recorded in the Phase 12 gate.

FACT: Initial repository verification found branch feature/t1-task-contract, HEAD a84dd4c1fc77096b064d5038e5d8e69f6ac04f51, clean worktree, ahead 29/behind 0 versus origin/main, and no upstream.

KNOWN ISSUE: Type checking has one inherited exact failure at packages/ai/src/api/google-shared.ts:402; the file was not changed and no broad bypass was used.

## Steps

1. DECISION T0.3 first: add and validate the canonical Known External Gap Registry.
2. DECISION B1/B2: add a thin process-backed Worker Adapter and connect it to WorkerPool lifecycle states.
3. DECISION B3/B4: persist Worker Instance records and lease epochs; bind context projection and session/workspace state to the instance.
4. DECISION B5/B6: connect active-worker budget accounting and shared Provider resilience controls.
5. DECISION B7: exercise intentional crash, reclaim, reassign, and stale-result fencing.
6. FACT: Run real Level-B evidence, then full regression and protocol/build checks.

## Commands and results

| Command / action | Result |
| --- | --- |
| npm run build --workspace=@personal-pi/core | PASS |
| npm run test --workspace=@personal-pi/core | 35 files / 193 tests PASS |
| npm run test:personal-pi-regression | 3 files / 23 tests PASS |
| npm run check:protocol-isolation --workspace=@personal-pi/core | PASS |
| npm run test:scripts | 29 tests PASS |
| npm exec -- tsgo --noEmit | only the exact known upstream TS2322 |
| npm run phase-12-level-b --workspace=@personal-pi/core -- --output docs/stage-gates/evidence/phase-12-level-b-2026-09-15.json | all 13 Phase 12 checks PASS |

## Results

FACT: The Level-B evidence runner passed all 13 blocking checks. It recorded two distinct child PIDs, two isolated workspaces, independent session digests, overlapping execution intervals, persistent instance records, lease recovery, stale-result fencing, controlled breaker recovery, and real same-Provider concurrent executions.

## Problems

### Workspace evidence runner path

KNOWN ISSUE Symptoms: The first evidence-runner invocation failed before any gate execution with ENOENT for packages/personal-pi/docs/stage-gates/known_gaps.yaml.

FACT Evidence: npm workspace scripts execute with packages/personal-pi as their current directory.

FACT Root Cause: The runner used process.cwd() as the repository root.

DECISION Resolution/Workaround: Resolve the repository root from the runner module URL and resolve relative evidence output paths against that root. The rerun reached the real gate and passed.

### Initial process workspace creation

KNOWN ISSUE Symptoms: The first process-worker test could not spawn the child because its configured workspace directory did not yet exist.

FACT Evidence: The child spawn returned ENOENT for the configured cwd.

FACT Root Cause: Process-backed runtime initialization did not create its isolated workspace before spawn.

DECISION Resolution/Workaround: Create the instance workspace during ProcessWorkerAdapter construction. The targeted process tests then passed.

### Type-check diagnostic

KNOWN ISSUE Symptoms: tsgo --noEmit exits non-zero at google-shared.ts:402.

FACT Evidence: The only diagnostic is TS2322: FinishReason.TOO_MANY_TOOL_CALLS is not assignable to never.

FACT Root Cause: Known upstream type mismatch.

DECISION Resolution/Workaround: Preserve the exact existing fingerprint and fail-closed allowlist behavior. Do not touch the upstream file and do not use --no-verify, global hook disabling, or a broad skip.

## Root Cause

FACT: The Phase 12 gap was an integration gap: existing in-memory WorkerPool and resilience tests did not establish that independent processes, sessions, workspaces, leases, and context projections were connected in one runtime path.

## Decision

DECISION: Add only process-backed lifecycle, persistent Worker Instance records, Pool fencing, context/budget/provider wiring, and replayable evidence. Keep same-Adapter instances as the Level-B proof and leave heterogeneous CLI/Provider identity for Phase 14.

## Resolution

FACT: The canonical implementation and evidence are now present in the repository. GAP-01 remains explicitly non-blocking; Verification standards were not lowered.

## Verification

FACT: The Level-B runner uses two real child processes with distinct PIDs, per-instance workspaces, independent session digests, and overlapping execution timestamps. It verifies Result Contract identity and Work Receipt effects through the existing adapter path.

FACT: The recovery trace is lease_epoch=1 → intentional crash/reclaim → lease_epoch=2 → stale epoch rejected → reassigned execution succeeds.

FACT: T12.6 has both layers required by v3.2: controlled 429/open→cooldown→recovery evidence and two concurrent real PI executions through one shared opencodex controller. Natural Provider 429 generation was not required.

WARNING: Provider runtime identity is accepted only when emitted by the CLI observation. Requested/configured model values are never substituted for missing runtime identity.

## Evidence

- [Known External Gap Registry](known_gaps.yaml)
- [Phase 12 machine-readable evidence](evidence/phase-12-level-b-2026-09-15.json)
- [Phase 12 v3.2 Stage Gate](phase-12-v3.2-gate.md)
- packages/personal-pi/test/external-gaps.test.ts
- packages/personal-pi/test/process-worker.test.ts

## Stage Gate

DECISION: Phase 12 v3.2 is PASS because every blocking row in the gate table has current evidence. GAP-01 is explicitly NON_BLOCKING for the MVP and remains assigned to Phase 14 Multi-CRI.

FACT: Phase 13 was not entered until this decision was recorded. The separate T13.4 evidence must independently prove all three required scenarios before any P0 Multi-Worker MVP announcement.

## Lessons

- RATIONALE: The validation unit is a Worker Instance. Two instances of one Adapter prove the Level-B boundary more directly than fabricating CLI/Provider diversity.
- RATIONALE: A process PID, session handle, workspace, lease epoch, and context projection must be observable together; a passing in-memory map test is insufficient integration evidence.
- RATIONALE: Provider resilience needs a shared control plane plus deterministic fault evidence; forcing a real Provider into 429 is not a required acceptance criterion.
- TODO: Keep Phase 13 worktree/integration evidence separate from this Phase 12 gate and do not reuse branch-level PASS as final-state Verification.

## Phase 13 continuation

### Goal

FACT: After the Phase 12 v3.2 gate passed, execute T13.4 with real process-backed
Workers and prove the three mandatory scenarios before announcing the P0
Multi-Worker MVP.

### Prerequisites

FACT: Phase 12 is PASS. The v3.2 architecture and executable task list hashes
are recorded in the Phase 12 gate and were not modified.

DECISION: Keep Phase 13 limited to T13.4. Do not introduce Phase 14
Multi-CRI work or change the GAP-01 disposition.

### Steps

FACT: The runner executed:

1. three parallel Read/Analysis Worker Instances and one fan-in Worker;
2. three parallel Coding Workers in separate Git worktrees plus an independent
   Integration Worker;
3. A/C execution around an intentionally crashing B, lease recovery, same-task
   reassignment, stale-result fencing, and final DAG completion.

### Commands and Results

FACT: The T13.4 runner completed with aggregate_gate=PASS and all three
scenario checks equal to PASS. It wrote the machine record to
docs/stage-gates/evidence/phase-13-t13-4-2026-09-15.json.

FACT: The implementation regression set remained green: core build PASS,
core tests 35 files and 193 tests PASS, repository Personal PI regression
23 tests PASS, protocol isolation PASS, and scripts/consumers 29 tests PASS.

### Problems

WARNING: The first coding attempt exposed a macOS temporary-directory
realpath mismatch between /var and /private/var.

WARNING: The first evidence serialization omitted the nested lease epoch
field, which made the evidence schema incomplete even though execution
itself passed.

### Root Cause

FACT: The path warning came from comparing lexical temporary paths instead of
their canonical filesystem paths. The evidence warning came from reading the
outer execution lease object rather than its nested lease record.

### Decision

DECISION: Normalize temporary worktree paths with realpathSync and require
lease_epoch to be serialized from the nested lease record. Re-run all three
T13.4 scenarios after both corrections.

### Resolution

FACT: The path normalization and evidence serialization were corrected. The
temporary worktrees were removed after the run, leaving only the main
worktree. The delayed epoch-1 result was rejected as REJECTED_STALE_EPOCH,
and the reassigned epoch-2 execution completed.

### Verification

FACT: Parallel Read/Analysis records three distinct Worker processes with
overlapping execution timestamps and a fourth fan-in process.

FACT: Parallel Coding records three disjoint branch commits, a real
no-fast-forward integration merge, final Verification PASS, Acceptance DONE,
and branch_pass_not_reused=true.

FACT: Failure Recovery records B DEAD, lease reclaim, same-task reassignment
from epoch 1 to epoch 2, stale-result rejection, unaffected A/C execution,
and final DAG Verification PASS plus Acceptance DONE.

### Evidence

- [Phase 13 T13.4 machine evidence](evidence/phase-13-t13-4-2026-09-15.json)
- [Phase 13 T13.4 Aggregate Gate](phase-13-t13-4-gate.md)
- [Phase 12 v3.2 Stage Gate](phase-12-v3.2-gate.md)

### Stage Gate

DECISION: Phase 13 T13.4 Aggregate Gate is PASS. The machine evidence records
P0 Multi-Worker MVP as PASS. The MVP proof is Level B same-Adapter
multi-instance execution; it does not claim cross-CLI or cross-Provider
diversity. GAP-01 remains NON_BLOCKING and assigned to Phase 14.

### Lessons

- RATIONALE: Real overlap must be shown by execution timestamps and process
  evidence, not by scheduler state alone.
- RATIONALE: Integration Verification must run against the merged final state;
  branch-level PASS is not reusable as final-state proof.
- RATIONALE: Fencing evidence is complete only when the original task is
reassigned at a new lease epoch and the old result is actively rejected.

## Post-Gate Snapshot Check

### Goal

FACT: T5.4 requires a Persistent State Snapshot after a Stage Gate PASS and a
successful Restore Drill. Phase 12 and Phase 13 already had historical
snapshot implementation tests, but no separate post-gate evidence artifact
was attached to their current v3.2 gate records.

### Steps

1. FACT: Re-read the v3.2 architecture and executable task-list attachments;
   their recorded SHA-256 values remain unchanged.
2. FACT: Revalidated the Phase 12 and Phase 13 gate JSON records, gate
   documents, GAP-01 registry, and the unchanged upstream failure fingerprint.
3. FACT: Executed a non-secret PersistentStateStore snapshot fixture, loaded
   the persisted snapshot from its state file, mutated the state, restored it,
   and attempted a tampered-digest restore.

### Results

FACT: Snapshot persistence, pre/post restore digest equality, restore
verification, and tampered-digest rejection all passed. The machine-readable
record is [post-gate-snapshot-2026-09-15.json](evidence/post-gate-snapshot-2026-09-15.json).

WARNING: The drill uses a synthetic non-secret state fixture because the
Phase 12/13 evidence runners clean up their temporary runtime state. It is
post-gate T5.4 evidence and does not claim to replay those historical worker
runs.

### Decision

DECISION: T5.4 post-gate close-out is PASS for the current core snapshot and
restore implementation. This action does not reopen, re-run, or alter the
Phase 12/13 functional Gate decisions.
