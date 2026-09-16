# Personal PI Harness — Phase 14 Multi-CRI Engineering Log

Date: 2026-09-16
Baseline: v3.2
Overall stage: PASS

NOTE: Sections before `2026-09-16 Hermes T14.2 continuation` preserve the
2026-09-15 NOT READY checkpoint; the continuation below is the superseding
current Phase 14 decision. Phase 12/13 PASS decisions are not reopened.

## Goal

FACT: Implement or close the v3.2 Level-C Heterogeneous Multi-CRI gate after
the already-passed Level-B Phase 12 and Phase 13 MVP gates.

FACT: T14.1 must keep Controller, DAG, Verification, and Persistent State
independent of CRI-specific code. T14.2 must accept only a reliable runtime
identity attestation bound to the same Worker Run, or a real independently
attested heterogeneous replacement.

## Prerequisites

FACT: The governing v3.2 architecture attachment SHA-256 is
`31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480`.

FACT: The governing v3.2 executable task-list attachment SHA-256 is
`a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b`.

FACT: Phase 12 v3.2 Stage Gate, Phase 13 T13.4 Aggregate Gate, and the
Personal PI P0 Multi-Worker MVP are retained as PASS. This phase does not
re-run, redefine, or weaken those Level-B conclusions.

WARNING: `/mnt/data` was not mounted in this environment. The exact v3.2
attachments resolved from the referenced conversation were used and their
hashes match the recorded authority values. The mirror's v2.0 files were not
used as a standard.

FACT: The repository remains on `feature/t1-task-contract` at
`a84dd4c1fc77096b064d5038e5d8e69f6ac04f51`, ahead 29 and behind 0 relative to
`origin/main`, with no configured upstream. The worktree is intentionally
dirty from the uncommitted Phase 12/13 implementation and gate artifacts.

## Steps

1. FACT: Audited the existing `CodexCliWorkerAdapter`, adapter wrapper,
   static plugin manifest, plugin schema, and `WorkerRegistry`.
2. FACT: Compared the Adapter, manifest, Registry, plugin schema, Pipeline,
   Verification, and Persistent State files with HEAD. The Phase 14 source
   delta is empty; the existing Codex route was reused and audited without
   adding a CRI-specific Controller/DAG/Verification/Persistent State branch.
3. FACT: Checked the current CLI inventory: `codex-cli 0.154.0` and the
   existing `pi` binary are available; `claude`, `gemini`, and `opencode` are
   absent; Cursor is a GUI application rather than a headless Worker backend.
4. FACT: Ran two bounded real Codex CLI probes through the Personal PI
   pipeline using a synthetic payload, isolated temporary workspace, no
   Worker tools/actions, credentials denied, and a legal no-op Work Receipt.
5. FACT: Recorded only non-secret event field names, event types, PID, session
   digest, identity status, Result/Work Receipt status, Evidence, and
   Verification. Raw model output, prompt, environment, credentials, and
   account data were not persisted.

## Commands and Results

FACT: `npm run build --workspace=@personal-pi/core` passed after the initial
restricted-sandbox write denial was retried with the required checkout write
permission. Generated `dist` artifacts were refreshed locally only.

FACT: Probe attempt 1 used `max_input_tokens=12000`, created PID `26426` with
session digest `e04da5bca74c6c2d`, parsed 5 JSONL events, and observed no
identity fields. The attempt was intentionally recorded as a bounded failure
because Provider-reported input tokens exceeded that probe budget.

FACT: Probe attempt 2 used `max_input_tokens=50000`, created PID `27085` with
session digest `a02175e1516df38e`, parsed 5 JSONL events, and completed
`Task Contract → Result → Work Receipt → Evidence → Verification` with task
`DONE`, Run `SUCCEEDED`, Result `success`, and Verification `PASS/strong`.

FACT: Both probe event streams contained `thread.started`, `turn.started`,
`item.completed`, and `turn.completed`; the observed top-level fields were
limited to `item`, `thread_id`, `type`, and `usage`. Neither stream exposed a
provider, model, runtime-model, or equivalent identity field.

## Problems

### Problem 1 — Codex runtime identity is absent

**Symptoms**: The Codex CLI completed a real synthetic Worker Run but the
adapter could not populate `platform_accepted_model`, `observed_runtime_model`,
or `provider` from the Run-bound event stream.

**Evidence**: Both current-version probes recorded `identity_fields_seen=[]`,
`identity_event_types=[]`, and `observed_runtime_model=unknown` plus
`provider=unknown`. The second probe independently passed Result, Work Receipt,
Evidence, and Verification, eliminating budget truncation as the cause.

