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

## Worker Adapter enablement update — 2026-09-15

Type A now has a checked-in plugin manifest and executable adapter:
`pi-agent-deepseek-v4-flash.plugin_manifest.yaml` → `adapters/pi-agent.ts`.
The adapter contract, permission gate, exact provider/model observation and
Work Receipt behavior pass the Personal PI adapter tests; real Phase 3 and
Phase 7 evidence is recorded in the two machine-readable files linked below.
This is one genuine backend type and is not counted twice as two workers.

The Codex CLI adapter is also present, but its real probe is not yet a second
conforming backend. A real `codex exec` process returned `CODEX_PROBE_OK` with
the requested `gpt-5.6-sol`, while the Personal PI adapter intentionally kept
`platform_accepted_model=unknown` and `observed_runtime_model=unknown` because
the CLI did not echo identity. The bounded adapter probe observed `30118`
input tokens against a `1500` Task Contract limit and returned
`loop_budget_exhausted`; it was not retried after the latest Codex weekly
usage reached `95%` and the `gpt-5.6-luna` base-model weekly window remained
at `100%`. No extra account was selected and no reset credit was consumed.

Consequently:

- Type A plugin conformance and the real Type A evidence are **PASS**.
- Type B conformance is **BLOCKED_EXTERNAL** until a user-selected Codex
  profile can produce trustworthy runtime identity within a bounded contract.
- Heterogeneous same-budget Single/Multi benchmarking is **NOT RUN**. The
  existing same-kind local three-task baseline remains E2/local evidence only;
  pool lease, 429/500 circuit breaker and cache rebuild tests were not
  reclassified as external proof.

The minimum human action, if Type B is to be resumed, is to manually select or
sign in to the extra Codex account/profile in the local Codex CLI and confirm
availability without sharing any credential. This remains outside the current
run. **Phase 12 remains `BLOCKED_EXTERNAL / PARTIAL / REOPENED`; T13 is not
entered.**

## Codex Type B execution and heterogeneous benchmark — 2026-09-15 historical record

The user-confirmed Codex session was re-probed within the requested bounded
scope. The machine record is
[`evidence/phase-12-real-heterogeneous-2026-09-15.json`](./evidence/phase-12-real-heterogeneous-2026-09-15.json),
bound to implementation SHA `b65fc5d95993c7fc9fc7ea4bffac3512237671a9`.
Earlier blocked attempts above remain historical records; this section is the
latest reconciliation and does not rewrite them.

### Runtime identity and accounting

- Binary: `/Users/chenglong/.local/bin/codex`; `codex-cli 0.154.0`.
- `codex login status` completed successfully; only the sanitized state
  `authenticated_or_session_available` was recorded. No token, cookie,
  account identifier or credential file content was read or persisted.
- Requested model: `gpt-5.6-sol`; `platform_accepted_model=unknown` and
  `observed_runtime_model=unknown`. The process emitted five JSONL events and
  per-run session digests `6fe07e3f178a7673`, `c066a65742cafd69` and
  `a505ea494a551e0a`; raw session identifiers were not recorded. No model or
  provider was inferred from the request value.
- The probe measured `provider_fixed_input_tokens=29705` and retained the
  provider total. The Personal PI projected task budget is `1500`, so the
  effective provider ceiling is `31205`. The Type B smoke observed `30202`
  provider input tokens, projected `497`, and `213` output tokens. The two
  Type B benchmark cases observed `60398` input tokens in total, projected
  `988`, and `389` output tokens. Cost remained unavailable (`null`).
- This separates fixed provider/runtime overhead from PPH task accounting;
  without calibration the adapter fails closed instead of subtracting real
  task tokens or declaring a false budget pass.

### Thin Adapter and conformance

`CodexCliWorkerAdapter` is a distinct `codex-cli` process execution path from
`PiAgentWorkerAdapter` (`pi-agent`/`opencodex`). Both stay behind the Task
Contract, Context Projection, permission/tool boundary, loop budget, lease
fencing, structured Result, Work Receipt, Evidence and independent
Verification path. Codex receives no Task-tool bridge in this benchmark and
the five tasks use no tools, no network, no credentials and no workspace
writes.

The local conformance suite is `10/10` PASS and covers normal success,
permission boundary, structured/invalid output, timeout, budget admission and
Result/Receipt identity. The real Type B smoke is also PASS: one synthetic
`json-shape` task reached `DONE`, returned a valid success Result, passed the
independent verifier, and produced a valid no-op Work Receipt with lease epoch
1. The failed malformed-contract and verifier-argument attempts are retained
in `.learnings/ERRORS.md`; neither was promoted to benchmark evidence.

