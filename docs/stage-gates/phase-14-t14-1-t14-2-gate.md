# Personal PI Harness — Phase 14 T14.1/T14.2 Stage Gate

Gate date: 2026-09-16
Baseline: v3.2
Decision: PASS
Level: C — Heterogeneous Multi-CRI

## Authority and retained prerequisites

The only governing standards are the user-supplied v3.2 architecture and
executable task-list attachments:

- architecture SHA-256:
  `31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480`
- task list SHA-256:
  `a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b`

`/mnt/data` was unavailable in this environment; the exact attachments
resolved from the referenced conversation match these hashes. The mirror's
v2.0 files were not used as a standard.

Phase 12 v3.2 Stage Gate, Phase 13 T13.4 Aggregate Gate, and the Personal PI
P0 Multi-Worker MVP remain PASS. This Phase 14 gate does not re-run, redefine,
or weaken those Level-B decisions.

## Current repository boundary

- branch: `feature/t1-task-contract`
- HEAD: `a84dd4c1fc77096b064d5038e5d8e69f6ac04f51`
- worktree: dirty from the retained uncommitted Phase 12/13 implementation,
  gate artifacts, and post-gate snapshot evidence
- `origin/main` divergence: ahead 29, behind 0
- upstream: not configured
- push, merge to main, and tag: none

Phase 14 source delta is limited to the Hermes Adapter, static manifest,
adapter entry/export, fixed synthetic bridge, focused tests, E2E runner, and
evidence. No Phase 14 change touched Controller, DAG, Verification, or
Persistent State.

## T14.1 — Adapter/Manifest/Registry boundary

Result: PASS for boundary conformance.

The existing second CRI route is registered as:

- Adapter source:
  `packages/personal-pi/src/adapters/codex-cli.ts`
- Adapter entry:
  `packages/personal-pi/adapters/codex-cli.ts`
- Plugin manifest:
  `packages/personal-pi/examples/worker-plugins/codex-cli-existing-session.plugin_manifest.yaml`
- Registry:
  `packages/personal-pi/src/registry.ts`
- manifest id: `codex-cli-existing-session`
- backend: `codex-cli`
- model declaration: `gpt-5.6-sol`
- authentication declaration: `none`

The Adapter source, adapter entry, manifest, Registry, plugin schema,
Pipeline, and Verification hashes match HEAD. The existing
`packages/personal-pi/src/persistence.ts` difference belongs to the already
accepted Level-B implementation and is not a Phase 14 change.

This is a conformance result for the pre-existing route. It does not claim
that the Codex route's identity gap was resolved.

The Hermes route added for T14.2 is registered as:

- Adapter source:
  `packages/personal-pi/src/adapters/hermes-cli.ts`
- Adapter entry:
  `packages/personal-pi/adapters/hermes-cli.ts`
- Plugin manifest:
  `packages/personal-pi/examples/worker-plugins/hermes-cli-custom.plugin_manifest.yaml`
- manifest id: `hermes-cli-custom`
- backend: `hermes-cli`
- model declaration: `ArkCoding/deepseek-v4-flash-ga-260731`
- reasoning declaration: `high`
- authentication declaration: `none`
- registry: existing generic `WorkerRegistry`; no Controller/DAG branch or
  Persistent State change

The bridge is deliberately limited to the explicit synthetic identity probe:
it sends no arbitrary stdin, enables no configured toolsets, and blocks any
Hermes tool call. The outer PPH Task Contract remains authoritative.

## T14.2 — Runtime identity attestation

Result: PASS.

Two real `codex-cli 0.154.0` probes were executed through the full Personal PI
path with a synthetic payload and isolated temporary workspace. No Worker
tools, actions, credentials, repository source files, or raw output were
used as evidence.

The second probe is the decisive run:

- process PID: `27085`
- session digest: `a02175e1516df38e`
- parsed JSONL events: `5`
- top-level keys: `item`, `thread_id`, `type`, `usage`
- `identity_fields_seen`: `[]`
- `observed_runtime_model`: `unknown`
- `provider`: `unknown`
- Result: `success`, legal no-op Work Receipt
- Evidence: recorded, independent verification command passed
- Verification: `PASS`, confidence `strong`
- Task: `DONE`; Run: `SUCCEEDED`

The first probe had the same absent identity surface and was budget-bounded;
the second probe raised the input budget and completed successfully, so the
missing identity is not explained by the first probe's budget limit.