**Root Cause**: The current Codex CLI JSONL surface does not emit a runtime
identity field that Personal PI is authorized to treat as ground truth.

**Decision**: Do not infer identity from requested/configured model, UI text,
or unbound logs.

**Resolution/Workaround**: Keep `GAP-01` fail-closed and
`NON_BLOCKING`, with resolution assigned to `Phase 14 Multi-CRI`.

### Problem 2 — No usable replacement second CLI/provider is installed

**Symptoms**: No independent Claude, Gemini, or OpenCode command is available
for a real heterogeneous replacement probe.

**Evidence**: The bounded binary inventory found `claude=absent`,
`gemini=absent`, `opencode=absent`; Cursor `3.18.9` is GUI-only. The `pi`
binary is the existing baseline PI CRI used for Level-B evidence, not a new
replacement second CRI.

**Root Cause**: The current host exposes no other headless CRI/provider route
with a pre-authorized, machine-verifiable identity surface.

**Decision**: Do not fabricate a second backend, substitute a configured model,
or use a GUI binary as a Worker.

**Resolution/Workaround**: Preserve the gate as NOT READY and leave the gap
registry open for a future real heterogeneous backend or Codex attestation.

## T14.1 Boundary Decision

DECISION: T14.1 Adapter/manifest/Registry conformance is PASS for the existing
Codex second-CRI route. The route uses
`packages/personal-pi/src/adapters/codex-cli.ts`,
`packages/personal-pi/adapters/codex-cli.ts`, and
`packages/personal-pi/examples/worker-plugins/codex-cli-existing-session.plugin_manifest.yaml`.

FACT: Those Adapter, manifest, Registry, plugin-schema, Pipeline, and
Verification files are unchanged from HEAD. `packages/personal-pi/src/persistence.ts`
is dirty because of the already-completed Level-B work, not because of Phase
14; no Phase 14 change touched it.

RATIONALE: Reusing the existing route makes the change boundary auditable and
does not introduce a second orchestration architecture. This log does not
claim that new second-CRI source code was added in this wave.

## Verification

FACT: The Phase 14-focused Adapter/manifest/Registry, Persistent State,
external-gap, and process-worker regression passed: 6 files and 33 tests.

FACT: Protocol isolation passed. Personal PI repository regression passed: 3
files and 23 tests.

FACT: Core package build passed. Pinned dependency, runtime dependency,
TypeScript import, entry-graph, shrinkwrap, coding-agent install-lock, browser
smoke, and `git diff --check` gates passed.

WARNING: The full `npm run check` command is not green because Biome reports
two existing warnings in `packages/personal-pi/src/process-worker.ts` after
formatting 8 files. The warnings are an unused `asRecord` function and an
unused `request` parameter. They belong to the retained Phase 12/13 Worker
implementation; they were not changed in Phase 14.

FACT: Direct `./node_modules/.bin/tsgo --noEmit` reports exactly the registered
upstream TS2322 at `packages/ai/src/api/google-shared.ts:402` and no other
diagnostic. The source hash remains unchanged.

WARNING: The repository's upgrade gate was not run because its hard
preconditions require a clean checkout and a configured upstream. The current
user-scoped boundary intentionally has neither; this is recorded as
NOT_RUN, not PASS.

FACT: The upstream `packages/ai/src/api/google-shared.ts:402` TS2322 remains
unchanged and is not a Phase 14 target. No broad bypass is permitted.

## Evidence

- [Phase 14 machine evidence](evidence/phase-14-multi-cri-2026-09-15.json)
- [Known External Gap Registry](known_gaps.yaml)
- [Post-Gate Snapshot evidence](evidence/post-gate-snapshot-2026-09-15.json)
- [Phase 12 v3.2 Gate](phase-12-v3.2-gate.md)
- [Phase 13 T13.4 Gate](phase-13-t13-4-gate.md)

## Stage Gate — 2026-09-15 checkpoint

DECISION: The 2026-09-15 checkpoint recorded Phase 14 Level-C Heterogeneous
Multi-CRI = NOT READY. It is superseded by the 2026-09-16 Hermes result below;
the retained Phase 12 and Phase 13 PASS decisions are unchanged.

FACT: At that checkpoint, T14.1 boundary conformance was evidenced but T14.2
Exit was not met because Codex supplied no reliable same-Run runtime identity
and no independently attested heterogeneous replacement was available on
this host.

