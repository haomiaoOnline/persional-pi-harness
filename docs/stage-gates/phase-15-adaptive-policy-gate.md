# Personal PI Harness — Phase 15 Adaptive Policy Stage Gate

Gate date: 2026-09-16
Baseline: v3.2
Decision: **PASS**
Runtime claim: **offline/advisory policy layer only**

## Authority and retained baseline

The only governing standards remain the user-supplied v3.2 architecture and
executable task list:

- architecture SHA-256: `31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480`
- task list SHA-256: `a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b`

This gate does not reopen, redefine, or downgrade the earlier phases:

- Phase 12: PASS
- Phase 13 T13.4 Aggregate Gate: PASS
- P0 Multi-Worker MVP: PASS
- Phase 14 Level-C Multi-CRI: PASS through the Hermes path
- Codex GAP-01: `OPEN_NON_BLOCKING`
- Agy GAP-03: `OPEN_NON_BLOCKING`
- Gemini route: stopped
- CLI discovery: P2 TODO

The Self-Hosting Readiness Checkpoint is deferred and is not a Phase 15
prerequisite.

## Current repository boundary

The implementation was performed in the existing dirty checkout and did not
commit, push, merge, or tag anything.

- branch: `feature/t1-task-contract`
- HEAD: `a84dd4c1fc77096b064d5038e5d8e69f6ac04f51`
- upstream: not configured
- `origin/main` divergence: ahead 29, behind 0
- existing Phase 12–14 uncommitted files were preserved
- Phase 15 delta is limited to the policy-calibration, learned-routing,
  regression-dataset implementation, the shared Registry admission predicate,
  exports, focused tests, runner, gate documents, and Phase 15 evidence

## T15.1 — Policy Calibration

Implementation: `packages/personal-pi/src/policy-calibration.ts`

The analyzer consumes bounded projections of real execution traces, baseline
comparisons, and Phase 12 records. It performs no filesystem, network, model,
credential, or state access. Every value is tagged `measured` or
`insufficient_data`; an unavailable zero is never treated as a measured zero.
Input observations are cloned, sorted by stable ID, and never mutated.

Evidence sources and cohort:

- Phase 12 real heterogeneous record rows and Type A baseline records
- Phase 13 T13.4 real traces and graph-efficiency fields
- T11.5 Single-Agent Baseline / Single-vs-Multi comparison, sample size 3
- Phase 14 Hermes real execution identity/result evidence

The machine report contains 16 normalized observations covering 20 historical
cases. The report records measured `useful_work_ratio`,
`coordination_efficiency`, `verification_first_pass_rate`,
`time_per_verified_task`, handoff/retry/replan counts, graph dimensions, and
agent calls. Monetary cost is measured only for the Phase 12 cohort whose
source explicitly marks cost as available; other zero-like or absent values
remain unavailable.

The actionable calibration finding is a real trace-evidence issue: all three
T13.4 traces have `decisions: []`. The executable recommendation is to require
a non-empty dispatch Decision Record before using decision-dependent history
to alter routing, and otherwise retain `insufficient_data` without changing
Task truth or Persistent State.

The bounded recovery observation is not classified as waste. Retry/handoff
presence alone does not prove overuse; recovery traces remain a separate
cohort and the existing Loop Budget/recovery controls are retained.

The following categories are explicitly `insufficient_data`, not inferred:

- over-decomposition
- wrong Worker
- unnecessary handoff
- retry/replan overuse as an explicit labeled cohort
- T2.0-A preclassifier false negative

Each recommendation includes evidence references, confidence, affected task
types, and a before/after rule delta in the machine evidence.

## T15.2 — Learned Routing

Implementation: `packages/personal-pi/src/learned-routing.ts`

The suggestion layer uses deterministic scoring:

```text
100 × capability_match
+ 25 × historical_success_rate (only when a task-type cohort exists)
+ 10 × task_type_match
- 5 × surplus_cost_tier
- latency_ms / 1000
```

Missing history contributes no confidence and no invented success rate. Equal
scores use stable `worker_id` ordering.

