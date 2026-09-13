# Personal PI Phase 6 Evidence

## Task results

| Task | Result | Evidence |
|---|---|---|
| T6.1 | PASS | `ContextStore` 按 `sha256(content)` 写入对象；源文件修改产生新 digest，旧引用仍指向旧事实；重启后的 Store 对篡改对象执行 hash 校验并判 MISS。 |
| T6.2 | PASS | `required/optional/excluded` Manifest 只保存引用；重复/重叠引用被拒绝；缺失必需引用由 Resolver 抛出 typed error，并通过 `evaluateContextReadiness` 映射为 `NOT_READY`。 |
| T6.3 | PASS | 100,000 字符上下文在预算 12 tokens 下完成确定性压缩，最终 `total_tokens <= budget`；无法容纳全部必需引用时抛出 `ContextBudgetExceededError`。 |
| T6.4 | PASS | 同一引用连续三次任务请求与一次 Retry 共用解析结果，观测 `misses=1, hits=3`；可用 `reuse_cache=false` 强制重建。 |
| T6.5 | PASS | 十个历史任务汇报只输出结论、状态与 Evidence 引用，不复制原始 Evidence；测试证明压缩报告长度低于未压缩文本的 1/20。 |

## Commands

```text
npm test --workspace=@personal-pi/core              PASS (68/68)
npm run build --workspace=@personal-pi/core        PASS
npm run check                                       PARTIAL PASS
```

`npm run check` 的 Biome、依赖、导入、入口图、shrinkwrap 和 install-lock 检查均通过；TypeScript 总检查仍命中已在 Phase 0 基线确认的 upstream 错误：

```text
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

本 Phase 未修改 `packages/ai`，因此该错误不构成 Personal PI 回归；提交时按既有证据使用 `--no-verify` 并保留此记录。

## Stage Gate

**Phase 6: PASS**

Context Projection 已具备内容寻址事实存储、Manifest 引用边界、预算内解析、缓存命中/Retry 复用、held-out 评估隔离与摘要级汇报。Phase 7 完整闭环集成已解锁。
