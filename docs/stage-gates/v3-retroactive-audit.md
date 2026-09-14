# Personal PI Harness v3.0 Retroactive Stage Gate Audit

审计日期：2026-09-14（Asia/Taipei）
仓库：`/Users/chenglong/github/persional-pi-harness`
需求基线：用户上传的 `01-Personal_PI_架构设计_v3.0.md` 与 `02-Personal_PI_可执行任务清单_v3.0.md`。
审计基线：`71b3e44297d20b43faf31a677c2f5224a9e57481`，branch `feature/t1-task-contract`。
范围：Phase 0–12；明确不进入 T13。

## Executive verdict

**NOT READY FOR T13**

本轮已完成 v3.0 新增能力的 Personal PI 自有层修复和可执行测试，但不能把“核心包测试通过”扩大解释为“整个仓库通过 Stage Gate”。Phase 0、Phase 3、Phase 7、Phase 12 仍为 `PARTIAL / REOPENED`。完整根仓库检查和部分严格的真实运行证据尚未闭合，因此不允许进入 T13。

## Phase 0–12 status matrix

| Phase | Requirements / tasks | Scope/functional result | Static / regression result | Final verdict |
| --- | --- | --- | --- | --- |
| 0 | T0.1–T0.2 fork、baseline、upstream upgrade gate | Personal fork、upstream remote、两个 baseline tag 和升级 SOP 可追溯 | `npm run check` 命中已知 upstream TS error；`./test.sh` 命中 coding-agent PPH/rebrand failures | **PARTIAL / REOPENED** |
| 1 | T1.1–T1.6，含 T1.1-B、T1.4、T1.5、T1.6 | Task Contract、状态机、DAG、lease fencing、protocol isolation、Loop Budget 和 bound audit 均有实现与测试 | core 25 files/142 tests、build、protocol isolation pass | **PASS / CLOSED**（Personal PI 核心） |
| 2 | T2.0–T2.7 规划治理、DoR、Assessment、Dispatch、Role Profile | 规则预分类、风险交叉校验、reasoning mapping、Plan Gate、Role 边界测试通过 | planning tests pass；没有把本地 deterministic fixture 说成 live LLM/provider 证据 | **PASS / CLOSED**（代码/测试范围） |
| 3 | T3.1–T3.5 Worker、Result、Effect Journal、Work Receipt | PI Worker adapter、Result Contract、持久化 Effect Journal、异常 Receipt Gate 已修复 | worker/verification/effects tests pass；仅有 3 个 local process E2E，不满足清单中“5 个真实小任务”的更高证据要求 | **PARTIAL / REOPENED** |
| 4 | T4.1–T4.5 Evidence、Verifier、Isolation、Acceptance、Revision、Recipe | deterministic command evidence、sanitized verifier DTO、revision binding 和 acceptance anomaly 均通过 | targeted verifier isolation + package regression pass | **PASS / CLOSED** |
| 5 | T5.1–T5.5 Persistent State、Crash Recovery、Snapshot、Control-Plane Reconstruction | 实际 SIGKILL→新 Controller 进程；Run/Task/lease/epoch/loop_usage/effect/snapshot 可恢复，stale lease 被拒绝 | controller restart、effect persistence、persistence tests pass | **PASS / CLOSED** |
| 6 | T6.1–T6.5 Context Store、Manifest、Resolver、Cache、Compaction | Context hash/cache/recovery/held-out isolation 既有测试通过；本轮没有扩大上下文边界 | context tests、protocol isolation、full core regression pass | **PASS / CLOSED** |
| 7 | T7.1–T7.4 完整闭环、自举、Trigger、Routine Capture | 3 个真实 local child-process 任务完整走到 independent verification/DONE/trace replay；Trigger/no-op contract fixtures pass | Self-Development 和长期 always-on/模板复用仍非本轮真实外部运行证据 | **PARTIAL / REOPENED** |
| 8 | T8.1–T8.4 Dynamic Decomposition、Dependency、Artifact、Budgets | DAG/依赖/产物边和 persistent replan budget 通过；超限产生 DENY | graph intelligence + persistent replan tests pass | **PASS / CLOSED** |
| 9 | T9.1–T9.4 timeout/retry/resume/reassign | timeout、crash、malformed output、wrong result 四类故障均有分支和 Decision Record；reassign 前有 handoff budget gate | recovery tests pass；没有第三次无限自动改派 | **PASS / CLOSED** |
| 10 | T10.1–T10.3 permissions、least privilege、secret boundary | filesystem/shell/network/credentials/role upper bound 拦截测试通过 | security tests pass；未打印或复制凭证 | **PASS / CLOSED** |
| 11 | T11.1–T11.6 Trace、Decision、Regression、Metrics、Single baseline、Eval isolation | Trace 可回放；Graph Efficiency 从事件派生；3-task same-budget baseline 已记录 | trace/eval tests pass；local sample 不是生产成本/Provider benchmark | **PASS / CLOSED**（local E2 evidence） |
| 12 | T12.0-A、T12.1–T12.7 plugin/registry/pool/feedback/quota/cache | manifest、registry、pool、feedback、resilience、workspace cache 和 local Single/Multi 对照测试通过 | 运行的是同类 local process Worker；缺少两种真实外部 Worker/Provider 的稳定接入证据 | **PARTIAL / REOPENED** |

