# v3.0 Retroactive Audit Evidence Bundle

审计日期：2026-09-14（Asia/Taipei）
仓库：`/Users/chenglong/github/persional-pi-harness`
审计基线 SHA：`71b3e44297d20b43faf31a677c2f5224a9e57481`
工作树：基于该 SHA 的未提交审计补丁；本轮没有创建 commit、没有使用 `--no-verify`。

## Authoritative inputs

本轮唯一需求基线是用户上传的两个 v3.0 文件；仓库内 `sources/` 只读，不能用历史 v2 文件替代：

| Document | Local preview path | SHA-256 |
| --- | --- | --- |
| 01-Personal_PI_架构设计_v3.0.md | `/var/folders/pt/6nsbgd1d1ljdj7djgqdh9xmr0000gn/T/codex-file-preview-Um8Nub/01-Personal_PI_架构设计_v3.0.md` | `63bd83b86396dc43e7505ca3a322a0ff2add3a820de0e4c6e9d3ae5077c5edee` |
| 02-Personal_PI_可执行任务清单_v3.0.md | `/var/folders/pt/6nsbgd1d1ljdj7djgqdh9xmr0000gn/T/codex-file-preview-PtbBdM/02-Personal_PI_可执行任务清单_v3.0.md` | `45a7f08e16e19a631f8a5eacba42c92a49a66396408379254f6f5f1c63064105` |

## Repository evidence

| Check | Expected | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | auditable base | `71b3e44297d20b43faf31a677c2f5224a9e57481` |
| branch/remotes | Personal branch + upstream retained | `feature/t1-task-contract`; `origin` Personal fork; `upstream` `earendil-works/pi` |
| existing baseline tags | v0.1 tags present | `personal-pi-baseline`=`3b5bc5c8d2a7c4a236264022d73cb9e59b9365bd`; `PERSONAL_PI_V0.1_CORE_V1.1`=`c0c24d6743e6d6ed17a085a42e0e107d8a1dd17e0` |
| new audit commit | user did not request commit | none; all changes remain reviewable in working tree |

## Commands and results

```text
npm run test --workspace @personal-pi/core
25 test files passed; 142 tests passed

npm run build --workspace @personal-pi/core
passed

npm run check:protocol-isolation --workspace @personal-pi/core
protocol metadata isolation: PASS

npm run check:browser-smoke
passed

npm run test:scripts
23 tests passed

npm run test:personal-pi-regression
3 files passed; 23 tests passed

npm run check
Biome checked 1362 files; pinned dependencies, runtime dependencies,
TS imports, entry graphs, shrinkwrap and coding-agent install-lock passed.
The check stopped at the exact inherited error:
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.

./test.sh
scripts: 23 passed; packages/agent: 711 passed, 1 skipped;
@personal-pi/core: 142 passed.
The root run exited 1 because packages/coding-agent reported:
18 failed files, 248 passed, 7 skipped;
77 failed tests, 2162 passed, 54 skipped.
```

Targeted v3 run:

```text
npm exec --workspace @personal-pi/core vitest -- run \
  test/loop-budget.integration.test.ts \
  test/verifier-isolation.integration.test.ts \
  test/controller-restart.integration.test.ts \
  test/phase-7-real-e2e.test.ts \
  test/single-vs-multi.eval.test.ts \
  test/trace.test.ts --reporter=verbose --testTimeout=30000
6 files passed; 19 tests passed
```

## Failure injection evidence

| Case | Injection | Expected | Observed |
| --- | --- | --- | --- |
| A Loop Budget | Worker result is rejected by deterministic verification, Recovery starts a second Run, second Run fails, then another Run is requested | Task-level `max_attempts` stops the next admission; usage survives controller restart | `BLOCKED`; attempts=2; next `beforeRun` throws `LoopBudgetExhaustedError`; no active lease |
| B Work Receipt | `status=success`, empty artifacts, `state_changed=false`, `no_op=false`, no `no_op_reason` | `work_receipt_anomaly`; no normal DONE | Acceptance Gate throws anomaly; explicit `no_op=true` + reason reaches DONE |
| C Verifier Isolation | Worker emits a persuasive false explanation while deterministic command exits 1; rerun after removing explanation | Both conclusions and reasons remain FAIL/equal | Both runs `FAIL`; summary/private text absent from verifier DTO |
| D Graph Metrics | Real Trace events from local process E2E and single/multi comparison | derive all required fields, not only interface | `computeGraphEfficiencyMetrics` and `summarizeGraphEfficiency` produce fields and brief-compatible metrics |
| E Crash/Restart | SIGKILL controller after persisted RUNNING Run, start a new process using state file | recover CRASHED/BLOCKED, reject stale lease, retain effects/usage, restore snapshot | all assertions pass in `controller-restart.integration.test.ts` |
| F Replan/Handoff | replan with a new controller after budget exhausted; REASSIGN with `max_handoffs=0` | DENY/BLOCKED before unbounded re-entry | persisted DENY; no replacement lease; task BLOCKED |