FACT: Phase 12, Phase 13, and P0 Multi-Worker MVP decisions remain PASS and
are not reopened.

## Lessons

- RATIONALE: A successful real Worker Run and a session digest prove process
  execution identity, not model/provider runtime identity.
- RATIONALE: A configured or requested model is a control-plane value and must
  never be copied into `observed_runtime_model`.
- RATIONALE: A Stage Gate may record a bounded partial conformance while the
  aggregate gate remains NOT READY; this preserves the actual exit criteria.

## 2026-09-16 Hermes T14.2 continuation

### Goal → Prerequisites

FACT: Continue the v3.2 Phase 14 Level-C gate using Hermes as the second
heterogeneous CRI. Phase 12 PASS, Phase 13 T13.4 Aggregate Gate PASS, and P0
Multi-Worker MVP PASS remain unchanged.

FACT: The repository was rechecked before implementation: branch
`feature/t1-task-contract`, HEAD `a84dd4c1fc77096b064d5038e5d8e69f6ac04f51`,
`origin/main` divergence ahead 29/behind 0, no configured upstream, and a
deliberately dirty worktree containing retained Phase 12/13 changes.

FACT: Hermes is installed at `/Users/chenglong/.local/bin/hermes`, resolving
to the Hermes venv wrapper. The observed version is `Hermes Agent v0.18.2
(2026.7.7.2)`, with `--oneshot`, `--usage-file`, and lifecycle hooks available.
`post_api_request` is implemented in this installed version and supplies
`session_id`, `task_id`, `provider`, `model`, `response_model`, API timing,
finish reason, and usage metadata.

FACT: No token, cookie, API key, credential content, prompt, or response body
was read into PPH evidence. The run was restricted to a synthetic public
probe with empty inputs/context, network deny, credentials deny, no tools, and
no requested actions.

### Steps → Commands → Results

1. FACT: Added `HermesCliWorkerAdapter`, its adapter entry, static manifest,
   fixed synthetic bridge, focused tests, and a Phase 14 E2E evidence runner.
   The generic `WorkerRegistry` contract is reused; Controller, DAG,
   Verification implementation, and Persistent State implementation were not
   modified.
2. FACT: The bridge registers only a local `post_api_request` observer and a
   tool-blocking hook, sets `toolsets=[]` and `use_config_toolsets=False`, and
   sends only the fixed `PPH_SYNTHETIC_HERMES_PROBE_v1` prompt. The Adapter
   rejects nonempty tools/actions, resolved context, inputs, or non-denied
   network/credential permissions.
3. FACT: `npm exec --workspace @personal-pi/core vitest -- run
   test/...` passed with 7 files and 36 tests, including the new Hermes
   Adapter tests for success, manifest/bridge boundary, tool/context denial,
   and mismatched response-side identity.
4. FACT: The full `npm run test --workspace=@personal-pi/core` suite passed
   with 37 files and 199 tests.
5. FACT: `npm run build --workspace=@personal-pi/core` passed after the
   Adapter type fixes. The targeted Biome check for the new TypeScript files
   passed with no warnings.
6. FACT: `npm run phase-14-hermes-e2e --workspace=@personal-pi/core` executed
   a real Hermes Worker process and wrote only sanitized evidence to
   `docs/stage-gates/evidence/phase-14-hermes-e2e-2026-09-16.json`.
7. FACT: Personal PI regression passed with 3 files and 23 tests. Protocol
   isolation, pinned/runtime dependency, TypeScript-import, entry-graph,
   shrinkwrap, coding-agent install-lock, browser-smoke, and `git diff
   --check` checks passed.

### Problems → Root Cause → Decision → Resolution

#### Problem 3 — Sandbox blocked the Hermes log directory

**WARNING Symptoms**: The first controlled adapter probe could not start
because Hermes attempted to write its normal `~/.hermes/logs/agent.log`.

**FACT Evidence**: The restricted run produced no identity event and did not
reach the API. The failure was a local filesystem permission error, not an
identity claim.

**FACT Root Cause**: The sandbox did not grant the installed Hermes runtime's
normal log path.

**DECISION**: Do not weaken Hermes logging or redirect credentials. Request a
narrow, user-approved execution permission for the synthetic probe only.

**FACT Resolution/Workaround**: The authorized run completed with the normal
Hermes home and no credential contents exposed to PPH.

#### Problem 4 — Hermes custom provider requires direct-alias resolution

**FACT Symptoms**: Calling installed Hermes `_run_agent` with explicit
`provider="custom"` returned a `RuntimeError` because v0.18.2 does not expose
that direct-alias route as a named provider to the resolver.