The route is strictly:

```text
canonical Registry admission → score eligible candidates → final Rule Guard recheck → advisory suggestion
```

The Rule Guard reuses the Registry admission predicate and the existing
permission/role and Loop Budget predicates. It enforces Worker type, tier,
capability tags, context limit, reasoning support, role/permission boundary,
approval, verification strength, and budget. A suggestion cannot grant
permissions, weaken verification, increase budget, or mutate Task/Persistent
State.

The focused negative matrix covers Worker type, tier, capability, reasoning,
context, permission, role, verification, Loop Budget, and approval. A
maximum-score suggestion that requests an out-of-scope write, weakens strong
verification, and exceeds `max_attempts` is denied with explicit reasons.
The machine probe records this as 100% hard-rule interception.

This is not live runtime adaptive dispatch: `runtime_selection_integrated` is
explicitly `false`. The output is advice only and has no scheduling,
approval, or verification authority.

## T15.3 — Plan Regression Dataset

Implementation: `packages/personal-pi/src/plan-regression-dataset.ts`

The versioned schema requires:

- task ID and an execution reference (`run_id` or `trace_id`)
- decision reference
- predicted path and actual outcome
- missed signal
- correction and before/after rule delta
- evidence references and status

Ingestion uses an allowlist of planning/decision categories, rejects duplicate
IDs and malformed evidence, rejects known external-gap references and aliases
(including GAP-01/GAP-03 and `known_gaps` sources), rejects sensitive strings,
and rejects fault-injection/crash-recovery records as plan regressions.
The T2.0-A `preclassifier_false_negative` category is a separate typed
subclass and count; it is not merged with Worker failures or the external-gap
registry.

The current real seed is the T13.4 `parallel_read_analysis` trace:

- task: `t13-read-synthesis`
- trace: `c44fc7fd-669b-40eb-9f2b-9dee02fc8970`
- decision reference: `trace:DISPATCH`
- observed outcome: `DONE` with an empty Decision Record list
- correction: require a non-empty decision record for calibration admission

Replay of this evidence-backed case changes the deterministic result from
`usable_for_calibration` under the old admission rule to `insufficient_data`
under the correction. The dataset contains one such case; the absence of a
larger historical planning-error cohort is retained as an explicit observation,
not filled with synthetic cases.

## Stage Gate result

| Check | Result | Evidence |
| --- | --- | --- |
| T15.1 executable calibration report from real data | PASS | `policy_calibration` in the machine evidence |
| T15.1 measured recommendation support | PASS | decision-record admission recommendation, sample count 3 |
| T15.2 advisory recommendation + deterministic Rule Guard | PASS | `learned_routing.rule_guard` |
| T15.2 hard-rule violation interception | PASS | focused matrix and high-score denial probe |
| T15.3 versioned schema and ingestion | PASS | `plan_regression_dataset.summary` |
| T15.3 real historical case replay and correction | PASS | `plan_regression_dataset.replay` |
| Phase 12–14 status unchanged | PASS | retained phase status and source gate evidence |
| P0 invariants preserved | PASS | Phase 12/13/14 gate checks, including bound coverage |

Authoritative machine evidence:
[`phase-15-adaptive-policy-2026-09-16.json`](./evidence/phase-15-adaptive-policy-2026-09-16.json)

## Verification

The following checks passed after implementation:

- Phase 15 focused tests: 2 files, 10 tests
- Personal PI core tests: 39 files, 209 tests
- repository Personal PI regression: 3 files, 23 tests
- Personal PI build: PASS
- protocol metadata isolation: PASS
- pinned dependencies: PASS
- runtime dependencies: PASS
- TypeScript relative imports: PASS
- entry point graphs: within budget

The pre-existing repository-wide known-upstream fingerprint remains unchanged:
`packages/ai/src/api/google-shared.ts:402` — `TS2322` for
`FinishReason.TOO_MANY_TOOL_CALLS` — and the existing two
`process-worker.ts` lint warnings remain bounded baseline findings. No broad
bypass or unrelated fix was introduced.
