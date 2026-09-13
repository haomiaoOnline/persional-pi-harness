# Personal PI Phase 1 Evidence

## Scope

权威输入：`01-Personal_PI_架构设计_v2.1.md` 与 `02-Personal_PI_可执行任务清单_v2.1.md`。
本阶段只实现独立 `@personal-pi/core` 包，不修改 upstream 业务包。

## Task results

| Task | Result | Evidence |
|---|---|---|
| T1.1 | PASS | TypeBox v2.1 Task Contract、完整/缺字段/非法值示例，构建通过；校验器测试覆盖必填边界。 |
| T1.1-A | PASS | DoR 先复用契约校验；依赖未满足返回 `BLOCKED`，acceptance criteria 为空返回 `NOT_READY`。 |
| T1.2 | PASS | 显式迁移表覆盖正常路径、VERIFYING rework 和非法迁移审计。 |
| T1.3 | PASS | 五种边类型、拓扑排序、环路径定位和读回测试。 |
| T1.3-A | PASS | Mutation 在提交前对候选图做完整校验；模拟崩溃后当前图 revision/nodes/edges 均保持不变。 |
| T1.3-B | PASS | Artifact schema、digest、producer revision 三项绑定测试；上游完成但产物不合格时下游保持 `BLOCKED`。 |
| T1.4 | PASS | Worker A 旧 epoch 迟到结果返回 `stale_result`，不会覆盖 Worker B 的当前租约。 |
| T1.5 | PASS | PromptPayload 与 ProtocolEnvelope 为不同类型和不同构造路径；静态隔离检查通过。 |

## Commands

```text
npm run build --workspace=@personal-pi/core                         PASS
npm run test --workspace=@personal-pi/core -- --config vitest.config.ts PASS (14/14)
npm run check:protocol-isolation --workspace=@personal-pi/core       PASS
```

仓库级质量检查结果：

```text
npm run check                                                        FAIL (known upstream baseline only)
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

该错误在本阶段代码之前的只读 baseline 检查中已独立复现，且本阶段没有修改 `packages/ai`。因此不判定为 Personal PI 回归；提交时若需 `--no-verify`，仅针对该精确已知错误并保留本记录。

## Stage Gate

**Phase 1: PASS**

Gate 条件：T1.1–T1.5 的包级构建、单元测试、协议隔离检查全部通过；仓库级检查仅保留已知 upstream TS2322，未发现 Personal PI 新错误。下一阶段可进入 Phase 2。