## Gate method applied to every Phase

每个 Phase 文档都记录同一组审计字段：

1. Scope / Requirement Audit；
2. Static Validation；
3. Functional Tests；
4. Failure Injection；
5. Persistence / Recovery Validation（适用时）；
6. Bound Coverage Audit；
7. Regression；
8. Evidence Collection、known upstream failures、unresolved issues 和 final verdict。

逐 Phase 记录见 [`phase-00.md`](./phase-00.md) 至 [`phase-12.md`](./phase-12.md)。命令、输出摘要、输入文件 hash、失败指纹和 baseline 数值集中见 [`evidence-bundle.md`](./evidence-bundle.md)。

## v3.0 additions

| Capability | Runtime state | Evidence |
| --- | --- | --- |
| P0-15 / Loop Budget | Task-level counters are persisted; before Run/model/tool/handoff admissions are hard gates; exhaustion is BLOCKED + human escalation | [`v3-gap-matrix.md`](./v3-gap-matrix.md), `loop-budget.integration.test.ts` |
| T1.6 Bound Coverage Audit | Machine audit returns `passed=true`, no uncovered active paths; future paths are explicitly controlled/inactive | [`bound-coverage.md`](./bound-coverage.md) |
| T3.5 Work Receipt | Invalid green/no-work result raises `work_receipt_anomaly`; explicit legal no-op can reach DONE | `verification.test.ts`, pipeline tests |
| T4.2-A Verifier Context Isolation | Exact whitelist strips Worker `summary`/private explanation; independent command evidence is persisted and used | `verifier-isolation.integration.test.ts` |
| T11.4-A Graph Efficiency Metrics | Trace-derived graph/worker/retry/useful-work/cost/time/coordination fields are computed and summarized | `trace.test.ts`, `single-vs-multi.eval.test.ts` |

## P0-15 audit result

The current active matrix is in [`bound-coverage.md`](./bound-coverage.md). The key invariant is:

```text
timeout/retry_policy = per-Run local controls
loop_budget = Task-lifetime cumulative controls across Runs
```

Covered active paths include Worker→Verifier failure/retry, repeated model calls, repeated verification tool calls, Recovery REASSIGN/handoff, and Decomposer replan. Controller crash/restart, `INSUFFICIENT_CONTEXT`, and snapshot restore are additionally recorded as controlled boundaries; none is an unbounded hidden loop. No free-form Swarm/Event Bus/cycle is enabled.

## Necessary fixes delivered

- Added persisted Task-level budget usage/decisions and hard admission gates for Run/model/tool/handoff calls.
- Persisted lease ownership and monotonic lease epochs; restart no longer resets fencing state.
- Persisted Effect Journal and action-digest mismatch checking; committed effects are reused after restart.
- Persisted snapshot payloads, digest validation, restore drill, and control-plane reconstruction fields.
- Sanitized verifier input and made pipeline verification consume persisted independent command evidence.
- Added Work Receipt semantic validation and corrected acceptance/run status when verification or receipt fails.
- Added persistent Decomposer replan budget enforcement.
- Added machine-readable bound coverage inventory and Trace-derived graph efficiency metrics.
- Added real local child-process E2E, SIGKILL restart, Effect Journal restart, verifier isolation, and Single-vs-Multi baseline tests.

## Known upstream failures and exact boundaries

The repository-wide gate is not green because of inherited failures outside the Personal PI change surface:

- `packages/ai/src/api/google-shared.ts(402,10): error TS2322: Type FinishReason.TOO_MANY_TOOL_CALLS is not assignable to type never.`
- `packages/coding-agent` session/CLI tests assert `pi` while the current PPH runtime returns `pph`.
- `packages/coding-agent` package/resource/trust tests assert `.pi` or old project paths while current runtime returns `.pph`/agent paths.
- Experimental remote runtime tests report `Unknown session: demo-1` and `No discovered server contains session demo-1`.
- fswatch test reports `no FSWatcher found among active handles`.

These failures are kept as exact fingerprints. No broad skip, test deletion, reliability weakening, or `--no-verify` was used. They are Phase 0 blockers, not evidence that Personal PI’s package tests failed.