## Local E2E and baseline artifacts

`phase-7-real-e2e.test.ts` launches actual local child processes (`local-e2e-worker.mjs` and `local-e2e-verifier.mjs`) for three distinct tasks. This is E2 local-process evidence: it proves process, artifact, persistence, independent command verification and trace replay. It is not an external Provider, production repository, or public deployment claim.

The same three task/action definitions, permissions, tools and budgets were used for the Single vs Multi Worker comparison. The latest successful run observed:

| Metric | Single Worker | Multi Worker |
| --- | ---: | ---: |
| worker_count | 1 | 2 |
| verified_success_rate | 1.0 | 1.0 |
| time_per_verified_task (ms) | 75.45468066666666 | 44.99808333333332 |
| cost_per_verified_task (USD) | 0 | 0 |
| handoffs | 0 | 0 |
| retries | 0 | 0 |
| verification_first_pass_rate | 1.0 | 1.0 |
| coordination_efficiency | 1.0 | 1.0 |
| graph_width | 1 | 2 |
| peak_active_workers | 1 | 2 |

Policy finding: this three-task local sample shows equal verified success and first-pass quality, with lower observed wall-clock time in Multi mode, but zero provider cost and zero handoff/retry coordination cost. It is not enough to claim general Multi-Worker superiority; a larger same-budget real Provider benchmark remains open.

Machine-readable copy of this comparison: `docs/stage-gates/evidence/single-vs-multi-2026-09-14.json`.

## Known upstream/PPH failures

These are retained as exact fingerprints and are not broad skips:

1. `packages/ai/src/api/google-shared.ts(402,10): error TS2322: Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.`
2. `packages/coding-agent` session/CLI tests still expect `pi`, while current PPH runtime returns `pph` (for example “Session file is not a valid pi session” versus “...pph session”).
3. `packages/coding-agent` package/resource/trust tests still expect `.pi` and old project paths, while runtime returns `.pph`/agent paths.
4. Experimental remote runtime tests report `Unknown session: demo-1` and `No discovered server contains session demo-1`.
5. fswatch test reports `no FSWatcher found among active handles`.

No Personal PI file in this audit modifies those areas. They prevent the repository-wide Phase 0 promotion gate from closing.

## Evidence file inventory

- Phase records: `docs/stage-gates/phase-00.md` through `phase-12.md`.
- Aggregate decision: `docs/stage-gates/v3-retroactive-audit.md`.
- v3 requirement mapping: `docs/stage-gates/v3-gap-matrix.md`.
- Machine-readable bound review: `docs/stage-gates/bound-coverage.md`.
- Source/test implementation: `packages/personal-pi/src/` and `packages/personal-pi/test/` listed in the aggregate audit.
- Failure/lesson log: `docs/.learnings/ERRORS.md` entry `ERR-20260914-030`.

## v3.1 delta evidence — 2026-09-15

The v3.1 implementation and strict blocker audit are recorded in
[`evidence/v3.1-runtime-controls-2026-09-15.md`](./evidence/v3.1-runtime-controls-2026-09-15.md).
The focused implementation/test commits are `3ee22da86`, `ceb796e6b`,
`14da4fc22` and `4eacafe55`; the v3.0 closure baseline and exact upstream gate
remain `9ff9b5b49`, `bfde9ffbe` and `58ef53c12` respectively.

### v3.1 package verification

```text
npm run test --workspace @personal-pi/core
32 test files; 174 tests PASS

npm run build --workspace @personal-pi/core
PASS

npm run check:protocol-isolation --workspace @personal-pi/core
PASS

npm run test:scripts
29/29 PASS

npm run test:personal-pi-regression
3 files; 23 tests PASS
```

The fresh isolated coding-agent package suite is `266/273` files and
`2239/2293` tests PASS. The isolated root `./test.sh` aggregate still exits 1
at the inherited client package entry-resolution baseline
(`packages/client/test/unix.test.ts` → `@earendil-works/pi-agent-core`), while
the other workspace results and Personal PI suite are recorded in the v3.1
evidence file. The exact upstream TypeScript failure remains visible to
`npm run check` and is admitted only by the exact fail-closed gate.

### v3.1 phase result summary

| Phase | v3.1 result |
| --- | --- |
| 0 | PPH differential closed (`76` expected identity fixture drifts; unexplained PPH-only `0`); repository aggregate still has inherited client baseline and exact upstream diagnostic under gate |
| 1 | PASS / CLOSED local core; B1–B12 machine audit pass |
| 2 | PASS / CLOSED regression confirmation |
| 3 | T3.2-A local contract PASS; strict five real Worker tasks BLOCKED_EXTERNAL |
| 4 | T4.2-B local pipeline/runtime PASS |
| 5 | PASS / CLOSED regression confirmation |
| 6 | T6.2-A local scoped-context PASS |
| 7 | T7.5 controlled local consolidation PASS; strict self-development/real long-cycle evidence BLOCKED_EXTERNAL |
| 8 | PASS / CLOSED regression confirmation |
| 9 | PASS / CLOSED regression confirmation |
| 10 | T10.4/T10.5 local runtime/policy PASS |
| 11 | PASS / CLOSED local evidence scope; real benchmark remains open |
| 12 | Progressive tools and structured notice PASS locally; two-backend real benchmark BLOCKED_EXTERNAL |