The requested model `gpt-5.6-sol` is not used as an observed runtime value.
No configured model, UI value, or unbound log is accepted as attestation.

The decisive Hermes run is recorded in
`evidence/phase-14-hermes-e2e-2026-09-16.json`:

- Hermes version: `v0.18.2`
- PPH run id: `pph-t14.2-hermes-e2e-20260916-01`
- Hermes session id: `20260916_093528_3383fb`
- Hermes task id: `1069a6df-9544-4929-b164-73d68d6c2406`
- provider/backend route: `custom@127.0.0.1` / `hermes-cli`
- configured/requested model: `ArkCoding/deepseek-v4-flash-ga-260731`
- observed response-side model: `ArkCoding/deepseek-v4-flash-ga-260731`
- identity source: `post_api_request.response_model`
- API calls: `1`; finish reason: `stop`; API mode: `chat_completions`
- Result: `success`; legal no-op Work Receipt; Evidence and Verification:
  `PASS/strong`

The real heterogeneous comparison is explicit: the existing PI baseline is
`pi-agent/opencodex`, while this run is `hermes-cli/custom@127.0.0.1`. The
model string is the same observed value in both records; heterogeneity is
proven by the distinct Adapter/backend and provider routes, not by the model
name.

## Alternative backend check

Hermes is the selected independently attested replacement. The remaining
candidate inventory is retained for future work:

- `claude`: absent
- `gemini`: absent
- `opencode`: absent
- Cursor `3.18.9`: GUI, not a headless Worker backend
- `pi`: the already-used baseline PI CRI, not a new replacement second CRI
- `hermes`: present, real synthetic E2E PASS; selected for T14.2
- `agy`: executable candidate but response-side identity remains unavailable;
  retained as GAP-03

TODO P2: A bounded `pph doctor --worker-clis` (or equivalent) local discovery
report remains post-Phase-14 work and is not a gate dependency.

## Known External Gap

`GAP-01` remains:

- status: `OPEN_NON_BLOCKING`
- resolution: `Phase 14 Multi-CRI`
- MVP impact: `NON_BLOCKING`
- observed runtime model: `unknown`
- provider: `unknown`

Hermes does not resolve GAP-01; it supplies the separate heterogeneous route
needed by T14.2. No GAP-02 was created because Hermes provided reliable
response-side identity.

The gap registry remains fail-closed. It was updated to record that Hermes
now supplies the attested route while GAP-01 and GAP-03 retain their
non-blocking dispositions.

## Known upstream failure

The pre-existing diagnostic remains bounded to
`packages/ai/src/api/google-shared.ts:402`:

`TS2322: FinishReason.TOO_MANY_TOOL_CALLS is not assignable to never`

That file was not modified and no broad bypass was used.

## Verification status

- Phase 14-focused regression: PASS, 7 files and 36 tests
- Full `@personal-pi/core` test suite: PASS, 37 files and 199 tests
- Personal PI repository regression: PASS, 3 files and 23 tests
- Core package build: PASS
- Protocol isolation: PASS
- Pinned/runtime dependency, TypeScript import, entry-graph, shrinkwrap,
  coding-agent install-lock, browser smoke, and `git diff --check`: PASS
- Direct TypeScript check: KNOWN-UPSTREAM-FAILURE only, the TS2322 above
- Full `npm run check`: retained NOT GREEN because of two existing lint
  warnings in `packages/personal-pi/src/process-worker.ts`; the Hermes files
  pass their targeted Biome check and no broad bypass was used
- Repository upgrade gate: NOT RUN because clean-checkout and upstream
  preconditions are absent; this is not represented as a pass

## Gate decision

DECISION: Phase 14 Level-C Heterogeneous Multi-CRI = PASS.

T14.1 boundary conformance and the formal T14.2 Exit are met by the real
Hermes Worker run with same-Run response-side identity. Codex remains
fail-closed under GAP-01 and does not block this gate. Phase 12, Phase 13,
and the P0 Multi-Worker MVP remain PASS.

Canonical machine evidence:

[phase-14-multi-cri-2026-09-15.json](evidence/phase-14-multi-cri-2026-09-15.json)

[phase-14-hermes-e2e-2026-09-16.json](evidence/phase-14-hermes-e2e-2026-09-16.json)

Engineering log:

[phase-14-engineering-log.md](phase-14-engineering-log.md)