## Commit and working-tree record

No new commit was created because the user requested audit/fix execution, not an automatic commit. Relevant existing commits that form the audited implementation chain are:

```text
71b3e44297d20b43faf31a677c2f5224a9e57481  audit base / current HEAD before this patch
f31398f2eaa5f826a57b4788be7542f5624f0d8e  role workspace cache export chain
7d1bbbbddbd28c2955ddfb2898fa9e73957b1e73  provider resilience controls
36af56807ed4f89a3bb5dad22f0f8e05f42eb836  worker success feedback
9d6d972cbb43dce79037544f692bf8158b70e51b  worker pool lifecycle manager
677c1b08e1cf88597c792e7cbf3992efced7aea3  worker registry and capability selection
723a3d25e8609f83a4b9fa129afe77a1519df34f  loop budget controller source inclusion
c05b30ffc685ffe14a7e194cb6dee8d5c0ee1973  v3 loop/receipt/verifier/graph initial implementation
2b9e791fbbca3718459d34e77693e8bac9d5c8e6  worker plugin manifest contract
69cf42d91b2dbc7d48118434c7e506e01c0ec5ab  trace and eval baseline
2c2fed56534340f0bb76bd1864f21c1bdb023e5a  permission boundaries
266b01a114c1c34d35b8415782994be0eaf25f95  recovery controls
973b25090c9710e38d1df1dd8a8e4e1a4426c674  graph intelligence
c0c24d6743e6d6ed17a085a42e0e107d8a1dd17e  PERSONAL_PI_V0.1_CORE_V1.1 tag target
```

The complete changed-file inventory is recorded below so review does not rely on a commit that does not yet exist.

## Changed-file inventory

### Personal PI implementation and contract fixtures

```text
packages/personal-pi/examples/task-contract.valid.json
packages/personal-pi/src/effects.ts
packages/personal-pi/src/graph-intelligence.ts
packages/personal-pi/src/index.ts
packages/personal-pi/src/lease.ts
packages/personal-pi/src/loop-budget.ts
packages/personal-pi/src/persistence.ts
packages/personal-pi/src/pipeline.ts
packages/personal-pi/src/recovery.ts
packages/personal-pi/src/result.ts
packages/personal-pi/src/trace.ts
packages/personal-pi/src/types.ts
packages/personal-pi/src/verification.ts
packages/personal-pi/src/bound-coverage.ts
```

### Tests and local evidence drivers

```text
packages/personal-pi/scripts/controller-process.mjs
packages/personal-pi/scripts/local-e2e-verifier.mjs
packages/personal-pi/scripts/local-e2e-worker.mjs
packages/personal-pi/test/controller-restart.integration.test.ts
packages/personal-pi/test/effects-persistence.integration.test.ts
packages/personal-pi/test/graph-intelligence.test.ts
packages/personal-pi/test/loop-budget.integration.test.ts
packages/personal-pi/test/phase-7-real-e2e.test.ts
packages/personal-pi/test/pipeline.test.ts
packages/personal-pi/test/recovery.test.ts
packages/personal-pi/test/single-vs-multi.eval.test.ts
packages/personal-pi/test/trace.test.ts
packages/personal-pi/test/triggers-routines.test.ts
packages/personal-pi/test/verifier-isolation.integration.test.ts
packages/personal-pi/test/v3-fixtures.ts
```

### Audit documents and learning record

```text
docs/stage-gates/phase-00.md ... docs/stage-gates/phase-12.md
docs/stage-gates/bound-coverage.md
docs/stage-gates/evidence-bundle.md
docs/stage-gates/v3-gap-matrix.md
docs/stage-gates/v3-retroactive-audit.md
docs/.learnings/ERRORS.md
docs/personal-pi/v3-backfill-evidence.md
docs/personal-pi/bound-coverage-audit.md
```

## Blocking items before T13

1. Close the exact upstream TypeScript failure and the existing coding-agent PPH/rebrand/runtime failures under the repository’s dual-suite upgrade gate; do not hide them with a broad skip.
2. Produce strict real-Worker evidence for the v3 task-list requirements that are currently only local E2: five T3.2 tasks, a T7.2 self-development run, and a longer always-on/trigger or routine capture run.
3. Produce a larger same-task/tool/permission/budget Single-vs-Multi benchmark with real allowed Providers/Workers; retain the current equal-success policy finding and do not assume Multi is better from three local tasks.
4. Review and commit the working-tree patch, then rerun the complete Stage Gate from the committed SHA.

Until all P0 Phase Gates are `PASS / CLOSED` and the repository evidence is committed and reproducible, the correct release status is **NOT READY FOR T13**.
