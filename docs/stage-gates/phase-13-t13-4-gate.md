# Personal PI Harness — Phase 13 T13.4 Aggregate Gate

## Gate decision

DECISION: PASS

Phase 13 T13.4 has passed all three mandatory real-execution scenarios. The
Personal PI P0 Multi-Worker MVP has passed this evidence review and is recorded
as PASS in the machine evidence.

Phase 12 remains a prerequisite and is recorded as PASS in
phase-12-v3.2-gate.md. Phase 13 did not alter the Phase 14 placement of GAP-01.

## Authority and baseline

The only governing documents are the v3.2 architecture design and executable
task list supplied for this execution:

- architecture SHA-256:
  31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480
- task list SHA-256:
  a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b

Repository baseline:

- branch: feature/t1-task-contract
- HEAD at audit start: a84dd4c1fc77096b064d5038e5d8e69f6ac04f51
- worktree at audit start: clean
- origin/main divergence at audit start: ahead 29, behind 0
- branch upstream: not configured

No push, main merge, or tag was performed.

## Mandatory evidence

### T13.4.1 Parallel Read/Analysis

Three real process-backed Worker Instances analyzed architecture, code, and
tests in parallel. A fourth real Worker Instance performed fan-in synthesis.
The evidence records distinct process IDs, instance IDs, session digests,
workspaces, lease epochs, execution timestamps, context projections, and
trace replay. The three analysis intervals overlap, and the fan-in DAG follows
their completion.

Result: PASS.

### T13.4.2 Parallel Coding

Workers A, B, and C used separate real Git worktrees and committed disjoint
files. An independent Integration Worker merged the three commit SHAs with a
real no-fast-forward merge. The final state was checked by status, diff,
tests, Verification, and Acceptance. The evidence records that branch-level
PASS was not reused as final integration verification, and records execution
start/end timestamps proving real overlap.

Result: PASS.

### T13.4.3 Failure Recovery

Worker B was intentionally driven through timeout/crash behavior while A and C
continued. The original lease was reclaimed, the same task was reassigned at
lease epoch N+1, and the delayed result from epoch N was rejected with
REJECTED_STALE_EPOCH. The final DAG completed and passed Verification and
Acceptance while A and C remained unaffected.

Result: PASS.

## Aggregate checks

All of the following are true in the machine evidence:

- Phase 12 prerequisite is PASS.
- Parallel Read/Analysis is PASS.
- Parallel Coding is PASS.
- Failure Recovery is PASS.
- Aggregate Gate is PASS.
- P0 Multi-Worker MVP is PASS.
- Phase 14 GAP-01 remains non-blocking for the MVP.

The authoritative machine-readable record is
phase-13-t13-4-2026-09-15.json. It contains evidence metadata and digests,
not source contents or credentials.

## Verification

The implementation and regression checks passed:

- core build: PASS
- core tests: 35 files, 193 tests PASS
- repository Personal PI regression: 3 files, 23 tests PASS
- protocol isolation: PASS
- scripts and consumers: 29 tests PASS
- T13.4 real execution: all three scenarios PASS

Type checking still reports only the pre-existing known upstream diagnostic at
packages/ai/src/api/google-shared.ts:402:

TS2322: FinishReason.TOO_MANY_TOOL_CALLS is not assignable to never

That upstream file was not changed, and no broad verification bypass was used.

## Boundary

This gate does not claim cross-CLI or cross-Provider Worker diversity. Phase 12
and Phase 13 prove the v3.2 Level B requirement with multiple real instances
of the same PI Adapter. Level C Multi-CRI and GAP-01 resolution remain Phase
14 work.
