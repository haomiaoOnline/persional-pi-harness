# Agy CLI candidate verification line — 2026-09-16

## Goal

Open a separate Phase 14 candidate line for the locally installed CLI described
by the user as “Apy”, identify its actual executable, and determine whether it
can serve as the second heterogeneous CRI. This line does not revise Phase 12,
Phase 13, P0 Multi-Worker MVP, or the parallel Hermes work.

## Prerequisites

- Authoritative v3.2 attachment hashes retained from the existing Phase 14
  records: architecture `31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480`;
  task list `a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b`.
- The `/mnt/data` copies were not present in this environment. The project
  mirror's v2.0 documents were not substituted as authority.
- Revalidated baseline: branch `feature/t1-task-contract`; HEAD
  `a84dd4c1fc77096b064d5038e5d8e69f6ac04f51`; no upstream tracking branch;
  `HEAD...origin/main = 29 0`; `HEAD...upstream/main = 51 0`.
- The worktree already contained unrelated/uncommitted Phase 12/13 and Phase
  14 gate changes. They were preserved; no reset, clean, commit, push, merge,
  or tag was performed.

## Steps and commands

1. Read-only repository and remote/divergence inspection.
2. PATH and local package-manager discovery for `apy`/`agy`, followed by
   version, binary type, help, models, agents, MCP, and remote-control checks.
3. Synthetic direct probes with `--output-format json` and
   `--output-format stream-json`; prompts and responses were not retained.
4. Added only the candidate adapter, its re-export, manifest, registry-facing
   export, focused tests, a real-probe script, and independent evidence.
5. Ran targeted Biome, core build, and candidate tests.
6. Ran one real Agy Worker E2E after increasing the bounded model-call allowance
   from 2 to 8 because the first attempt was blocked before Evidence by the
   controller budget. The successful E2E used synthetic data, no tools, denied
   network/credentials, no writable filesystem paths, and an ephemeral
   temporary workspace.

Representative commands (prompt text intentionally omitted):

```text
git status --short --branch
git rev-parse HEAD
git rev-list --left-right --count HEAD...origin/main
git rev-list --left-right --count HEAD...upstream/main
command -v apy
command -v agy
/Users/chenglong/.local/bin/agy --version
/Users/chenglong/.local/bin/agy --help
/Users/chenglong/.local/bin/agy models
/Users/chenglong/.local/bin/agy agents
/Users/chenglong/.local/bin/agy mcp list
/Users/chenglong/.local/bin/agy remote-control status
./node_modules/.bin/biome check <candidate files>
npm run build --workspace=@personal-pi/core
./node_modules/.bin/vitest run packages/personal-pi/test/agy-cli-candidate.test.ts
node packages/personal-pi/scripts/agy-cli-real-probe.mjs --output <ephemeral path>
```

## Results

The requested name `apy` is not on PATH. The actual installed executable is:

- binary: `agy`
- path: `/Users/chenglong/.local/bin/agy`
- version: `1.2.3`
- architecture: `arm64`
- noninteractive mode: `--print` / `-p`
- output: `text`, `json`, `stream-json`
- input: `text`, `stream-json`
- effort: `low`, `medium`, `high`
- useful event surface: `init`, `step_update`, `result`, plus usage and
  conversation correlation in the observed stream
- no MCP server was configured; remote-control daemon was not running

The direct stream probe emitted a conversation identifier, configured
`init.model`, step state/text/usage, and a final result. It did not emit a
response-side runtime model, provider/backend, request id, prompt id, or
finish reason. `init.model` is therefore recorded only as configured/requested
model and never as `observed_runtime_model`.

## Problems and root cause

- A first `--print` invocation used a separate argument and Agy correctly
  interpreted the following option as prompt text. The invocation was corrected
  to attach the prompt to `--print=<value>`.
- Agy's language-server startup and formatter write-back required the elevated
  local execution surface in this environment. No credential or prompt content
  was read to resolve this.
- The first full E2E reached three Agy response steps and hit the intentionally
  bounded `max_model_calls: 2` before Evidence. The candidate probe was rerun
  with `max_model_calls: 8`; it completed with one observed model call on the
  final run.
- Root cause of the candidate gap: the available Agy stream-json response
  surface exposes `conversation_id` and configured `init.model`, but not a
  same-run response-side runtime model or provider/backend identity.

## Decision and resolution

Decision: `Apy candidate verdict = BLOCKED_TELEMETRY`.

The candidate is executable and structurally feasible, but it cannot be a
second Level-C CRI evidence source until the same run exposes response-side
runtime identity. GAP-03 was added with `NON_BLOCKING` MVP impact. This is a
candidate telemetry limitation, not a redefinition of the Phase 14 gate.

Resolution delivered:

- `AgyCliWorkerAdapter` with a no-tool/no-action bridge, sanitized environment,
  bounded process execution, JSONL event parsing, response-side identity gate,
  no-op receipt on fail-closed paths, and metadata-only observation access.
- Static plugin manifest and adapter re-export.
- Focused tests for manifest/registry selection, heterogeneous backend naming,
  configured-only identity rejection, and response-side identity acceptance.
- One real E2E through Task Contract → Agy CLI → Result → Work Receipt →
  Evidence → Verification. The resulting failure is intentional and records
  the missing attestation rather than fabricating a pass.

No Controller, DAG, Verification, or Persistent State implementation was
changed. No formal all-CLI scanner was implemented; that remains a P2/TODO.

## Verification and evidence

- Targeted candidate tests: 3 passed.
- Core TypeScript build: passed.
- Real E2E: completed and persisted 1 Task, 1 Run, 1 Result, 1 Evidence, and
  1 Verification record.
- Real E2E PPH Run: `a04644c6-7e8a-4146-968b-49973b0b665c`.
- Agy `conversation_id` SHA-256 prefix: `e5eae7f854c5ad95`.
- `request_id_sha256`: `null`; `observed_runtime_model`: `null`;
  `provider_backend`: `null`; `identity_source`: `none`.
- Result digest:
  `5e4fdfbda6b1ffdc476147f8a81d0372af9b8c6f78cf115672b4968954c56f3a`.
- Work Receipt digest:
  `d67e32971f2ef856d467ba9ca8035e6d6a86bf1aec535994a7dfcfe7ef4e82d9`.
- Evidence digest:
  `d1b1eeb457d352c236c8f313333fe0ca97d37de901176fc6ea8a61a27cdea136`.
- Verification digest:
  `31857c39722c23411a6195ffff5799fe8e9c513e7ad747be985f855c75aa27e6`.
- Full sanitized machine evidence:
  `docs/stage-gates/evidence/agy-cli-candidate-e2e-2026-09-16.json`.
- Gap registry entry: `docs/stage-gates/known_gaps.yaml` → `GAP-03`.

## Stage gate

- Agy candidate: `BLOCKED_TELEMETRY`.
- Phase 14 overall: `NOT READY` unchanged.
- Phase 12, Phase 13, and P0 Multi-Worker MVP: PASS unchanged.
- T14.1/T14.2 and the independent Hermes line were not overwritten or
  reinterpreted.

## Lessons

CLI availability and a successful process run are not sufficient for a
heterogeneous CRI claim. The decisive evidence must bind the PPH Run to the
CLI conversation/session and to response-side model/provider identity in the
same machine-readable event stream. When those fields are absent, preserving
the execution evidence while failing closed is the correct candidate outcome.