### Registry and benchmark

The registry returned two candidates in the same order across three reads:
`phase12-type-a-pi-agent` (`pi-agent`) and
`phase12-type-b-codex-cli` (`codex-cli`). Explicit `pi` and `codex` selections
resolved to those different worker IDs and backends. The same five synthetic
tasks, projected context, tool policy, permissions and loop-budget semantics
were used for both modes. Assignments in the heterogeneous run were
`A/B/A/B/A`.

| Metric | Single Type A | Heterogeneous Multi |
| --- | ---: | ---: |
| Verified success rate | 5/5 (`1.0`) | 5/5 (`1.0`) |
| Time per verified task | `8555.27 ms` | `11062.19 ms` |
| Cost per verified task | `0` | unavailable |
| Handoffs / retries | `0 / 0` | `0 / 0` |
| Verification first pass | `1.0` | `1.0` |
| Coordination efficiency | `1.0` | `1.0` |
| Graph width / peak workers | `1 / 1` | `2 / 2` |

Provider/model/token usage was: Single Type A `opencodex` with observed
`ArkCoding/deepseek-v4-flash-ga-260731`, input `5299`, output `2036`, cost `0`;
heterogeneous Type A input `3178`, output `994`, cost `0`, and Type B input
`60398` (projected `988`), output `389`, cost unavailable. No superiority claim
is made from this bounded sample. Pool lease, injected 429/500 circuit breaker,
cache clear→rebuild and `HANDOFF_READY` state/artifact recheck remain covered
by the local 33-file/185-test suite; the readiness notice carries no state
truth and does not start open-ended Worker chat.

### Formal gate result

Execution, Result/Receipt/Verification, registry separation and heterogeneous
benchmark behavior are now evidenced. The formal Phase 12 release gate is
`PASS_EXECUTION_MODEL_IDENTITY_UNKNOWN`, not `PASS/CLOSED`, because the Codex
CLI did not provide trustworthy platform/provider/runtime model identity. This
is an explicit evidence limitation, not a guessed `gpt-5.6-sol` claim.
The aggregate result therefore remains **NOT READY FOR T13**. T13 was not
entered.

## Codex Type B Model Identity Attestation Closure — 2026-09-15

The prior Type B smoke and `A/B/A/B/A` benchmark remain preserved in their
original machine record. This closure pass only investigated whether Codex
CLI 0.154.0 exposes a trustworthy runtime identity; it did not rerun the
benchmark or change the Provider allowlist. The bounded diagnostic evidence is
[`evidence/type-b-identity-attestation-2026-09-15.json`](./evidence/type-b-identity-attestation-2026-09-15.json).

The evidence standard is explicit: the requested model is not the observed
model, and an identity value must come from the same real execution/session
and be machine-verifiably bound to it. The fresh `codex exec --ephemeral
--json` probe emitted five JSONL events. Its only session binding was a
hashed `thread_id`; the event shapes contained no `model`, `model_provider`,
`provider`, accepted-model, or observed-model field. Stdout/stderr were kept
as digests only (`d6ee957b6ad426fd` / `8058b5e473f7bab0`), and the raw stream
was not retained.

The installed CLI help and generated schemas do not close this gap. The
public app-server `Thread.model` field is documented as configured/latest
persisted state and explicitly not per-turn execution telemetry. The internal
`SessionConfiguredEventMsg` schema contains `model` and
`model_provider_id`, but that event was not present in this JSONL execution
and no corresponding persisted metadata exists for the ephemeral probe.
Recent local desktop state/log entries were also rejected: they contain
desktop configuration or shared-process records, not a binding to this Type B
CLI run.

| Field | Attestation result |
| --- | --- |
| `requested_model` | `gpt-5.6-sol` |
| `platform_accepted_model` | `unknown` |
| `observed_runtime_model` | `unknown` |
| `provider` | `unknown` |

No adapter change is safe or justified: `CodexCliWorkerAdapter` continues to
fail closed when the CLI emits no identity. No Type B code tests were rerun
because no source changed; the existing `10/10` adapter conformance, real
smoke, and heterogeneous benchmark remain historical execution evidence and
are not rewritten. The minimum human action is to use a supported Codex CLI
build or execution surface that emits model/provider metadata bound to the
same Type B run/session/turn, then capture one synthetic bounded smoke without
sharing credentials.

**Phase 12 remains `PASS_EXECUTION_MODEL_IDENTITY_UNKNOWN` and its exit is
BLOCKED. The aggregate remains `NOT READY FOR T13`; T13 was not entered.**
