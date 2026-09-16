# Phase 15 Adaptive Policy — Engineering Log

Date: 2026-09-16
Decision: **PASS**
Scope: T15.1 / T15.2 / T15.3 only

## 1. Baseline re-verification

The actual checkout was re-read before implementation:

- branch: `feature/t1-task-contract`
- HEAD: `a84dd4c1fc77096b064d5038e5d8e69f6ac04f51`
- upstream: none configured
- `origin/main`: ahead 29, behind 0
- worktree: already dirty with retained Phase 12–14 implementation and gate artifacts

No existing dirty file was reset, cleaned, overwritten, committed, pushed,
merged, or tagged. The Phase 14 evidence was rechecked and still records
Hermes Level-C PASS, with Codex GAP-01 and Agy GAP-03 both
`OPEN_NON_BLOCKING`; Gemini remains stopped and CLI discovery remains P2 TODO.

The Phase 12 Level-B, Phase 13 T13.4 Aggregate, and P0 evidence were retained
as prerequisites. The Phase 15 implementation does not touch Controller, DAG,
Verification, Persistent State, or the known-gap registry.

## 2. Design decisions

1. Use a pure deterministic calibration function over explicitly supplied
   projections. No LLM call is required.
2. Represent unavailable measurements as `insufficient_data`. In particular,
   zero cost from a source without cost provenance is not silently promoted to
   measured cost.
3. Extract the existing Registry admission predicate so the learned advisor
   and normal Registry selection share the same capability/tier/context/
   reasoning/type/availability/role checks.
4. Keep Rule Guard dominant over every score. Suggestions are immutable,
   advisory-only values and cannot apply their own recommendation.
5. Use a separate versioned Plan Regression Dataset rather than the older
   generic trace regression type or the external-gap registry.
6. Treat the real T13.4 empty-decision-list trace as an evidence-admission
   regression. Do not reuse the intentional crash/reassignment, Provider
   identity gaps, or known upstream failures as planning-error seeds.

## 3. Implemented files

- `packages/personal-pi/src/policy-calibration.ts`
- `packages/personal-pi/src/learned-routing.ts`
- `packages/personal-pi/src/plan-regression-dataset.ts`
- `packages/personal-pi/src/registry.ts` — shared canonical admission predicate
- `packages/personal-pi/src/index.ts` — public exports
- `packages/personal-pi/test/adaptive-policy.test.ts`
- `packages/personal-pi/test/plan-regression-dataset.test.ts`
- `packages/personal-pi/scripts/phase-15-adaptive-policy.mjs`
- `docs/stage-gates/phase-15-adaptive-policy-gate.md`
- `docs/stage-gates/phase-15-engineering-log.md`
- `docs/stage-gates/evidence/phase-15-adaptive-policy-2026-09-16.json`

The shared Registry change is a predicate extraction with unchanged selection
semantics; it is not a new architecture domain or a new dispatch path.

## 4. Evidence-bounded findings

The historical corpus supports aggregate efficiency and quality metrics, but
does not contain enough explicit labels to calibrate over-decomposition,
wrong-Worker, unnecessary-handoff, retry/replan-overuse, or T2.0-A false
negative rates. Those fields are marked `insufficient_data` and yield
no-change recommendations.

The corpus does contain three real T13.4 traces with empty Decision Record
arrays. This supports one executable evidence-admission recommendation and a
replayable correction. The Phase 15 report does not claim that a Worker was
wrong, that a handoff was unnecessary, or that a recovery retry was wasteful.

## 5. Verification record

| Command/check | Result |
| --- | --- |
| Phase 15 focused tests | 2 files / 10 tests PASS |
| `npm run test --workspace=@personal-pi/core` | 39 files / 209 tests PASS |
| `npm run test:personal-pi-regression` | 3 files / 23 tests PASS |
| `npm run build --workspace=@personal-pi/core` | PASS |
| `npm run check:protocol-isolation --workspace=@personal-pi/core` | PASS |
| `npm run check:pinned-deps` | PASS |
| `npm run check:runtime-deps` | PASS |
| `npm run check:ts-imports` | PASS |
| `npm run check:entry-graphs` | PASS |

The evidence generator was run after the implementation and records current
branch/HEAD/status/divergence, authority hashes, the retained prior gate
statuses, the Rule Guard denial probe, dataset replay, and Phase 15 gate
checks. It does not read or persist secrets.
