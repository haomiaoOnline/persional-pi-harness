# External Worker / Provider Inventory — 2026-09-15

这是 External Evidence Closure 的脱敏盘点，基线为 `feature/t1-task-contract`
上的 `2a7d50b5f0bffef88c969c61e7032797a5f374b3`。本次没有登录、充值、升级、切换账号、消费 reset credit、发送仓库数据或进入 T13。

## 结论

当前没有同时满足“已授权、可执行、能由 Personal PI adapter 调用、能产出可验证 Work Receipt”的真实 Worker backend。因此：

- Phase 3 五个真实 Worker 任务：`0/5`，`BLOCKED_EXTERNAL`。
- Phase 7 三个真实 Provider E2E、disposable self-development、accelerated Trigger/Routine：均未执行，`BLOCKED_EXTERNAL`。
- Phase 12 第二种真实 backend conformance 与 real Single/Multi benchmark：未执行，`BLOCKED_EXTERNAL`。
- 最终：`NOT READY FOR T13`；T13 未进入。

## Usage-limit root cause

`get_usage_limits` 在 `2026-09-15T11:18:35+08:00` 返回：

| 信号 | 结果 |
| --- | --- |
| Overall Codex usage | primary 33%，weekly 78%，`ordinaryUsageAllowed=true` |
| `base_model_inference` | `normalModelSlug=gpt-5.6-luna`，weekly window 100% |
| model-limit reset | `2026-09-16T12:20:07+08:00` |
| reset credits | 2 available，0 consumed |

这说明之前 native Worker 的限制是 Codex 账号中 `gpt-5.6-luna` base-model 周额度耗尽；不是 Personal PI 的 Result/Receipt 序列化失败。此前两次 native attempt 都在产生可审计结果之前停止，`platform_accepted_model` 与 `observed_runtime_model` 都保持 `unknown`。原始平台错误 payload 未在本轮重新发出，因此不扩大为 HTTP/CLI/adapter 的更细分类。

## Capability and auth inventory

| Surface / backend | 版本或运行时信号 | 认证状态 | 结论 |
| --- | --- | --- | --- |
| Personal PI adapter | `WorkerAdapter`/`PiWorker` 接口存在；manifest 指向的两个 `adapters/*.ts` 不存在 | unknown | 无真实 adapter，硬阻塞 |
| PPH | 仓库声明 `pph` bin，但 `packages/coding-agent/dist` 不存在且不在 PATH | unauthenticated/unknown | 无可执行 PPH CLI |
| upstream PI | 全局包 `@earendil-works/pi-coding-agent@0.84.2`，直接运行版本为 `0.84.2` | unknown | 是 `pi`，不是 `pph`，且未接入 Personal PI |
| Codex App native surface | `multi_agent_v1__spawn_agent` schema 可见；`gpt-5.6-luna` 命中周额度限制 | App usage read authenticated | 有 surface 但当前路线 usage-limited；仍无 Personal PI adapter |
| OpenCodex local proxy | 包 `2.54.0`；配置端口 `10100`；listener 曾被观察到，但 `/v1/models` 与 `/` 连接失败 | unknown | 不稳定/不可用，不作为 backend |
| ArkCLI | 包/直接 binary `1.0.3`；不在 PATH；配置 metadata 存在但未读内容 | unknown | Provider 不在本项目 internal allowlist，不使用 |
| Claude | 官方 `claude` binary 不在 PATH；只有 opaque config marker | unknown | 无可执行 CLI/adapter；不使用 `openclaude` 冒充官方 |
| Gemini | 官方 CLI 不在 PATH；`.gemini/.env` 为空；Antigravity.app 存在 | official API 未认证；Antigravity blocked | 不使用第三方 Antigravity 路径 |
| Ollama | App 存在；`127.0.0.1:11434/api/tags` connection refused | not applicable | local model backend 不可用 |

凭证只做了存在性/空值级别的探测；没有读取或输出 token、API key、cookie、OAuth 内容、账号标识或完整凭证路径。`OPENAI_BASE_URL` 只显示为 `ark.cn-beijing.volces.com`，但 API key 为空，不能据此推断有可用 OpenAI API。

## Exact blockers and release conditions

### Phase 3

`EXT-WORKER-ADAPTER-001`：Personal PI 当前只有注入式 callback adapter；manifest 中的
`adapters/codex-cli.ts` 和 `adapters/claude-cli.ts` 没有实现。解除条件是：在
`provider_allowlist=openai`、凭证/条款/配额通过后，存在真正可执行的 adapter，能把五个小任务完整送过
Adapter → Worker → Result → Work Receipt → Evidence → independent Verification。

### Phase 7

Phase 3 硬门未满足，所以本轮不创建 disposable worktree，不修改自身，不运行真实 Provider E2E，也不把受控 local schedule 当成长周期生产证据。解除条件是先完成 Phase 3，然后再分别取得 `3/3` real-provider E2E、self-development patch/digest/verification，以及 accelerated-time 的真实 trigger pipeline 记录。

### Phase 12

`EXT-WORKER-BACKEND-002`：静态 manifest 的两个 CLI 示例与 callback 测试不构成两个真实 backend；全局包存在也不等于 Personal PI adapter 可用。现有 Single/Multi 只是同一种 local-process Worker kind 的三任务 baseline（两边 verified success rate 均为 1.0，cost/handoff/retry 均为 0），不升级为异构 backend 证据。解除条件是第二种授权 backend 通过 conformance，再用相同 tools/permissions/context/budget 做 real benchmark。

## Regression confirmation

本轮在受控仓库验证权限下复核：

```text
Personal PI: 32 files / 174 tests PASS
Personal PI build: PASS
Protocol isolation: PASS
Script suite: 29/29 PASS
Personal PI regression: 3 files / 23 tests PASS
```

第一次无权限执行时，Vitest/build/npm fixture 写入被沙箱拒绝；重跑结果如上，详见
`.learnings/ERRORS.md` 的 `ERR-20260915-005`。没有源码改动。

## Evidence boundary

Existing local child-process E2E、local callback adapters、same-kind local Single/Multi、injected 429/500 circuit-breaker tests 和 cache rebuild tests继续保留为 local/contract evidence；它们不能升级为 real Provider、real self-development 或 second-backend evidence。Known-Upstream-Failure gate 与 inherited client entry baseline 仍单独登记，不与本次 external blocker 混合。
