# Personal PI Harness — Phase 12 v3.2 Stage Gate

Gate date: 2026-09-15
Baseline: v3.2
Decision: PASS
Phase 13 status: entered after this gate; T13.4 evidence is separate

## Authority and repository baseline

The sole standard for this gate is the user-supplied v3.2 architecture design and executable task list:

- 01-Personal_PI_架构设计_v3.2.md
  - SHA-256: 31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480
- 02-Personal_PI_可执行任务清单_v3.2.md
  - SHA-256: a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b

The audited repository baseline was:

- branch: feature/t1-task-contract
- HEAD: a84dd4c1fc77096b064d5038e5d8e69f6ac04f51
- initial worktree: clean
- divergence from origin/main: ahead 29, behind 0
- upstream: not configured
- no push, merge, or tag was performed

The known upstream failure remains unchanged and bounded to packages/ai/src/api/google-shared.ts:402 — TS2322 FinishReason.TOO_MANY_TOOL_CALLS is not assignable to never.

## Implemented Phase 12 scope

The implementation stays on the existing WorkerAdapter → Result → Work Receipt → Evidence → Verification path and adds only the Level-B runtime and gate wiring:

- T0.3: canonical docs/stage-gates/known_gaps.yaml, with GAP-01 fixed to resolution: Phase 14 Multi-CRI and mvp_impact: NON_BLOCKING.
- B1/B2: two same-adapter ProcessWorkerAdapter instances backed by distinct long-lived OS processes, isolated workspaces, and independent generated session handles.
- B3: WorkerPool lease integration with persistent lease_epoch, atomic claim ownership, recovery, and stale-result fencing.
- B4: per-instance context projection digest, session context clearing, and workspace separation.
- B5: BudgetController active-worker and concurrent-role accounting.
- B6: shared Provider quota/backpressure/circuit-breaker wrapper; deterministic fault injection remains separate from real Provider evidence.
- B7: crash → reclaim → reassign → stale epoch rejection.

No Phase 13 worktree integration or parallel-coding implementation is included in this gate.

## Gate evidence

The canonical machine-readable evidence is [phase-12-level-b-2026-09-15.json](evidence/phase-12-level-b-2026-09-15.json). Its aggregate checks are:

| v3.2 requirement | Evidence result |
| --- | --- |
| T0.3 Known External Gap Registry | PASS |
| Registry / Capability / Selection | PASS |
| ≥2 real independent Worker Instances | PASS |
| Atomic lease / no double dispatch | PASS |
| Persistent lease epoch / fencing | PASS |
| Lifecycle | PASS |
| Crash / recovery / reassign | PASS |
| Workspace / session / context isolation | PASS |
| Coordination Budget | PASS |
| T12.6 controlled quota / backpressure / breaker | PASS |
| T12.6 real same-Provider multi-instance execution | PASS |
| Result / Work Receipt / Verification regression | PASS |
| Bound Coverage | PASS |

The real same-Provider evidence records two distinct OS PIDs (79110, 79136), provider opencodex, and runtime model observations emitted by the CLI as ArkCoding/deepseek-v4-flash-ga-260731. Runtime identity is not derived from a configured value; missing runtime fields remain unknown and fail closed.

## Decision

DECISION: Phase 12 v3.2 Stage Gate = PASS. All blocking rows are evidenced. GAP-01 is not in the blocking table: it remains NON_BLOCKING and is resolved in Phase 14 Multi-CRI. The gate does not lower Verification requirements and does not retroactively mark historical v2.0/v3.0/v3.1 evidence as v3.2 evidence.

Phase 13 may now run its separate T13.4 real acceptance scenarios. This document does not assert a Phase 13 result or announce the P0 Multi-Worker MVP.