**FACT Evidence**: The same fixed synthetic probe with explicit model and
provider omitted completed successfully; the `post_api_request` event reported
`provider=custom`, model, response model, and `base_url_host=127.0.0.1`.

**Root Cause**: In this Hermes version, the local `custom` route is resolved
from the configured direct alias when provider is omitted.

**DECISION**: Let Hermes resolve its configured alias, but require the
same-run response event to equal the PPH expected route. A requested/configured
value is never copied into `observed_runtime_model` or `provider`.

**FACT Resolution**: The fixed bridge invokes `_run_agent` with the explicit
model and `provider=None`; Adapter validation still requires observed
`provider=custom` and observed `response_model` equal to the requested model.

#### Problem 5 — Hermes v0.18.2 returns a tuple from `_run_agent`

**FACT Symptoms**: The installed custom route returns a tuple whose first
element is text and whose second element is metadata.

**FACT Evidence**: The isolated Hermes probe observed a tuple with a string
first item and a dict second item. Only the first textual item is used to
parse the Result Contract; the metadata object is discarded.

**DECISION**: Do not serialize the tuple or any response metadata. Hash the
transient textual result and pass it through the existing Result parser.

**FACT Resolution**: The bridge emits a transient `hermes.result` event with
the textual result and digest; the persisted evidence contains the digest
only, with `prompt_response_captured=false`.

### Verification → Evidence

FACT: The decisive Run is
`pph-t14.2-hermes-e2e-20260916-01`, with Hermes session
`20260916_093528_3383fb` and Hermes task
`1069a6df-9544-4929-b164-73d68d6c2406`.

FACT: Its single `post_api_request` event bound the PPH run id to the Hermes
session/task and reported `provider=custom`,
`response_model=ArkCoding/deepseek-v4-flash-ga-260731`,
`base_url_host=127.0.0.1`, `api_call_count=1`, timestamps, `finish_reason=stop`,
and `api_mode=chat_completions`. The observed model source is explicitly
`post_api_request.response_model`.

FACT: The real Hermes route is heterogeneous with the existing PI baseline:
`hermes-cli/custom@127.0.0.1` versus `pi-agent/opencodex`. The observed model
string happens to match; the heterogeneous proof is the distinct Adapter,
backend, and provider route.

FACT: The real execution completed
`Task Contract → Hermes bridge → Hermes CLI → Result → Work Receipt →
Evidence → Verification`: Result `success`, legal no-op Work Receipt,
Evidence `PASS`, Verification `PASS/strong`, and no workspace effect.

FACT: Machine evidence records `cli_version`, PPH/Hermes correlation ids,
requested/configured/observed model distinctions, provider/backend, identity
source, API count/timestamps/finish reason/usage, result/work-receipt/evidence
digests, and verification digest without raw prompt/response content.

### Boundary → Stage Gate

FACT: Phase 14 files are limited to the Hermes Adapter, adapter entry/export,
static manifest, existing registry export glue, package E2E script entry,
fixed bridge, focused test, E2E runner, and stage-gate evidence/log updates.
No Controller, DAG, Verification implementation, or Persistent State
implementation file was changed for Hermes.

FACT: The canonical Known External Gap Registry retains `GAP-01` as
`OPEN_NON_BLOCKING` for Codex runtime identity and retains the existing Agy
candidate gap. No `GAP-02` was added because Hermes supplied reliable
response-side identity.

TODO P2: Add a bounded `pph doctor --worker-clis` (or equivalent) discovery
report for installed agent/CLI candidates. This is post-Phase-14 convenience
work and does not block the current gate.

DECISION: T14.2 = PASS and Phase 14 Level-C Heterogeneous Multi-CRI = PASS.
Phase 12, Phase 13 T13.4, and P0 Multi-Worker MVP remain PASS unchanged.

WARNING: The known upstream `packages/ai/src/api/google-shared.ts:402`
`TS2322` remains untouched. The existing `process-worker.ts` lint warnings
remain precise known debt; no broad bypass or unrelated cleanup was performed.

### Lessons

- RATIONALE: A response-side model field from the same `post_api_request`
  event is materially stronger than requested/configured model metadata.
- RATIONALE: A local direct-alias route can be used only when the observed
  provider and response model are independently revalidated in the same run.
- RATIONALE: A strict synthetic-only bridge is the correct current boundary
  while the custom provider route's general data-transfer contract remains
  unreviewed; it proves T14.2 without broadening external data scope.