This is a final v3.1 audit result, not a T13 authorization. **NOT READY FOR
T13; STOP.**

## External Evidence Closure inventory — 2026-09-15

The sanitized capability/auth/quota inventory is available in
[`evidence/external-worker-inventory-2026-09-15.md`](./evidence/external-worker-inventory-2026-09-15.md)
and machine-readable form in
[`evidence/external-worker-inventory-2026-09-15.json`](./evidence/external-worker-inventory-2026-09-15.json).

Its hard-gate result is unchanged: no executable authorized Personal PI
adapter, no five-task real Worker run, no real self-development/long-cycle
pipeline, and no second real Worker backend. The current Codex App snapshot
identifies the prior native route's `gpt-5.6-luna` weekly model limit at 100%;
reset credits were not consumed. Local regression confirmation passed, and all
real-provider rows remain `BLOCKED_EXTERNAL`.

## External Evidence Closure — 2026-09-15 latest

The previous external inventory is superseded for current runtime status by the
reconciliation in [`evidence/external-worker-inventory-2026-09-15.md`](./evidence/external-worker-inventory-2026-09-15.md).
The PPH CLI is now available at version `0.85.1` through the repository's
generated, git-ignored bundle; upstream `pi 0.84.2` remains untouched.

The first real backend is now proven through the Personal PI Controller:

- Phase 3: `PASS_REAL_WORKER_TYPE_A`, five real PI/DeepSeek cases with
  sanitized Task/Run/Contract/Evidence/Trace identifiers and validated Work
  Receipts.
- Phase 7: `PASS_REAL_TYPE_A_BOUNDED`, three real Provider E2E cases (one
  malformed initial result followed once), a real disposable-worktree write
  and targeted test, and a controlled Trigger/Routine/Memory cycle.
- Raw machine records: `evidence/phase-03-real-worker-2026-09-15.json` and
  `evidence/phase-07-real-worker-2026-09-15.json`; self-development patch:
  `evidence/phase-07-self-development-2026-09-15.patch`.

The Type A evidence is synthetic/public-only and does not authorize the
third-party provider for internal repository data. Codex Type B remains
`BLOCKED_EXTERNAL`: the real CLI process did not echo model identity and the
adapter rejected observed `30118` input tokens against a `1500` bounded task.
No extra account, reset credit, purchase, push, merge or T13 action occurred.
The existing same-kind local Single/Multi benchmark is not promoted to an
heterogeneous result. Final decision: **NOT READY FOR T13; STOP**.

## Type B real execution and heterogeneous benchmark — 2026-09-15 latest

The latest bounded machine record is
[`evidence/phase-12-real-heterogeneous-2026-09-15.json`](./evidence/phase-12-real-heterogeneous-2026-09-15.json),
with implementation evidence base `b65fc5d95993c7fc9fc7ea4bffac3512237671a9`.
It records `/Users/chenglong/.local/bin/codex`, `codex-cli 0.154.0`, a
successful sanitized `authenticated_or_session_available` status, five-event
JSONL real executions and session digests only. The requested model was
`gpt-5.6-sol`, but platform-accepted and observed runtime model fields remain
`unknown`; no raw session ID, credential or provider output was stored.

The adapter is a separate `codex-cli` backend from the Type A
`pi-agent`/`opencodex` route. Local conformance is `10/10` PASS and the real
Type B smoke is Result/Receipt/independent-verifier PASS. Registry selection
is stable across three reads with explicit `pi`→Type A and `codex`→Type B.
The same five synthetic public tasks ran with identical projected context,
permissions, tools and loop semantics: Type A single was `5/5`, and
heterogeneous `A/B/A/B/A` was `5/5`. Single time per verified task was
`8555.27 ms`; heterogeneous was `11062.19 ms`; verification first pass,
handoffs, retries and coordination efficiency were `1.0`, `0`, `0` and `1.0`
respectively. Heterogeneous cost is unavailable because Codex did not return
cost. Fixed provider input overhead `29705` is separated from PPH projected
budget `1500`; effective provider ceiling is `31205` and Type B benchmark
projected input is `988`.

The formal Phase 12 state is
`PASS_EXECUTION_MODEL_IDENTITY_UNKNOWN`, not `PASS/CLOSED`. Pool lease,
429/500, cache rebuild and `HANDOFF_READY` checks remain backed by the local
core suite and Bound Coverage (`uncovered_paths=[]`). The final aggregate
root test passed on rerun; the normal check retains only the precise inherited
`google-shared.ts:402` baseline. Final decision remains **NOT READY FOR T13;
STOP**.
