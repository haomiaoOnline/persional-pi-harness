# Phase 12 Stage Gate — Multi-Worker

Final verdict: **PARTIAL / REOPENED**
Evidence base SHA: `71b3e44297d20b43faf31a677c2f5224a9e57481`；本轮未创建 commit，且明确没有进入 T13。

## Requirements / tasks

`T12.0-A` Worker Plugin Manifest contract；`T12.1–T12.3` Registry/Capability/Selection；`T12.4` Pool Lifecycle；`T12.5` success-rate feedback；`T12.6` Provider quota/backpressure/circuit breaker；`T12.7` Role Workspace Persistence Cache。

## Scope / implementation location

- Manifest/registry/pool/resilience/cache: `packages/personal-pi/src/plugin.ts`, `src/worker-registry.ts`, `src/worker-pool.ts`, `src/provider-resilience.ts`, `src/workspace-cache.ts`。
- Persistent lease/handoff boundary: `src/lease.ts` and `src/recovery.ts:136-174`。
- Multi comparison: `test/single-vs-multi.eval.test.ts`。
- Existing phase tests: `test/plugin.test.ts`, `test/registry.test.ts`, `test/worker-pool.test.ts`, `test/worker-feedback.test.ts`, `test/provider-resilience.test.ts`, `test/workspace-cache.test.ts`。

## Commands / expected / actual

```text
npm run test --workspace @personal-pi/core
expected: all Phase 12 implementation and regression tests pass
actual: 25 files, 142 tests passed

npm exec --workspace @personal-pi/core vitest -- run \
  test/single-vs-multi.eval.test.ts test/loop-budget.integration.test.ts
expected: same-budget Single/Multi comparison and handoff bound pass
actual: included in the 6-file/19-test v3 targeted pass
```

## Static Validation

Core build, protocol isolation, package runtime-dependency checks and browser smoke pass. T13 files and Batch/Parallel implementation were not touched.

## Failure injection

Pool tests cover duplicate lease requests and lifecycle transitions; feedback tests cover selection feedback; resilience tests inject repeated 429/500 and cooling; workspace-cache tests clear the cache and rebuild it. Handoff injection with `max_handoffs=0` blocks before replacement lease acquisition.

## Persistence / recovery evidence

Lease/epoch, loop usage and workspace cache semantics are tested. Clearing the workspace cache must affect speed only, not correctness. The local Single/Multi comparison uses the same task set, permissions, tools and loop budgets and persists each mode’s state separately.

## Bound Coverage

Phase 12 handoff/reassign is B4 and is now runtime-gated by `beforeHandoff`; repeated Worker/model/tool activity uses B1–B3. Any new T12 path must be added to [`bound-coverage.md`](./bound-coverage.md) before enablement. T13 Batch/Parallel is not started.

## Regression results

Manifest, registry, pool, feedback, resilience, cache, loop-bound and Single/Multi tests pass. Local baseline: both modes verified all 3 tasks; Single observed 75.45468066666666 ms/task and Multi 44.99808333333332 ms/task; both had zero cost, handoffs and retries and efficiency 1.0. Multi functionality passing does not prove production efficiency superiority.

## Known upstream failures

The repository-wide `google-shared.ts:402` type error and coding-agent `pi`/`pph`, `.pi`/`.pph`, remote-session and fswatch failures remain exact Phase 0 blockers. No broad skip or `--no-verify` was used.

## Unresolved issues

The current comparison uses two instances of the local-process Worker kind, not two independently validated external Worker/Provider types. It is a bounded local baseline, not the required production-scale multi-worker evidence. T13 remains explicitly out of scope.

## Evidence collection / final verdict

Evidence: Phase 12 unit tests, handoff exhaustion test, local baseline metrics and [`evidence-bundle.md`](./evidence-bundle.md). **PARTIAL / REOPENED** pending real external Worker/provider evidence and repository gate closure.

## Closure update — 2026-09-14

The repository gate closure portion is now satisfied by the exact
Known-Upstream-Failure gate and the 76-failure coding-agent differential is
zero. The strict Phase 12 blocker remains: the existing benchmark uses the
same local-process Worker kind twice, not two independently validated real
Worker backends. T12.1–T12.3 progressive exposure and structured
`HANDOFF_READY` wakeup are v3.1 delta work and are not started at this
baseline. External authorization/provider evidence remains required.

## v3.1 delta update — 2026-09-15

`T12.1–T12.3` progressive exposure is implemented in
`packages/personal-pi/src/progressive-tools.ts`: nine built-ins are below the
twenty-tool ceiling; simple tasks receive only that set; matching capability
tags add extension/MCP tools in origin order, with remote last. Bash is added
only as a fallback when no dedicated matching tool exists.

The cross-Worker clarification is implemented as a strict `HANDOFF_READY`
notice containing only handoff/task identity, artifact digest and producer
revision. `handleWorkerNotice` wakes the Controller to reread Persistent State
and check Artifact Handoff readiness; the notice is not state truth and cannot
start open-ended Agent chat. `progressive-tools.test.ts` passes and B12 covers
the wakeup boundary. **PASS for the local progressive/message contract**.

The strict Phase 12 evidence is still **PARTIAL / REOPENED**: the available
Single/Multi benchmark uses the same local-process Worker kind twice. No
authorized second Worker backend/provider, external benchmark, or production
pool lease evidence is available. Existing injected 429/500 circuit-breaker
and cache clear→rebuild tests remain local evidence only. T13 remains out of
scope.

## External Evidence Closure update — 2026-09-15

The inventory found no second backend that is both authorized for this internal
repository and callable through a Personal PI adapter. The global `pi`,
OpenCodex and ArkCLI packages are not sufficient evidence: the first is
upstream `pi` rather than `pph`, the local proxy did not answer its read-only
HTTP probe, and Ark is outside the current provider allowlist. The static
Codex/Claude manifests also point to absent adapter files.

Second-backend conformance and the real same-budget Single/Multi benchmark are
therefore **NOT RUN**. The existing three-task, same-kind local baseline is
retained without generalizing its result. **Phase 12 remains
BLOCKED_EXTERNAL / PARTIAL / REOPENED.**
