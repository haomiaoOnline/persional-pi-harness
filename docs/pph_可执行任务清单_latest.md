# Personal PI Harness — 可执行任务清单（Latest）

> 配套文档：《pph_架构设计_latest.md》。本文档是唯一持续更新的任务清单权威源，自包含，不需要对照历史版本阅读。所有变更记录于文末"版本日志"。
> **使用方式**：`latest` 随时可能被继续修改；若要在其基础上开始一段实现工作，先从本文件打一份完整快照（如 `pph_可执行任务清单_v3.5.md`），实现期间以快照为准，`latest` 继续独立滚动更新。
> **红线纪律不变：不允许跳阶段；每个 Phase 结束必须跑 Stage Gate，PASS 才能打开下一 Phase。**

---

## 使用说明

- 优先级：`P0`=内核闭环必需 / `P1`=生产可用性必需 / `P2`=规模化执行 / `P3`=智能优化
- 每任务字段：优先级 / 需求详情 / 数据来源 / 权限 / 实现方案 / 失败恢复 / 验证方法 / 完成标准
- **首批建议交给 AI 的任务范围**：Phase 0 + Phase 1 全部（见文末"启动建议"）

---

## Phase 0 — P0：Fork 与工程基线

### T0.1 建立 Personal PI Fork
- **需求**：建立 Upstream→Personal 可持续同步 Fork。
- **数据来源**：官方 PI 上游仓库。
- **权限**：Git 全权限；远程仓库创建/推送权限。
- **实现**：Fork 保留 upstream remote；分支策略 `main/upstream-sync/feature/*/release/*`；打 `personal-pi-baseline` tag。
- **失败恢复**：冲突则回滚到原始 commit 重新 fork，不夹带定制修改。
- **验证**：启动/对话/Tool/文件读写/Shell/Git/Session/Skill/Extension 全部正常。
- **Exit**：`PERSONAL_PI_BASELINE` 标签建立且 8 项验证通过。

### T0.2 Upstream Upgrade Gate
- **需求**：保证上游更新不破坏定制层。
- **数据来源**：上游 release diff。
- **权限**：CI 配置权限。
- **实现**：两套测试套件（Upstream Compatibility Suite + Personal PI Regression Suite）；流程 `fetch→upstream-sync→merge/rebase→双套测试→PASS 才合并 main`。
- **失败恢复**：任一套件 FAIL → 停止合并，回退到上一稳定 tag。
- **验证**：模拟一次上游合并，走完整流程得到明确 PASS/FAIL。
- **Exit**：升级 SOP 文档化且可重复执行。

### T0.3 Known External Gap Registry（v3.2 新增）
- **优先级**：P1，建议现在建立机制，具体登记项随实施过程持续新增
- **需求**：建立通用的外部依赖能力缺口登记格式（`symptoms/evidence/root_cause/decision/resolution/current_consequence/mvp_impact`），任何第三方 CLI/Provider 的能力限制发现后必须先登记，明确 `mvp_impact` 是 `BLOCKING` 还是 `NON_BLOCKING`，不允许在讨论中反复重新判断。
- **数据来源**：架构文档第 37 节 Known External Gap Registry；首个登记案例 GAP-01（Codex CLI `observed_runtime_model` 无法可靠获取）。
- **权限**：无。
- **实现方案**：
  1. 维护一份 `known_gaps.yaml`（或等价存储），每条 Gap 按标准字段登记。
  2. Gap 登记时必须明确 `mvp_impact`；`NON_BLOCKING` 的 Gap 不得以任何理由阻塞与其无关的 Phase。
  3. Verification 标准不得为配合某个 Gap 而降低——正确处理方式是"延期"（Resolution 字段写明延期到哪个 Phase），而不是放宽验证要求让相关功能勉强通过。
- **失败恢复**：发现有人试图通过降低 Verification 标准来"绕过"一个 Gap（而不是正式登记延期）→ 视为流程违规，撤销该次绕过，走正式登记流程。
- **验证方法**：用 GAP-01（Codex 案例）作为第一条真实登记，验证字段完整、`mvp_impact=NON_BLOCKING` 判定有据可查，且 Phase 12/13 的 Stage Gate 确实未被这条 Gap 阻塞。
- **Exit**：Gap Registry 机制建立，GAP-01 完整登记在案。

---

## Phase 1 — P0：Task Contract 与可靠性不变量

### T1.1 Task Schema 定义（v3.0 全字段）
- **需求**：定义架构文档第 5 节完整字段集，含 `schema_version/task_revision/graph_revision/role_profile_ref/artifact_dependencies/verification.strength/verification.recipe_ref/approval/reasoning_depth/capability_tags/loop_budget`。
- **数据来源**：架构设计 v3.0 第 5 节。
- **权限**：无外部权限。
- **实现**：JSON Schema/Pydantic/Zod 强类型定义 + Validator + 3 个示例任务（正常/缺字段/非法值）。
- **失败恢复**：字段冻结 v1，新字段一律 optional，不破坏已有任务。
- **验证**：必填字段缺失（如 `permissions`/`verification`）必须 FAIL。
- **Exit**：Validator 单测覆盖率 100% 覆盖必填字段缺失场景。

### T1.1-A Definition of Ready（DoR）
- **优先级**：P1
- **需求**：Ready 判定前必须复用 T1.1 Schema Validator 做一次前置复检，不仅看依赖是否满足。
- **数据来源**：Task Contract 自身。
- **权限**：无。
- **实现**：Dependency Resolver 判定"依赖满足"后，插入一次 Schema 复检，两者都过才置 READY。
- **失败恢复**：Schema 不合格 → 保持 `NOT_READY`，退回创建者补全，不允许带着不完整契约进入执行。
- **验证**：构造依赖满足但 acceptance_criteria 为空的 Task，验证其不会变成 READY。
- **Exit**：DoR 拦截测试通过，且未增加明显的额外延迟（复用已有校验器，零新增 LLM 调用）。

### T1.1-B Loop Budget 字段与执行器（v3.0 新增，落地 P0-15）
- **优先级**：P0
- **需求**：Task Contract 增加 `loop_budget`（`max_attempts/max_model_calls/max_tool_calls/max_handoffs/max_elapsed_ms/max_input_output_tokens/max_cost_usd/max_state_growth_bytes/on_exhaustion`），Controller 维护每个 Task 的累计计数器，覆盖跨 Run 的整条反馈路径，不与单次 Run 的 `timeout`/`retry_policy` 混淆（后者是局部约束，前者是全局兜底）。
- **数据来源**：架构文档第 5 节 Schema、第 22.1 节说明。
- **权限**：Persistent State 读写权限（累计计数器需要持久化，防止 Controller 重启后计数丢失导致预算形同虚设）。
- **实现方案**：
  1. Persistent State 为每个 Task 维护 `loop_usage`（累计 attempts/model_calls/tool_calls/handoffs/elapsed_ms/tokens/cost/state_growth）。
  2. 每次 Run 开始前、每次工具调用前，Controller 先检查是否超出 `loop_budget` 对应维度，超出则拒绝继续，触发 `on_exhaustion.action`（默认 `BLOCKED` + 上报人工）。
  3. 计数器随 Run/Result 一并持久化，Controller 崩溃重启后可从 Persistent State 正确恢复累计值（复用 T5.3 Crash Recovery 的读状态逻辑）。
- **失败恢复**：计数器丢失或与实际执行不一致 → 保守估计（宁可提前拦截也不允许透支），并记录数据不一致事件。
- **验证方法**：**关键测试**——构造一个"Worker 反复失败→Repair→重试"的场景，验证达到 `max_attempts` 后系统强制 `BLOCKED` 并上报人工，即使每次单独的 Run 都没有超过自己的 `timeout`。
- **Exit**：Loop Budget 拦截测试通过，且 Controller 重启后计数器不丢失（复用 T5.3 崩溃恢复验证一并测试）。

### T1.2 Task State Machine
- **需求**：`DRAFT/READY/RUNNING/VERIFYING/DONE/FAILED/BLOCKED/CANCELLED/OBSOLETE` 及合法迁移表。
- **数据来源**：架构状态机定义。
- **实现**：显式迁移表，非法迁移抛异常并记录日志。
- **失败恢复**：发现遗漏的合法路径 → 加入迁移表并补测试，禁止绕过校验直接改字段。
- **验证**：穷举非法迁移必须拒绝；合法迁移（含 REWORK）必须成功。
- **Exit**：迁移测试全绿，且有审计日志。

### T1.3 Task Graph（DAG）
- **需求**：Node+带类型 Edge+环检测，五种边类型。
- **数据来源**：架构第 6 节。
- **权限**：存储层写权限。
- **实现**：`nodes`/`edges` 表（含 edge_type）；拓扑排序做环检测。
- **失败恢复**：检测到环 → 拒绝写入，返回环路径定位。
- **验证**：`A→C,B→C` 支持；`A→B→A` 拒绝。
- **Exit**：DAG 读写与环检测单测全绿。

### T1.3-A 原子 Graph Mutation
- **优先级**：P0
- **需求**：Decomposition 产出的一批子任务+依赖边必须整批提交，不允许逐条 insert 导致半成品图。
- **数据来源**：T8.1 Decomposition 输出。
- **权限**：数据库事务权限。
- **实现**：单次事务提交整批 Node+Edge；Master 中途崩溃时事务自动回滚，不留半成品。
- **失败恢复**：事务失败 → 整批不生效，父任务保持原状态，允许重新分解。
- **验证**：模拟分解到一半时进程被杀，重启后 Graph 中不存在半成品子任务。
- **Exit**：原子性测试通过，无残缺依赖边案例。

### T1.3-B Artifact Handoff Contract Binding
- **优先级**：P1
- **需求**：`PRODUCES_ARTIFACT` 边支持 `readiness.requires_artifact` + `binding.artifact_digest/producer_task_revision`，上游 DONE 不自动等于下游 READY。
- **数据来源**：架构文档第 13 节 Artifact Handoff Contract。
- **权限**：Artifact Store 读权限。
- **实现**：下游 Ready 判定新增一步——检查绑定的产物是否存在、schema 是否匹配、digest 是否与声明一致，三者都过才置 READY。
- **失败恢复**：产物 schema 不匹配 → 下游保持 BLOCKED，记录原因"产物契约不匹配"，交由上游修正重新产出。
- **验证**：模拟 Backend 任务产出一个字段缺失的 API Contract，验证 Frontend 任务不会被错误置为 READY。
- **Exit**：Artifact Handoff 绑定测试通过，且能观察到"上游 DONE 但下游仍 BLOCKED"的正确中间态。

### T1.4 Fencing Token（Lease Epoch）
- **优先级**：P0（若已存在异步/超时机制则强制,否则可与 Phase 9 一并实现）
- **需求**：Lease 使用单调递增 `lease_epoch`；过期 epoch 的迟到结果一律拒绝。
- **数据来源**：Controller 派单/租约记录。
- **权限**：Persistent State 写权限。
- **实现**：每次派单生成新 epoch；Worker 结果必须携带领取时的 epoch；Controller 只接受当前最新 epoch。
- **失败恢复**：收到过期 epoch 结果 → 丢弃并记录"stale result rejected"事件，不影响当前有效 Run。
- **验证**：模拟 Worker A 超时被重新派发给 Worker B 后,Worker A 才迟到返回结果,验证该结果被拒绝且不覆盖 B 的正确结果。
- **Exit**：迟到结果拒绝测试通过。

### T1.5 Protocol Metadata Isolation Rule
- **优先级**：P0
- **需求**：`schema_version/task_revision/graph_revision/lease_epoch/idempotency_key/action_digest` 只在协议层传递,禁止整体注入 Prompt。
- **数据来源**：架构 P0-13。
- **实现**：Worker Adapter 层维护独立"协议信封"对象,与 Prompt Payload 物理隔离；Prompt 组装函数不可直接访问协议字段；CI 静态检查禁止字段名在 Prompt 拼装路径中出现。
- **失败恢复**：发现泄漏 → 视为 token 治理回归缺陷,立即修复并补充静态检查规则。
- **验证**：抽查真实 Worker 调用的 Prompt 全文,协议字段不得以原始形式出现。
- **Exit**：静态检查上线,连续 10 次抽查无泄漏。

### T1.6 Bound Coverage Audit（v3.0 新增，落地 P0-15）
- **优先级**：P0
- **需求**：把"每一条可能重新进入先前执行状态的路径都必须有确定性预算覆盖"作为 Stage Gate 的固定审查项，不是运行时组件，是设计纪律。
- **数据来源**：当前系统里已知的所有循环路径清单（Worker↔Verifier↔Repair、Decomposer 递归，以及未来 Phase 12+ 的多 Agent 交接循环）。
- **权限**：无（纯文档/审查流程）。
- **实现方案**：
  1. 维护一份"循环路径清单"文档，每条路径标注对应的覆盖预算字段（如 `loop_budget.max_attempts`、`decomposition_budget.max_replan_count`）。
  2. 每次 Stage Gate 验收（T0.1 起，贯穿所有 Phase）除功能测试外，新增一步：核对清单里的路径是否都有覆盖，新出现的循环路径（如 Phase 12 引入的 Worker 交接）必须先补覆盖字段再通过 Gate。
- **失败恢复**：发现一条路径没有任何预算覆盖 → Stage Gate 不得判定 PASS，先补覆盖（哪怕是保守的硬编码上限）再重新验收。
- **验证方法**：人工审查当前 Phase 1-7 范围内的循环路径清单，确认 Worker↔Verifier↔Repair 已被 `loop_budget` 覆盖，Decomposer 递归已被 `decomposition_budget` 覆盖。
- **Exit**：循环路径清单建立，且截至 Phase 7 的所有已知循环路径均有覆盖记录。

---

## Phase 2 — P0/P1：Master 控制平面 + 规划治理

### T2.0-B Task Compiler / Ingress Gate（v3.3 新增，落地 P0-17，重大缺口修复）
- **优先级**：P0，先于 T2.0 执行（用户请求最先经过此关卡，再进入 Fast/Slow 分类）
- **需求**：任何面向用户的执行入口（CLI/交互式会话/coding-agent）在执行超出预设边界的多步骤实质性工作前，必须验证 Pipeline 是否已正确接入（TaskContract 创建能力、Dispatch 能力、LoopBudget 挂载能力、PersistentState 写入能力全部就绪）；验证不通过必须 Fail-Closed。
- **数据来源**：架构文档第 38 节；触发本任务的真实事故——一次 7 小时 14 分钟的交互式 coding-agent session，Pipeline 全部组件已实现但从未被该入口调用，最终因 Provider context-limit 报错失控中止。
- **权限**：无新增权限，是对现有入口的一层强制拦截。
- **实现方案**：
  1. 在每个执行入口（尤其是交互式 `pph` coding-agent 的 `session-manager.ts`）的启动路径上，插入一次显式探测：`PersonalPiPipeline` 是否已被正确构造并可用。
  2. 探测通过 → 正常将用户请求转换为候选 TaskContract，进入 T2.0 Fast/Slow 分类。
  3. 探测不通过 → 触发 Fail-Closed 分支：拒绝执行**或**降级为单一受限任务，降级路径必须使用**独立于 Pipeline 组件之外的硬编码红线**（如 `max_tool_calls`、`max_elapsed_ms`，直接写在入口代码里，不依赖 LoopBudgetController 本身）——因为这次事故已证明 LoopBudget 组件可能压根没被这条路径调用，不能用它去防止自己失效。
  4. 明确禁止的降级方式：入口自行在同一会话内批量调用工具、自称"模块隔离/并行检查"来模拟多 Worker 协作（见架构文档第 18 节新增反模式）。
- **失败恢复**：探测逻辑本身异常 → 保守判定为"未接入"，走 Fail-Closed，不允许"探测失败就默认放行"。
- **验证方法**：**关键测试**——复现事故场景：故意让 Pipeline 构造失败（如缺少必要配置），验证交互式入口在这种情况下拒绝执行长任务或明确降级为硬编码预算限制的任务，而不是无限制地持续调用工具。
- **Exit**：Fail-Closed 分支测试通过；正常接入分支测试通过；两分支覆盖所有已知执行入口（至少覆盖交互式 coding-agent 这一条曾经出事的路径）。

### T7.0 Ingress Binding Verification（v3.3 新增，先于 T7.1 执行）
- **优先级**：P0
- **需求**：不同于 T7.1（验证 Pipeline 内部链路正确），本任务验证"用户真实敲命令这个动作，是否真的走到了 Pipeline"——这是 T7.1 成立的前提，此前从未被单独验证过。
- **数据来源**：架构文档第 38.3 节。
- **权限**：无。
- **实现方案**：不 mock 任何组件，从真实用户入口（如 `pph` CLI）发起一个请求，断言：`TaskContract` 被创建、`Dispatch` 被调用、`LoopBudget.beforeRun` 被触发、`PersistentState` 有对应写入，四者缺一即判失败。
- **失败恢复**：任一断言失败 → 视为 P0-17 违反，阻断该入口投入使用，退回 T2.0-B 检查 Ingress Gate 实现。
- **验证方法**：对每一个新增或修改过的执行入口，运行此断言集，而不是只在 Pipeline 内部做单元/集成测试。
- **Exit**：至少交互式 coding-agent 入口通过该验证——这是本次事故对应的具体路径，必须优先补齐。

### T2.0 Fast/Slow Risk Preclassifier
- **优先级**：P1（必须在首个 E2E 前完成）
- **需求**：规则式（零 LLM 成本）预分类：文件数/关键词/历史成功率 → FAST 直接进 SINGLE_WORKER；命中高风险关键词或规则判不清 → SLOW 走完整 Assessment+Plan Quality Gate。
- **数据来源**：Task 描述 + 项目文件路径 + T11.5 历史成功率统计。
- **权限**：项目结构只读。
- **实现**：关键词/路径规则表（如涉及数据库迁移/权限模型/对外接口→强制 SLOW）。
- **失败恢复**：规则误判为 FAST 导致实际风险 → 走 T2.0-A 流程,补充规则。
- **验证**：20 个已标注任务测试,FAST/SLOW 分类准确率 ≥ 90%（尤其不能漏判高风险为 FAST）。
- **Exit**：分类准确率测试通过。

### T2.0-A Preclassifier False Negative Tracking
- **优先级**：P1-Early
- **需求**：单独追踪"高风险任务被误判为 FAST"的假阴性事件,不与通用 Plan Regression 混记。
- **数据来源**：T15.3 事后复盘。
- **实现**：`preclassifier_incident` 记录（task_id/predicted_path/missed_signal/correction）；每次假阴性强制提交一条规则修正。
- **失败恢复**：同类信号连续 2 次假阴性仍未覆盖 → 该类任务模式强制降级为 SLOW 兜底。
- **验证**：复现历史假阴性案例,验证规则修正后被正确分类为 SLOW。
- **Exit**：假阴性事件数量随迭代呈下降趋势。

### T2.1 Master 身份与边界
- **需求**：Master 永不直接修改业务代码,只创建/更新 Task。
- **权限**：仅 Task 读写权限,物理不挂载业务代码写权限。
- **实现**：权限层隔离（Master 进程无业务目录写权限）。
- **失败恢复**：违规直接修改 → 记录异常,回滚,加固隔离。
- **验证**：10 次不同任务测试,Master 均未直接产生 diff。
- **Exit**：违规测试 0 次触发。

### T2.2 Task Assessment + 规则级交叉校验
- **需求**：结构化输出 `scope/workload/risk/uncertainty/dependency/parallelism/verification/context_budget/confidence`,并用确定性规则交叉校验（涉及数据库迁移/权限/接口关键词 → risk 至少 medium,Master 说了不算）。
- **数据来源**：Task 描述 + 项目上下文只读引用。
- **实现**：Prompt 模板 + JSON Schema 校验 + 规则引擎覆盖判断。
- **失败恢复**：连续 2 次不合规 → 降级人工填写。
- **验证**：同一 Task 连续 5 次运行,字段结构稳定；规则命中场景下 risk 不能被模型判成 low。
- **Exit**：稳定性+规则覆盖测试通过。

### T2.3 Dispatch Policy（含 worker_tier 与 Role Profile 匹配）
- **需求**：输出 `SINGLE_WORKER|DECOMPOSE|PARALLEL|BATCH` + `worker_tier: cheap|standard|frontier` + 若 Task 声明 `role_profile_ref` 则先按角色边界圈定候选 Worker 范围。
- **数据来源**：Assessment 输出 + Worker Capability + Role Profile。
- **实现**：规则引擎/决策表,每次决策强制写 Decision Record（含 reason）。
- **失败恢复**：判断错误导致返工 → 记为 Regression Case,不在此阶段改算法。
- **验证**：20 个标注任务,Policy 判断准确率 ≥ 80%；含角色任务能正确圈定候选范围。
- **Exit**：准确率与 Decision Record 可追溯性测试通过。

### T2.3-A Reasoning Depth 确定性映射（v2.1 新增）
- **优先级**：P1
- **需求**：Task Contract 增加 `reasoning_depth: low|medium|high|extended` 与 `capability_tags: []` 字段；`reasoning_depth` 必须由确定性规则从 T2.2 Assessment 已算出的字段推导，禁止为此新增一次 LLM 判断往返。
- **数据来源**：T2.2 Task Assessment 输出的 `risk/uncertainty/workload/dependency/confidence`。
- **权限**：无。
- **实现方案**：
  1. 在 T2.3 Dispatch Policy 的规则引擎里追加一张映射表：
     ```
     risk=low AND uncertainty=low AND workload=small        → low
     risk=medium OR verification.strength=weak               → medium
     risk=high OR dependency=complex OR confidence<0.6        → high
     架构决策/Plan Quality Gate 自身评估（T2.5/T2.6）          → extended
     ```
  2. `capability_tags` 由规则从任务描述/`scope.files` 中提取关键词生成（如涉及浏览器操作→`browsing`，涉及数据处理→`math`），当前阶段只落盘记录，不参与实际路由（Multi-Worker 尚未实现）。
- **失败恢复**：映射结果与实际执行质量不符（如 `low` 强度导致任务反复失败）→ 记为 Regression Case（并入 T15.3），修正映射规则阈值，不允许改为"每次都问模型"。
- **验证方法**：构造 5 个不同风险等级的任务，验证 `reasoning_depth` 输出符合预期映射，且整个过程不产生额外 LLM 调用（可用 Trace 里的 LLM 调用计数验证）。
- **Exit**：映射表覆盖所有已知风险组合，且验证过程 LLM 调用次数未增加。

### T2.4 八栏 Requirement Contract
- **优先级**：P1
- **需求**：用户/数据来源/权限定位/交付形态/分步验收/约束与未知 + 可持续性/非功能需求 + 商业化路径假设。
- **数据来源**：用户原始需求。
- **实现**：结构化表单/Prompt 模板,强制 Master 显式回答八栏,不允许留空跳过。
- **失败恢复**：字段留空 → 该需求不得进入 Plan Quality Gate,退回澄清。
- **验证**：给一个模糊需求,验证系统主动追问缺失栏位而非直接开工。
- **Exit**：八栏覆盖率 100%（SLOW 路径任务）。

### T2.5 Architecture & Commercial Assessment
- **优先级**：P1，仅 SLOW 路径触发
- **需求**：结构化输出 `scalability/security/cost/extensibility/testability/business_viability/confidence/open_risks`。
- **数据来源**：T2.4 八栏契约 + Reference Architecture Playbook。
- **实现**：Prompt 模板强制 JSON 输出 + 必须先检索匹配 Playbook 并引用其中条款,不允许每次从零推理。
- **失败恢复**：无匹配 Playbook → `open_risks` 必须显式列出"无参考架构"，不得静默假设。
- **验证**：对同一类项目连续跑 3 次,输出结构稳定且确有引用 Playbook 条款。
- **Exit**：Assessment 可读性人工抽查通过。

### T2.6 Plan Quality Gate（人工冻结签字）
- **优先级**：P1，仅 SLOW 路径触发
- **需求**：技术可行性/扩展性/商业化合理性/测试性 checklist 全过,且**必须人工签字确认**才允许生成 Task Graph——Gate 通过不等于自动开工。
- **数据来源**：T2.5 输出。
- **权限**：人工审批操作权限。
- **实现**：Checklist 优先用规则/静态检查,仅语义缺口才用 LLM Judge；最终呈现给用户人工确认。
- **失败恢复**：Checklist 未过 → 退回 T2.5 重新评估,不允许绕过。
- **验证**：故意构造一个明显忽略并发/安全的方案,验证 Checklist 能拦下并要求补充。
- **Exit**：连续 5 个中高风险项目全部经过人工签字才进入执行阶段。

### T2.7 Role Profile Schema（v2.0 新增）
- **优先级**：P1
- **需求**：定义 Role Profile 结构（`mission/suitable_tasks/ownership_scope/credential_scope/preferred_tools/prohibited_actions/context_policy/output_contract/handoff/verifier_profile`），Role 存于 Persistent State,与 Worker Instance 解耦。
- **数据来源**：架构文档第 12 节。
- **权限**：Role Profile 的创建/编辑权限（人工维护）。
- **实现**：Schema 定义 + Validator；先建 2-3 个初始角色（如 backend-engineer/qa/researcher）。
- **失败恢复**：Role Profile 与实际 Worker 能力不匹配导致任务失败率高 → 记为 Regression,人工调整 Profile,不自动修改。
- **验证**：同一 Role Profile 分别注入到两种不同 Worker,验证行为边界（`prohibited_actions`）保持一致。
- **Exit**：至少 2 个 Role Profile 可稳定复用于不同 Worker 而不改变边界。

### T2.7-A Project Registry（v3.4 新增）
- **优先级**：P1
- **需求**：新增项目登记组件，存储 `project_id → {repo_path, baseline_commit, architecture_doc_ref, task_ledger_ref}`，是"同一套 PPH 服务 N 个项目"成立的前提。
- **数据来源**：架构文档第 40 节。
- **权限**：Persistent State 读写权限。
- **实现方案**：
  1. Registry 只存储项目身份与坐标，不存储项目业务逻辑（见 T14.3 边界清单）。
  2. 提供注册接口：给定 repo 路径、当前 Git SHA、架构文档路径，生成 `project_id` 并落盘。
  3. Task Compiler（T2.0-B）通过后，按 `project_id` 查询 Registry 获取该项目坐标，再进入本节之后的编排流程。
- **失败恢复**：注册信息与实际仓库状态不一致（如 `baseline_commit` 已不存在）→ 拒绝后续编排，要求重新注册或更新基线。
- **验证方法**：注册两个不同的真实项目（如 ai-proxy 和 Personal PI 自身），验证两者的 Task Ledger/证据/Verification 互不干扰。
- **Exit**：至少 2 个真实项目可同时注册且互不污染。

### T2.7-B Task Ledger（v3.4 新增，落地 P0-05 在多项目场景的延伸）
- **优先级**：P1
- **需求**：维护 `project_task_id ↔ pph_task_id` 双向映射（字段见架构第 41 节：`task_revision/phase/owner/scope/status/verification_recipe/evidence_refs/gate_status/unknowns`），外部项目自己的任务清单只是 Ledger 的展示投影，不能自行维护独立的"完成"判断。
- **数据来源**：架构文档第 41 节；外部项目已有的任务编号（如 ai-proxy 的 T1.01-T4.08）。
- **权限**：Task Ledger 写权限（仅限 Controller）。
- **实现方案**：
  1. 导入外部任务清单时，为每条 `project_task_id` 创建对应的 `pph_task_id`（正式 Task Contract），建立双向索引。
  2. `status`/`gate_status` 只能由 T1.2 状态机 + T4.3 Acceptance Gate 驱动变更，任何外部 Markdown/文档形式的任务清单不得自行标记完成。
  3. `unknowns` 字段强制存在，导入时若有未澄清的假设必须显式列出，不允许留空。
- **失败恢复**：外部任务清单和 Ledger 状态出现分歧（如 Markdown 里写了"已完成"但 Ledger 里是 `BLOCKED`）→ 以 Ledger 为准，视为文档滞后，需要更新文档而非改 Ledger 迁就文档。
- **验证方法**：导入 ai-proxy 的 44 项任务清单，验证每条都能生成对应 Task Contract 且双向可查；构造一条"Agent 声称完成但 Verification 未 PASS"的场景，验证 Ledger 中该任务状态不会变成 DONE。
- **Exit**：44 项任务全部完成映射，且状态判定 100% 依赖 Ledger 而非自然语言描述。

### T2.7-C 稳定 CLI 入口（v3.4 新增，含只读操作纪律）
- **优先级**：P1
- **需求**：提供稳定的通用任务 CLI：`pph project register` / `pph task create` / `pph task run` / `pph task inspect` / `pph task verify` / `pph gate status`；其中 `inspect`/`status` 类命令必须严格只读，不产生任何 Persistent State 写入副作用。
- **数据来源**：架构文档第 43 节只读操作纪律（P0-12 推论）。
- **权限**：各命令按其语义申请对应权限，`inspect`/`status` 只申请只读权限（物理上不挂载写权限，而不只是约定）。
- **实现方案**：
  1. 每个 CLI 子命令映射到一个明确的 Pipeline 操作，不允许一个命令内部混杂读和写。
  2. 若某次"检查"过程中发现状态不一致需要修复，禁止在 `inspect` 内部静默纠正，必须要求用户显式调用独立的 `pph task repair` 命令。
  3. CI/测试层面对 `inspect`/`status` 命令做静态检查：调用链路中不得出现任何 Persistent State 写操作。
- **失败恢复**：发现某个"只读"命令历史上产生过写副作用（如审计中报告的"恢复脚本查看时顺手写状态"）→ 视为严重缺陷，立即修复并审计该命令过往的所有调用是否污染过状态。
- **验证方法**：**关键测试**——连续多次调用 `pph task inspect`，验证 Persistent State 的任何字段（包括时间戳类元数据）都不发生变化；确认写副作用只能来自显式命名的写命令。
- **Exit**：全部 6 个命令上线，只读命令的零副作用测试通过。

---

## Phase 3 — P0：Worker Runtime

### T3.1 Worker Adapter（统一接口）
- **需求**：`execute(TaskContract)→ResultContract` 统一接口。
- **实现**：抽象接口定义 + 第一个实现（PI Worker）。
- **失败恢复**：接口变更走版本化,不破坏已有实现。
- **验证**：Mock Worker 契约测试。
- **Exit**：接口文档+契约测试通过。

### T3.2 PI Worker（第一个实现,含 Role Profile 注入）
- **需求**：仅接入 PI 一种 Worker；若 Task 声明 `role_profile_ref`,启动时按该 Profile 的 `context_policy/prohibited_actions/credential_scope` 配置执行边界。
- **权限**：按 Task Contract 声明的最小权限精确授权。
- **实现**：受限子进程/子会话,仅注入 Contract 规定范围。
- **失败恢复**：越权操作 → 立即 DENIED 终止,记录详情。
- **验证**：5 个真实小任务端到端跑通；越权测试必须被拒绝；Role 边界测试（如 `prohibited_actions` 包含 production_deploy 时,Worker 尝试部署应被拒绝）。
- **Exit**：端到端+越权+角色边界测试全过。

### T3.2-A Phased Permission Escalation（v3.1 新增）
- **优先级**：P1
- **需求**：Run 内部按执行阶段分级授权（`Explore→只读`/`Plan→只读`/`Act→开放 Task Contract 声明的写权限`），写操作必须等到进入 Act 阶段才被允许，即使 Task Contract 本身已声明写权限。
- **数据来源**：架构文档第 28 节。
- **权限**：无新增权限维度,是对现有权限的时间维度分级。
- **实现方案**：
  1. Worker Runtime 维护 Run 内部的"当前阶段"状态（`exploring/planning/acting`），默认从 `exploring` 开始。
  2. 写操作请求（文件写入/危险命令）经过一道检查：当前阶段是否为 `acting`，不是则拒绝并提示"请先完成 Explore/Plan"。
  3. 阶段推进可以由 Worker 显式声明（"我已完成探索，进入执行阶段"）或由 Assessment 结合任务复杂度预设跳过某些阶段（简单任务可直接从 acting 开始）。
- **失败恢复**：Worker 在 exploring/planning 阶段尝试写入 → 拒绝但不终止 Run，只是要求先声明进入 Act 阶段，允许重试。
- **验证方法**：构造一个任务，验证 Worker 在未声明进入 Act 阶段前的写操作被拒绝；声明进入 Act 阶段后同样的写操作被允许。
- **Exit**：阶段拦截测试通过，且不影响简单任务可以快速跳到 Act 阶段执行的效率。

### T3.2-B Worker 能力降级状态与三层模型身份（v3.4 新增，正式化既有实践）
- **优先级**：P1
- **需求**：任何 Worker 派发前必须显式声明 `worker_capability/execution_mode/delivery_status`；每次 Run 必须记录三层模型身份 `requested_model/platform_accepted_model/observed_runtime_model`，无法确认真实运行时身份时 `observed_runtime_model` 必须字面值为 `unknown`，不允许用配置值或 `requested_model` 填充冒充。
- **数据来源**：架构文档第 45 节；GAP-01（Codex Runtime Identity Attestation）此前的一次性探测实践。
- **权限**：无新增权限。
- **实现方案**：
  1. Worker Adapter 派发前先检查 Worker 是否可用；不可用时不得静默降级为"同一工作区批量调用工具"，必须显式写入 `worker_capability=unavailable, execution_mode=root_only, delivery_status=degraded`。
  2. Run 结束时 Result Contract 必须携带三层模型身份字段；`observed_runtime_model` 的填充只能来自该次 Run 的真实回显（如 Provider API 返回的 model 字段），探测不到就写 `unknown`，不允许留空也不允许推断填充。
- **失败恢复**：发现有代码路径尝试用 `requested_model` 静默填充 `observed_runtime_model` → 视为伪造证据，立即修复，审计历史数据是否有类似污染。
- **验证方法**：模拟 Worker 不可用场景，验证系统正确记录降级状态而非伪造多 Worker 协作；模拟一次无法获取运行时回显的 Provider 调用，验证 `observed_runtime_model=unknown` 被正确保留而非被填充。
- **Exit**：降级状态记录测试通过；`unknown` 保留测试通过，无伪造身份案例。

### T3.3 Result Contract（支持 BatchResult、INSUFFICIENT_CONTEXT 与 Work Receipt）
- **需求**：`status/summary/changed_files/artifacts/evidence/errors`；新增允许值 `INSUFFICIENT_CONTEXT`（附 `requested_context: []`）；支持 `BatchResult` 信封（见 T13.0-A）；新增 `work_receipt` 字段（见 T3.5）。
- **实现**：Result Schema + Worker 侧强制封装。
- **失败恢复**：Worker 崩溃未返回 → Controller 超时生成合成 Result（status=timeout）,进入回收流程；收到 `INSUFFICIENT_CONTEXT` → 不算失败也不算完成,走"补充上下文→同一 Run 重新派发"分支。
- **验证**：success/failure/timeout/insufficient_context 四种场景均产生合法 Result。
- **Exit**：四场景测试全绿。

### T3.4 Idempotency Key + Effect Journal
- **优先级**：P0（若 v0.1 已会触发外部副作用,如部署/发消息/建资源/收费调用）
- **需求**：Worker 涉及外部副作用的动作必须携带 `idempotency_key`,并记录 Effect Journal（含 `compensation_action` 补偿动作）。
- **数据来源**：Task Contract execution.idempotency_key。
- **实现**：Effect Journal 表记录 `idempotency_key/action_digest/target/status/reversible/compensation_action`；重试前先查 Journal,已 committed 的动作不重复执行。
- **失败恢复**：下游系统不支持原生幂等键 → 走 `compensation_action` 补偿（Saga 模式）,而非依赖重试天然安全。
- **验证**：模拟一次"发送邮件"动作在网络抖动后触发重试,验证邮件不会被重复发送。
- **Exit**：幂等测试通过,无重复副作用案例。

### T3.5 Work Receipt / No-op Receipt（v3.0 新增）
- **优先级**：P1-Early
- **需求**：Result 增加 `work_receipt`（`work_attempted/effects_count/artifacts_created/state_changed/no_op/no_op_reason/evidence_refs`），区分"Pipeline Green"与"真实工作发生"；对 Trigger Gateway（T7.3）创建的任务强制要求，普通任务默认开启。
- **数据来源**：架构文档第 23 节。
- **权限**：无。
- **实现方案**：
  1. Worker Adapter 在封装 Result 时自动填充 `effects_count`/`artifacts_created`/`state_changed`（可从 Evidence 采集器数据直接推导，不需要额外 LLM 判断）。
  2. `no_op: true` 时必须附带 `no_op_reason`，否则 Schema 校验不通过。
  3. Acceptance Gate（T4.3）增加一条检查：`status=PASS` 且 `artifacts_created` 为空且 `state_changed=false` 且无 `no_op_reason` → 标记 `work_receipt_anomaly`，不允许直接放行为正常 DONE。
- **失败恢复**：检测到 `work_receipt_anomaly` → 该 Task 退回人工核查，不自动判定为失败也不自动放行。
- **验证方法**：**关键测试**——复现文章里的场景：构造一个"调度成功触发、Worker 进程正常退出、但实际什么都没做"的案例，验证系统能识别为 `work_receipt_anomaly` 而不是直接标记 DONE；同时验证合法的 `no_op`（如"没有新消息"）能正常通过。
- **Exit**：异常检测与合法 no_op 两类测试均通过。
- **v3.3 补充规则（架构文档第 39.6 节 Fresh Context）**：**Work Receipt 是 Master 能看到的唯一 Worker 产出摘要，Master 不允许、也不需要读取 Worker 的完整 transcript**；一个 Task 完成后，下一个 Task 必须是全新上下文，只读取上一个 Task 的 Receipt 和 Evidence 引用，不携带完整对话历史。此规则新增验证：抽查 Master 在跨 Task 决策时的实际输入，确认不包含任何 Worker 完整 transcript，只有结构化 Receipt 字段。

---

## Phase 4 — P0：Verification

### T4.1 Evidence System
- **需求**：记录 `diff/commands/stdout/stderr/test_result/build_result/artifacts`。
- **实现**：Evidence 采集器挂在 Worker 生命周期钩子上。
- **失败恢复**：证据不全 → Verification 判 UNKNOWN,不放行 PASS。
- **验证**：Evidence 可离线回放。
- **Exit**：回放测试通过。

### T4.1-A 标准化证据包（v3.4 新增，落地既有 T4.1/T4.5，具体化到可对外交付）
- **优先级**：P1
- **需求**：为可对外交付的项目产出标准化证据包（`baseline_commit/actual_diff/task_revision/workspace_snapshot_ref/commands_and_exit_codes/test_output_summary/artifact_digest/browser_or_container_verification/unfinished_items/provider_mode`）。
- **数据来源**：架构文档第 42 节；T4.1 Evidence System + T14 系列 Verification Recipe 的既有数据。
- **权限**：无新增权限，是既有 Evidence 数据的标准化输出格式。
- **实现方案**：
  1. 在 T4.1 采集的基础上，增加汇总步骤，产出符合上述 Schema 的证据包文件。
  2. `provider_mode` 字段强制显式标注 `mock/local/real`，不允许省略——用 mock/local 跑通的验证结果不能被静默当成 real Provider 的等价证据。
- **失败恢复**：证据包缺少 `provider_mode` 标注 → 视为不完整证据，Acceptance Gate 拒绝基于此证据包放行。
- **验证方法**：构造一次用 mock Provider 跑通的验证，验证证据包正确标注 `provider_mode=mock`，且交付评审界面能一眼看出这不是 real Provider 验证结果。
- **Exit**：标准化证据包格式冻结，且至少一次真实交付使用该格式产出证据。

### T4.2 Verification Engine（确定性优先 + 强度分级）
- **需求**：输出 `PASS/FAIL/UNKNOWN` 三态,验证器独立于 Worker；**能用脚本/测试/静态检查判定的禁止改用 LLM 判断**；新增 `verification_confidence: strong/weak/none` 字段。
- **实现**：按 `verification.commands` 自动执行；语义类验收才用 LLM Judge/人工；缺乏自动化条件时降级 UNKNOWN。
- **失败恢复**：验证环境异常 → 判 UNKNOWN,阻塞,不静默跳过。
- **验证**：**关键测试**——构造"Worker 谎称成功但测试实际失败",系统必须输出 FAIL；`weak` 级别 PASS 不得自动解锁下游高风险任务。
- **Exit**：关键测试通过,20 个真实任务验证结果与人工复核一致率 ≥ 95%。

### T4.2-A Verifier Context Isolation（v3.0 新增，落地 P0-11）
- **优先级**：P1-Early
- **需求**：Verification Engine 的输入组装逻辑必须显式过滤掉 Worker 的私有推理/scratchpad/自然语言解释，只保留结构化 Result 字段、Artifact、Evidence、仓库/环境实际状态、Verification Recipe。
- **数据来源**：架构文档第 24 节 Verifier 输入白名单。
- **权限**：无。
- **实现方案**：在 Verification Engine 的输入组装函数里加一道显式过滤——只接受 T3.3 Result Contract 里的结构化字段和 Evidence 引用，Worker 若在非结构化字段（如自由文本 `summary`）里塞入了推理过程,不参与判定逻辑，仅供人工阅读参考。
- **失败恢复**：发现 Verification 判断明显复述了 Worker 的解释而非独立核对现实状态（例如 Worker 说"我认为测试会通过因为 X"，Verifier 直接采信而未真正跑测试）→ 视为验证独立性缺陷，修复过滤逻辑。
- **验证方法**：构造一个 Worker 给出错误但看似合理的推理解释、但实际测试会失败的场景，验证 Verifier 依然输出 FAIL（不受 Worker 解释误导）。
- **Exit**：隔离测试通过，Verifier 判断结果与"仅给结构化证据、完全不给 Worker 解释"时的结果一致。

### T4.2-B Deterministic Lifecycle Hooks（v3.1 新增）
- **优先级**：P1
- **需求**：在 Worker 执行过程的关键节点（`on_start/pre_tool_use/post_tool_use/on_cwd_change`）挂确定性检查钩子，把部分验证工作提前到执行过程中，而不是全部等到 Run 结束才走完整 Verification。
- **数据来源**：架构文档第 30 节。
- **权限**：Hook 内的检查动作按需申请（如运行 lint 需要读代码权限）。
- **实现方案**：
  1. Worker Runtime 暴露 Hook 注册点：`on_start`（如加载环境变量）、`pre_tool_use`（如挂 T10.4 Command Risk Classification）、`post_tool_use`（如代码文件改动后自动跑一次 lint/静态检查）、`on_cwd_change`（如切换目录后重新加载该目录的 Scoped Context 规则，见 T6.2-A）。
  2. Hook 内的检查必须是确定性脚本/静态检查，不允许触发新的 LLM 判断。
  3. Hook 失败时阻断当前工具调用，把错误立即回传给 Worker（Worker 可据此调整后续动作），而不是让错误带到最后才被 Verification 发现。
- **失败恢复**：Hook 本身执行异常（如 lint 工具缺失）→ 该 Hook 降级为跳过并记录告警，不阻塞整个 Run，但需在 Evidence 里注明"该检查未执行"。
- **验证方法**：构造一个"文件改动后代码有明显 lint 错误"的场景，验证 `post_tool_use` Hook 能在 Run 结束前就发现问题，而不是等到最终 Verification。
- **Exit**：至少 `pre_tool_use`（挂 Command Risk Classification）和 `post_tool_use`（挂基础 lint）两个 Hook 点可用并验证通过。

### T4.2-C Tool Gateway 结构化结果信封（v3.3 新增，落地 P0-18）
- **优先级**：P0
- **需求**：工具执行结果不得原样透传 stdout/stderr,必须封装成结构化信封（`exit_code/status/duration/stdout_summary/stderr_summary/error_fingerprint/relevant_stack_frames/artifact_id/truncated/next_cursor`）,原始完整输出写入 Artifact Store,不内联进返回结果。
- **数据来源**：架构文档第 39.2 节。
- **权限**：Artifact Store 写权限。
- **实现方案**：
  1. 按输出类型实现默认摘要策略：编译失败取根异常+源码位置+最后 20-50 行；测试失败取失败用例+断言差异；堆栈折叠重复依赖库帧只留用户代码帧；全局搜索返回匹配总数+分组目录+分页句柄；大文件默认只允许符号/行号区间读取；重复失败只返回"与错误指纹 X 相同,新增差异为……"。
  2. 原始输出全量写入 Artifact Store（内容哈希/大小/时间/敏感信息标识），模型需要更多细节时通过 `artifact_id` + `next_cursor` 按需拉取。
  3. 与 T10.4 Command Risk Classification 是不同维度的两道关卡：T10.4 管"命令能不能执行"，本任务管"执行完的输出能不能原样进入上下文"，顺序上 T10.4 在前、本任务在后。
- **失败恢复**：摘要策略未覆盖某类新的输出格式 → 该输出默认走保守截断（如只保留最后 N 行 + artifact 引用），不允许在策略缺失时退回"整段透传"。
- **验证方法**：**关键测试**——复现"几百行异常堆栈"场景，验证返回给模型的是结构化摘要+`error_fingerprint`+`artifact_id`，原始堆栈不出现在返回结果里；验证同一错误第二次出现时不重复注入全文。
- **Exit**：结构化信封覆盖至少编译失败/测试失败/堆栈/全局搜索/大文件读取五类场景，关键测试通过。

### T4.3 Acceptance Gate
- **需求**：只有 `Verification=PASS` 才允许 `→DONE`；父节点不可手工标记完成。
- **实现**：挂在 T1.2 状态机 `→DONE` 迁移上的强制前置校验。
- **失败恢复**：发现绕过路径 → 视为严重缺陷,立即修复并审计历史虚假完成记录。
- **验证**：尝试在非 PASS 时调用完成接口,必须拒绝。
- **Exit**：拦截测试 100% 通过。

### T4.3-A Acceptance 与 Git 副作用分离（v3.4 新增，Acceptance Gate 扩展规则）
- **优先级**：P1
- **需求**：`Acceptance PASS ≠ 允许 Commit ≠ 允许 Push ≠ 允许 Publish`，四者解耦；Commit 操作只提交明确列出的文件，**禁止使用 `git add .` 或 `git add -A`**。
- **数据来源**：架构文档第 44 节。
- **权限**：Commit/Push/Publish 各自独立的用户授权（走 Human Approval Gate，`action_digest+revision+expires_at`）。
- **实现方案**：
  1. Acceptance Gate（T4.3）只负责判定"这次改动是否验证正确"，不触发任何 Git 操作。
  2. Commit 作为独立的、需要用户授权的副作用动作，执行时只 `git add` Task Contract `scope.files` 范围内的文件，不使用全量添加命令。
  3. `git add -A`/`git add .` 归入 T10.4 Command Risk Classification 的 `risky` 档，触发人工确认而非自动放行。
  4. Commit 记录必须关联对应的 T4.1-A 标准化证据包，保留可追溯性。
- **失败恢复**：发现 Commit 操作意外提交了 `scope.files` 之外的文件 → 视为越权提交事件，评估是否需要回滚该次 Commit。
- **验证方法**：构造一个 Task 范围外还有其他未提交改动的工作区，验证 Commit 操作只提交范围内文件，范围外改动不受影响；验证 `git add -A` 类命令触发人工确认而非自动执行。
- **Exit**：范围限定测试与风险命令拦截测试均通过。

### T4.4 Verification 绑定 Revision（TOCTOU 防护）
- **优先级**：P0
- **需求**：PASS 必须绑定 `commit_hash/diff_digest/artifact_digest/task_revision`；工作区在验证后发生变化,旧 PASS 自动失效；并行分支合并后必须对最终态重跑 Integration Verification,不能复用分支级 PASS。
- **数据来源**：Verification 执行时的工作区快照。
- **实现**：Verification 记录写入时同步记录当前 digest；Acceptance Gate 检查时重新计算当前 digest 与记录是否一致,不一致则判定 PASS 已失效需重验。
- **失败恢复**：digest 不一致 → 任务退回 `VERIFYING`,重新执行验证,不允许沿用旧结论。
- **验证**：验证 PASS 后人为修改工作区文件,验证 Acceptance Gate 能检测到并拒绝基于旧 PASS 直接放行。
- **Exit**：TOCTOU 场景测试通过。

### T4.5 Verification Recipe（v2.0 新增）
- **优先级**：P1
- **需求**：按任务类别（web_feature/api_endpoint/cli 等）预定义验收清单+证据类型,纳入 Reference Architecture Playbook。
- **数据来源**：架构文档第 14 节。
- **实现**：`playbooks/<type>/verification.yaml`；Task Contract `verification.recipe_ref` 引用；Verification Engine 优先按 Recipe 清单执行。
- **失败恢复**：Recipe 缺失对应类型 → 降级为通用 Verification 流程,同时记录"缺少 Recipe"待补充。
- **验证**：为 web_feature 类任务应用 Recipe,验证自动要求 browser_e2e+network_trace 证据,而非仅单测。
- **Exit**：至少 2 类 Recipe（web_feature/api_endpoint）可用且被正确引用。

---

## Phase 5 — P0：Persistent Execution

### T5.1 Persistent Task Store
- **需求**：持久化 `Project/Task/Edge/Dispatch/Run/Result/Evidence/Verification/Decision/RoleProfile`。
- **实现**：ORM + 事务保证一致性。
- **失败恢复**：写入失败依赖事务回滚,禁止"状态已变但证据未落盘"的中间态。
- **验证**：并发写入压力测试。
- **Exit**：核心对象可查询、可重建完整历史。

### T5.2 Run / Attempt 持久化
- **需求**：一个 Task 可有多个 Run,Task ID 不因重试改变。
- **实现**：Run 表与 Task 一对多,Retry 创建新 Run。
- **失败恢复**：Run 记录丢失 → 视为该次执行未发生,状态回退重新生成 Run。
- **验证**：Run1 失败、Retry 生成 Run2 且 Task ID 不变。
- **Exit**：Run 历史链条完整可追溯。

### T5.3 Crash Recovery
- **需求**：Master 崩溃重启后能读回当前 Task/Run/Worker 状态,不依赖聊天记录。
- **实现**：Controller 启动执行"读状态→找未关闭派出件→对账"。
- **失败恢复**：状态不一致（Run 处于 RUNNING 但 Worker 不存在）→ 判定失联,走回收流程。
- **验证**：**关键测试**——强制 kill Master 进程,重启后能准确说出当前任务与下一步。
- **Exit**：崩溃恢复测试通过,无数据丢失或双重执行。

### T5.4 Persistent State Snapshot + Restore Drill
- **优先级**：P0
- **需求**：Stage Gate 通过后自动快照；快照必须定期演练恢复,证明"能恢复"而非只是"有备份"。
- **数据来源**：T5.1 持久化数据。
- **权限**：备份存储读写权限。
- **实现**：每次 Stage Gate PASS 触发一次快照任务（本身也是一个 P0 级 Task,用系统管理自己）；每月/每个大阶段结束执行一次 Restore Drill。
- **失败恢复**：Restore Drill 失败 → 视为严重缺陷,立即修复快照格式/流程,不允许"下次一定行"。
- **验证**：真实执行一次 Restore Drill,验证从快照恢复后系统状态与恢复前一致。
- **Exit**：至少一次 Restore Drill 成功记录在案。

### T5.5 Control-Plane Reconstruction（P0-12 落地）
- **优先级**：P0
- **需求**：证明 Master/Controller 是"逻辑唯一、物理可替换"——换一个全新进程/环境,只要能读到 Persistent State,就能完整重建控制状态。
- **数据来源**：T5.1 全量持久化数据。
- **实现**：在一个全新环境（新机器/新容器）中,仅凭数据库连接启动 Controller,验证能否正确恢复调度。
- **失败恢复**：重建失败 → 定位缺失的持久化字段,补齐后重测。
- **验证**：**关键测试**——在与原 Master 完全隔离的新环境中重建 Controller,验证能继续调度未完成任务。
- **Exit**：跨环境重建测试通过。

---

## Phase 6 — P0：Context Projection

### T6.1 Context Store（统一事实缓存）
- **需求**：内容寻址存储（`sha256(内容)→路径`）。
- **失败恢复**：缓存与源文件不一致 → 以当前 hash 为准,判 MISS 重新计算。
- **验证**：文件修改后 hash 随之改变,旧缓存不被误用。
- **Exit**：读写正确性测试通过。

### T6.2 Context Manifest
- **需求**：`required/optional/excluded` 三类引用,不携带原文。
- **失败恢复**：引用不存在的资源 → Resolver 报错,任务判 `NOT_READY`。
- **验证**：无效引用场景正确报错。
- **Exit**：Manifest 校验测试通过。

### T6.2-A Scoped Context Assembly（v3.1 新增）
- **优先级**：P1
- **需求**：Context Manifest 的规则解析采用 `org > project > directory` 层级作用域，更具体层级的规则覆盖更宽泛层级的同名规则。
- **数据来源**：架构文档第 31 节。
- **权限**：无。
- **实现方案**：规则存储按层级组织（如 `rules/org.yaml`、`rules/project.yaml`、`rules/dir/<path>.yaml`），Context Resolver（T6.3）解析时从粗到细依次加载并按 key 覆盖，`excluded` 同理可在细层级排除粗层级默认包含的内容。**v3.3 补充**：搜索/读取类工具的默认作用域应等于 Task Contract 的 `scope.files`（Allowlist），而不是整个工作区排除几个目录（Denylist）；搜索结果必须有数量上限、总字节上限和分页句柄,结果过多时自动要求缩小范围而非直接倾倒全部结果（架构文档第 39.3 节）。
- **失败恢复**：多层规则冲突且无法通过"更具体覆盖更宽泛"解决（如两条同级规则直接矛盾）→ 判为规则配置错误，阻塞并要求人工修正，不猜测优先级。
- **验证方法**：构造 org 级"必须写单测"规则与 `src/legacy/` 目录级"该目录不做重构、允许跳过单测"规则，验证在 `src/legacy/` 下解析结果正确应用目录级例外；**新增验证**：构造一个会匹配上千个文件的全局搜索，验证工具默认只在 Task `scope.files` 范围内搜索，且返回结果被截断并附分页句柄，而不是全部倾倒。
- **Exit**：层级覆盖测试通过，Allowlist 范围控制测试通过。

### T6.3 Context Resolver（含 Budget 控制）
- **需求**：`Task→Resolve References→Build Context→Budget Check→Worker`；超预算触发压缩/裁剪。
- **失败恢复**：超限且无法压缩 → 标记 `BLOCKED`,原因"上下文超预算"。
- **验证**：100K 上下文项目,验证最终输入保持预算内。
- **Exit**：预算控制测试通过,无 OOM/截断异常。

### T6.3-A 分层上下文预算与水位线（v3.3 新增，落地 P0-18，直接修复 context-limit 事故）
- **优先级**：P0
- **需求**：把 T6.3 的"超限→`BLOCKED`"二元判断升级为四层预算 + 四级水位线的主动响应，在真正撞到 Provider 硬限制之前就完成结构化收敛。
- **数据来源**：架构文档第 39.4 节；触发本任务的真实事故——一次长流程因 Provider `context-limit` 报错直接中止，而非受控的 `BLOCKED`/`DONE`。
- **权限**：Persistent State 读写权限（水位线状态需要持久化）。
- **实现方案**：
  1. 四层预算：单次工具输出、单轮 Prompt、单个 Run、Task 生命周期累计（即 `loop_budget`）；每层统计 token/tool call 次数/原始日志字节数/注入上下文字节数/重复内容比例/状态增长量/elapsed time/重试次数。
  2. 四级水位线：低水位正常执行；警戒水位触发 T4.2-C 的工具输出压缩、禁止新增无关上下文；**重建水位不在原 Run 里"总结一下"继续跑，而是立即调用 T6.5 生成结构化状态、结束当前 Run、创建 Fresh Context（见 T3.5 扩展）继续**；硬上限阻断调用并标记 `BLOCKED`（复用 T1.1-B Loop Budget 的既有语义作为最后防线）。
  3. 重建水位的阈值建议设在 Worker 实际 `context_limit`（见 Worker Plugin Manifest）的 70-80%，而不是等到 Provider 硬拒绝。
- **失败恢复**：水位线判断本身失效（如统计口径错误导致误判）→ 保守处理，宁可提前触发"重建"也不允许延迟到硬上限才响应。
- **验证方法**：**关键测试**——复现本次事故场景：构造一个会持续累积上下文的长流程，验证系统在到达重建水位时主动收敛（生成结构化状态+开新 Run），全程不再出现 Provider `context-limit` 报错导致的失控中止。
- **Exit**：四级水位线响应测试通过，关键测试（长流程不再硬撞 Provider 限制）通过。

### T6.4 Context Cache（命中率）+ Retry 复用
- **需求**：相同引用复用缓存对象；**Retry 默认复用上一次 Run 的 Context Manifest 解析结果**,除非 Contract 判定需要变更。
- **失败恢复**：缓存命中但 hash 校验不一致 → 判异常 MISS,强制重载并告警。
- **验证**：三个 Task 请求相同文件验证 HIT；Retry 场景验证未重复计算 Context。
- **Exit**：缓存命中率与 Retry 复用测试通过。

### T6.5 Context Compaction Policy（v3.3 升级：结构化 Schema 取代自由文本摘要）
- **优先级**：P1
- **需求**：跨任务汇总/进度汇报时,历史 Task 完整 Evidence 不整体带入,只带"结论级摘要+引用"；**压缩产出物必须采用结构化 Schema（`facts/decisions/completed_tasks/open_tasks/open_risks/verified_evidence/failed_attempts/next_action/git_sha/artifact_refs`），不是自由文本总结**。
- **数据来源**：架构文档第 39.5 节。
- **实现**：Master 汇报逻辑强制走结构化摘要生成器,原文保留在 Context Store 引用；`failed_attempts` 只含 `error_fingerprint`，不含完整堆栈。
- **失败恢复**：发现汇报内容整段复制原始 Evidence，或摘要产出是自由文本而非结构化字段 → 视为 token 治理回归,修复摘要逻辑。
- **验证**：抽查一次跨 10 个历史任务的项目汇报,确认无原文整体粘贴，且产出符合结构化 Schema；**关键测试**——验证压缩不会把"旧计划"和"新状态"混在一起、不会把不确定结论写成确定事实（构造一个包含已推翻决策的历史，验证压缩结果正确反映最新状态而非保留旧决策）。
- **Exit**：汇报 token 消耗相较不压缩版本显著下降（可用具体数值追踪），且结构化 Schema 测试通过。

---

## Phase 7 — P0：第一个完整闭环

### T7.1 End-to-End 集成测试
- **需求**：真实项目上走完 `Requirement→Preclassify→(Plan Gate)→Task→Assessment→Policy→Worker→Run→Result→Evidence→Verification→DONE`。
- **实现**：串联 Phase 1-6 所有组件。
- **失败恢复**：任一环节失败 → 回退到对应 Phase 单独修复后重跑整体。
- **验证**：至少 3 次不同真实小需求全部端到端 PASS。
- **Exit**：**Personal PI v0.1 Core（含 v1.1 全部可靠性不变量）达成**，打上 `PERSONAL_PI_V0.1_CORE_V1.1` 标签。

### T7.2 Self-Development Test（自举）
- **需求**：让系统修改自身一个小功能。
- **权限**：Personal PI 自身仓库读写权限（与业务项目权限隔离）。
- **失败恢复**：损坏自身 → 依赖 Git 回滚,禁止无快照自举。
- **验证**：自举修改通过 Verification 且系统继续正常运行。
- **Exit**：自举测试 PASS。

### T7.3 Trigger Gateway（v2.0 新增，验证 Always-on 场景）
- **优先级**：P2
- **需求**：`Trigger→Create Task Contract→DoR→Controller→Worker`,Trigger 不直接调用 Worker；先支持 cron 定时和一种 webhook 来源；**Trigger 创建的 Task 强制要求 T3.5 Work Receipt（`work_receipt` 必填），防止出现"定时任务按时触发、流程全绿、但实际什么都没做"的假象**。
- **数据来源**：外部事件源（如本地 cron、一个简单 webhook 接收端）。
- **权限**：Trigger 只有"创建 Task"权限,无执行权限。
- **实现**：Trigger Gateway 服务,匹配 `trigger.condition` 后调用 Task 创建接口,后续完全走既有 Pipeline。
- **失败恢复**：Trigger 触发但 Task 创建失败 → 记录告警,不重试造成重复触发（需配合 idempotency_key）。
- **验证**：设置一个定时任务（如"每天早上生成一份小结"）,验证到点自动创建 Task 并走完整 DoR→Verification 流程,而不是绕过；验证若某天没有新内容需要小结,系统产出 `no_op: true` 而不是伪造一份空洞的"小结"。
- **Exit**：至少一个真实 Trigger 场景端到端跑通,且能正确区分"有实际工作"与"合法空转"两种结果。

### T7.4 Demonstration-based Routine Capture（v2.0 新增）
- **优先级**：P2
- **需求**：一次成功 Run 经人工确认后,提炼为参数化 Task Template 存入 Reference Architecture Playbook。
- **数据来源**：T7.1/T7.2 中产生的真实成功 Run。
- **权限**：Playbook 写入权限（人工审核后落库）。
- **实现**：Run 完成后提供"提炼为模板"操作,人工确认关键参数（哪些字段该固定、哪些该参数化）后写入 Playbook。
- **失败恢复**：提炼的模板在下次复用时表现不佳 → 记入 Plan Regression Dataset,修正或废弃该模板,不允许无监督自动迭代模板。
- **验证**：用提炼出的模板处理一个同类新需求,验证 Master 能直接复用而非从零推理分解方式。
- **Exit**：至少 1 个模板成功复用于第二个真实场景。

### T7.5 Background Memory Consolidation（v3.1 新增，"Dream Consolidation"）
- **优先级**：P2
- **需求**：闲时后台任务定期把累积的历史 Evidence/Decision Record 蒸馏成紧凑的长期摘要，原始证据移到冷存储而非删除；与 T6.5 Context Compaction Policy（按需现场压缩）互补，不重复。
- **数据来源**：Persistent State 中积累的 Evidence/Decision Record（如过去 7 天）。
- **权限**：Persistent State 读写权限；冷存储读写权限。
- **实现方案**：
  1. 复用 T7.3 Trigger Gateway，配置一个定时任务（如每天凌晨）触发 Consolidation Task。
  2. Consolidation Task 本身走标准 Task Contract + Work Receipt（T3.5）流程：`summarize_completed_tasks` → `compact_decision_records` → `archive_raw_evidence_to_cold_storage`。
  3. 若过去周期内无新增可整理内容，产出合法 `no_op` 结果。
- **失败恢复**：Consolidation 过程中断 → 原始 Evidence 不受影响（先摘要后归档，归档失败不影响已有数据），下次调度重试。
- **验证方法**：模拟 7 天的历史任务数据，运行一次 Consolidation，验证摘要质量可用且原始证据仍可在冷存储中找到、可追溯。
- **Exit**：至少完成一次真实的 Consolidation 周期，且摘要后系统的日常 Context 组装成本（token）有可观测下降。

---

## Phase 8 — P1：Graph Intelligence

### T8.1 Dynamic Decomposition
- **需求**：复杂任务自动拆解为符合 Contract 的子任务。
- **失败恢复**：子任务不满足契约 → 拒绝写入,要求重新分解。
- **验证**：已知应拆 3 个子任务的需求,验证分解结果合理。
- **Exit**：子任务 100% 通过 Contract 校验。

### T8.2 Dependency Resolver
- **需求**：自动计算 READY/BLOCKED。
- **验证**：`A,B DONE, C depends A+B` → C 自动 READY。
- **Exit**：依赖计算正确性测试通过。

### T8.3 Artifact Dependency（基础版）
- **需求**：`A produces artifact→B consumes`,详见 T1.3-B 的完整 Handoff Contract 版本。
- **Exit**：产物依赖链路测试通过。

### T8.4 Decomposition Budget + Coordination Budget
- **优先级**：P1
- **需求**：`max_depth/max_children_per_task/max_total_open_tasks/max_replan_count` + `coordination_budget: max_active_workers/max_handoffs_per_task/max_concurrent_roles`,防止任务图与"组织"同时膨胀。
- **数据来源**：Decomposition 与 Dispatch 的历史统计。
- **实现**：Decomposer/Dispatcher 读取预算配置,超限则拒绝进一步拆分/派发,转人工介入。
- **失败恢复**：预算耗尽但任务确实复杂 → 人工提高预算上限并留痕,不允许静默突破。
- **验证**：构造一个会无限递归拆解的需求,验证系统在达到 `max_depth` 后停止并报告,而不是失控增长。
- **Exit**：预算拦截测试通过。

### T8.4-A resource_ceiling（v3.4 新增，操作系统级资源上限）
- **优先级**：P2（真正生效于 Phase 12/13 并行场景，但字段定义可提前）
- **需求**：新增独立于 `loop_budget` 的 `resource_ceiling`（`max_parallel_workers/max_memory_mb_per_worker/max_total_memory_mb/on_pressure`），专门覆盖操作系统级物理资源压力（如并行验收导致 OOM、进程被 `exit 137` 强杀），`loop_budget` 不管这类失败。
- **数据来源**：架构文档第 17 节；一次真实事故——两轮 session 累积约 4.14 亿 token，并行验收触发进程 `exit 137` 退出。
- **权限**：读取宿主机资源监控数据的权限（如 `/proc` 或容器 cgroup 指标）。
- **实现方案**：
  1. 并行派发前检查当前资源占用是否逼近 `max_total_memory_mb`，逼近则按 `on_pressure: degrade_to_serial` 自动降级为串行执行，而不是继续并行直到被系统强杀。
  2. 每个 Worker 进程监控自身内存占用，超过 `max_memory_mb_per_worker` 时主动终止并触发正常的 Crash Recovery 流程（T9.1-9.4 + Fencing），而不是等操作系统杀掉。
- **失败恢复**：资源监控数据不可得（如某些容器环境无法读取）→ 保守假设资源紧张，默认走串行，不假设资源充足。
- **验证方法**：**关键测试**——复现事故场景：构造多个高内存占用的并行验收任务，验证系统在触发 OOM 前主动降级为串行，不再出现 `exit 137` 类强杀。
- **Exit**：资源压力测试通过，关键测试（不再复现 OOM 强杀）通过。

---

## Phase 9 — P1：Recovery

### T9.1-9.4 Timeout / Retry / Resume / Reassign
- **需求**：`RUNNING`超时→`TIMEOUT`；`retry_policy`；有效改动续做而非重来；Worker 崩溃改派。
- **权限**：工作区读写、Worker 生命周期管理权限。
- **实现**：统一走"冻结→停工人→验现场→下结论（续做/回滚/降级/改派）",配合 T1.4 Fencing Token 防止旧 Worker 迟到覆盖新结果。
- **失败恢复**：连续两次回收同一 Task 仍失败 → 升格 `BLOCKED`,不第三次自动改派。
- **验证**：**故障注入测试**——分别模拟 timeout/crash/malformed output/wrong result,验证均按预期分支恢复并留下 Decision Record。
- **Exit**：四类故障注入测试全部通过。

---

## Phase 10 — P1：安全与权限

### T10.1 Permission Contract / T10.2 Least Privilege / T10.3 敏感信息边界
- **需求**：Task 必须声明 `filesystem/shell/network/git/credentials` 范围；Worker 只拿最小权限；Context 默认不携带密钥,除非显式授权；**若任务声明 `role_profile_ref`,权限范围不得超出该角色的 `credential_scope`**；**权限规则建议用声明式 YAML 规则文件实现（Deny/Allow/Approve 三档），而不是散落在代码里的 if-else**。
- **权限**：沙箱/容器隔离能力；密钥管理系统访问策略。
- **失败恢复**：越权 → DENIED 并记录违规详情；敏感信息意外泄露 → 立即中止 Run,记安全事件。
- **验证**：越权测试 100% 拦截；含密钥上下文默认过滤,显式授权才通过；Role 权限上限测试（角色声明禁止 payment,Task 却要求支付权限 → 拒绝派发）。
- **Exit**：三类拦截测试全过。

### T10.4 Command Risk Classification（v3.1 新增）
- **优先级**：P1
- **需求**：在 Task 级白名单校验之后、命令真正执行之前，对每条 Shell 命令做实时风险分类（`safe→auto_run` / `risky→ask_user` / `danger→block`），拦住"任务权限没问题但具体命令危险"的场景。
- **数据来源**：架构文档第 27 节 Command Risk Classification 规则表。
- **权限**：无新增权限，是对 T10.1 白名单机制的补强层。
- **实现方案**：
  1. 维护一份可配置的命令风险规则表（正则/关键词匹配），覆盖常见危险命令（`rm -rf /`、`git push --force`、`git reset --hard`、fork bomb 等）。
  2. Worker Adapter 的 Shell 执行入口在真正调用前过一遍分类：`danger` 硬拒绝且不可覆盖；`risky` 触发人工确认（复用 T2.6/Human Approval Gate 的 action_digest 绑定）；`safe` 自动放行。
  3. 规则表本身可迭代扩充，新发现的危险命令模式随时加入。
- **失败恢复**：规则误判 `danger` 为 `safe` 导致实际风险 → 记为安全事件，立即补充规则，不等常规迭代周期。
- **验证方法**：构造覆盖三档的测试命令集，验证分类结果与预期一致；验证 `danger` 分类无法被 Task Contract 权限声明覆盖绕过。
- **Exit**：三档分类测试全过，且 `danger` 命令在任何权限声明下都无法执行。

### T10.5 Single-Purpose Tool Design 准则（v3.1 新增）
- **优先级**：P1
- **需求**：Worker Adapter 工具注册表优先暴露单一职责工具（`Read/Edit/Grep/Glob`），只有明确没有等价专用工具时才退回通用 `Bash`。
- **数据来源**：架构文档第 29 节。
- **权限**：无。
- **实现方案**：制定工具设计准则文档，新增工具前先检查是否可以用现有专用工具组合完成，不能才新增 Bash 类通用工具；已有的专用工具优先于 Bash 出现在工具列表前部（影响模型选择倾向）。
- **失败恢复**：发现某类任务大量依赖 Bash 完成本可由专用工具做的事 → 记为待办，评估是否值得新增对应专用工具。
- **验证方法**：抽查一段时间的 Evidence，统计 Bash 调用中有多少比例本可由现有专用工具替代。
- **Exit**：准则文档产出，且新工具评审流程默认执行该检查。

---

## Phase 11 — P1：Trace / Audit / Eval

### T11.1-11.3 Execution Trace / Decision Record / Regression Dataset
- **需求**：全链路可回放；每次决策原因留痕；真实失败转化为 Regression Case。
- **实现**：统一 Trace ID 贯穿全链路；Decision Record 结构化存储。
- **验证**：抽查任意一次执行,能否完整回放并解释每一步决策原因。
- **Exit**：Trace 完整性抽查通过率 100%。

### T11.4 Token/Cache 指标纳入 Eval
- **优先级**：P1
- **需求**：`token_per_task/cache_hit_rate/worker_tier_distribution` 作为常规追踪指标写入 Trace。
- **实现**：在既有 Trace 埋点基础上多记几个字段,几乎零成本。
- **验证**：抽查一段时间的数据,能看出成本趋势变化。
- **Exit**：指标可用于月度成本复盘,不用等账单才发现问题。

### T11.4-A Graph Efficiency Metrics（v3.0 新增）
- **优先级**：P1
- **需求**：追加 `graph_width/graph_depth/handoff_count/peak_active_workers/retry_depth/replan_count/useful_work_ratio/verification_first_pass_rate/cost_per_verified_task/time_per_verified_task` 及派生指标 `coordination_efficiency = verified_tasks / (handoffs+retries+agent_calls)`。
- **数据来源**：既有 Trace/Decision Record 数据 + T3.5 Work Receipt 统计（`useful_work_ratio` 直接来自 no_op 比例）。
- **权限**：无。
- **实现方案**：在 T11.4 的埋点基础上追加以上字段的统计计算，定期（如每周）生成一份简报。
- **失败恢复**：数据样本不足 → 先积累，不强行给出结论。
- **验证方法**：跑一段时间后，能明确回答"5 个 Worker vs 20 个 Worker 哪个 coordination_efficiency 更高"这类问题，而不是凭直觉判断。
- **Exit**：至少产出一份包含 `coordination_efficiency` 的周期性简报，用于日后 Phase 15 Policy Calibration 的参考基线。

### T11.4-B Context Contamination Detection & Prompt View Audit（v3.3 新增）
- **优先级**：P1
- **需求**：监测每轮 Prompt View 中错误日志/过期计划/无关目录路径的占比（Contamination）；记录每轮模型实际看到的内容大小、来源、截断原因（Prompt View Audit），作为 Trace 的扩展字段，不是独立新机制。
- **数据来源**：架构文档第 39.8 节；T4.2-C Tool Gateway 的摘要/截断记录；T6.3-A 水位线触发记录。
- **权限**：无。
- **实现方案**：Context Builder 组装 Prompt View 时，同步记录 `{turn_id, total_size, sources: [...], truncated_items: [...], contamination_ratio}`；`contamination_ratio` 可用"过期/错误内容字节数 ÷ 总字节数"粗略估算，不需要精确到语义级判断。
- **失败恢复**：审计数据本身缺失或不完整 → 记为可观测性缺陷，补齐埋点，不影响业务但需登记技术债。
- **验证方法**：抽查一次真实长流程的 Prompt View Audit 记录，能明确回答"这一轮为什么变长了、哪些内容被截断了、当前 contamination 占比是多少"。
- **Exit**：Audit 记录可用于事后复盘"上下文为什么膨胀"，不需要重新翻会话记录去猜测。

### T11.5 Single-Agent Baseline
- **优先级**：P1，Multi-Worker 前置条件
- **需求**：建立"单 Worker+有限重试"的固定 Eval baseline（同信息/工具/权限/预算）,作为 Multi-Worker 上线前的强制对照组。
- **数据来源**：一组固定的真实测试任务集（建议 15-20 个,覆盖典型任务类型）。
- **实现**：跑一遍完整基线,记录成功率/耗时/token 消耗/人工介入次数。
- **失败恢复**：基线数据不稳定（同任务多次运行结果差异大）→ 先解决稳定性问题,再谈是否要上 Multi-Worker。
- **验证**：基线报告可作为后续 Multi-Worker 效果对比的基准线。
- **Exit**：基线报告产出并归档。

### T11.6 Eval Isolation
- **优先级**：P1
- **需求**：Regression/Eval 用例不得进入 Worker Context,防止评估数据污染导致虚假高分。
- **实现**：Eval 运行时使用独立的、与生产 Context Store 隔离的测试数据集；Context Resolver 增加"held-out"标记过滤。
- **失败恢复**：发现 Eval 用例意外泄漏进生产 Context → 该轮 Eval 结果作废,重新用干净数据跑。
- **验证**：故意在 Context Store 里放一条标记为 held-out 的数据,验证 Eval 运行时 Worker 拿不到它。
- **Exit**：隔离测试通过。

---

## Phase 12 — P2：Multi-Worker

> **v3.2 边界澄清（架构文档第 35 节 Worker 三层成熟度模型 / P0-16）**：本 Phase 对应 **Level B——同一 Adapter 下的多个独立 Worker Instance**，验证单元是 Instance 独立性（`worker_instance_id/process/session/lease_epoch/workspace/context projection/loop usage`），**不要求跨 CLI/Provider**。跨 CLI/Provider 的异构适配正式归属 Phase 14，本 Phase 遇到的任何外部 CLI/Provider 能力缺口，走 T0.3 Known External Gap Registry 登记为 `NON_BLOCKING`，不得阻塞本 Phase Stage Gate。

### T12.0-A Worker Plugin Manifest 契约定义（v2.1 新增，可提前于 Phase 12 主体完成）
- **优先级**：P1（契约定义本身很便宜，建议在 Phase 7 之后、真正进入 Multi-Worker 实现之前先冻结格式）
- **需求**：定义标准 `plugin_manifest.yaml` 格式（`id/adapter_entry/models_supported/capability_tags/context_limit/cost_tier/auth/discovery`），作为以后接入任何新 CLI/Agent 的统一入口，**本任务只定契约，不实现 Registry 的加载/自动发现逻辑**。
- **数据来源**：架构文档第 21 节 Worker Plugin Manifest。
- **权限**：无外部权限，纯 Schema 设计。
- **实现方案**：
  1. 用 JSON Schema/Pydantic 定义 Manifest 结构 + Validator。
  2. `discovery.type` 现阶段只支持 `static_config`（人工声明），不实现 `auto_probe`。
  3. 为已知会接入的 1-2 个未来 Worker 类型（如 codex-cli）各写一份示例 Manifest（不需要真正可运行，只验证格式）。
- **失败恢复**：Manifest 字段与 Task Contract 的 `capability_tags`/`worker_tier` 语义对不齐 → 以 Task Contract 为准修正 Manifest 字段命名，保持两者可直接映射。
- **验证方法**：Validator 校验示例 Manifest 通过；人工检查 Manifest 字段与 Task Contract 第 5 节字段一一对应，无语义冲突。
- **Exit**：Manifest Schema 冻结，且有至少 2 份示例文件通过校验——真正的 Worker Registry 加载逻辑仍等 T12.1 实现。

### T12.1-12.3 Worker Registry / Capability / Selection（含 reasoning_depth/capability_tags 落地 + Progressive Tool Expansion）
- **需求**：统一 Worker 注册表（按 T12.0-A Manifest 格式加载）；能力描述（coding/shell/browser/context_limit/languages/cost/latency）；按需求+能力+Role Profile 边界选择，**此时 Task Contract 里此前只落盘记录的 `capability_tags` 开始真正参与路由匹配**；**Worker 默认只暴露精简内建工具集（建议 <20 个），仅当 `capability_tags` 命中时才追加对应 MCP 工具，Remote 工具最后才考虑接入（架构文档第 29 节 Progressive Tool Expansion）**。
- **权限**：各 Worker 接入凭证（走 T10.3 敏感信息边界）。
- **验证**：同一 Task Contract 分别交给不同 Worker Instance,输出均符合 Result Contract；验证一个不需要 MCP 能力的简单任务，实际暴露给 Worker 的工具数量保持在精简集合内，而不是把全部已注册工具都塞给它。
- **Exit（v3.2 修订）**：**至少 2 个独立 Worker Instance 稳定接入，每个 Instance 拥有独立的 `worker_instance_id/process/session/lease_epoch/workspace/context projection/loop usage`；允许（不要求）使用同一 Adapter/CLI 类型**——取代此前"至少 2 种 Worker 类型"的表述，理由见架构文档第 35 节。工具暴露数量按需扩展而非一次性全开的机制验证通过。

> **v3.1 澄清（跨 Worker 消息通信，见架构文档第 33 节）**：Phase 12+ 若需要 Worker 间交接通知，只能用有限状态、结构化消息（如 `{type: HANDOFF_READY, task_id, from, to}`）做"叫醒/通知"，收到消息仅触发 Controller 重新检查该 Task 的 Ready 判定（走 T1.3-B Artifact Handoff Contract），消息本身不作为任务状态的来源——真相依然在 Persistent State。不允许实现开放式 Agent 间自然语言对话作为协作机制。

### T12.4 Worker Pool Lifecycle Manager
- **优先级**：P2，**Phase 12 Stage Gate 必过项**
- **需求**：区分 `local_process_worker`（Warm Pool + idle_timeout）/`cli_ephemeral_worker`（即起即销）/`remote_agent_worker`（scale-to-zero）；空闲判定"队列非空则不销毁"；派单用 Lease 原子锁定防重复派发；**至少同时管理 2-3 个同 Adapter 的 Worker Instance（如 2-3 个 PI Worker 进程）**。
- **实现**：Worker 状态机 `COLD→WARMING→IDLE→LEASED→BUSY→IDLE→...→DEAD`；BUSY→IDLE 之间强制清空会话上下文（复用进程,不复用上下文）。
- **失败恢复**：Lease 原子锁定失败/冲突 → 重试选择下一个空闲 Worker,不阻塞派发。
- **验证**：两个即将 Ready 的任务同时请求 Worker,验证不会被同一个 Worker 重复接单（不发生 double dispatch）；验证空闲超时后进程正确销毁；验证 Worker Crash 后可以回收/reassign；验证 Session Context 不跨 Task 泄漏。
- **Exit**：并发派单与生命周期测试通过，且证明同时管理 ≥2 个真实并发 Worker Instance。

### T12.5 Worker 实测成功率反馈
- **优先级**：P2
- **需求**：`worker_id+task_type→历史成功率`统计,作为 Worker Selection 次要权重参考。
- **实现**：简单计数器,不需要模型。
- **验证**：某 Worker 类型在某任务类型上成功率持续偏低,验证 Selection 会降低其优先级。
- **Exit**：反馈闭环测试通过。

### T12.6 Provider Quota / Backpressure / Circuit Breaker
- **优先级**：P2，**v3.2 提级为 Phase 12 Stage Gate 必过项**（原因：同 Adapter 多实例大概率打向同一 Provider，比异构多 CLI 更容易撞同一份限流/配额，重要性和紧迫性上调）
- **需求**：Multi-Worker 场景下防止压垮 Provider（限流/配额耗尽/连续报错）。
- **实现**：请求速率限制；配额监控；连续失败触发熔断,暂停向该 Provider 派单一段时间。
- **失败恢复**：熔断触发 → 该 Provider 类型任务排队或降级到备用 Worker,不是直接全部失败。
- **验证**：模拟 Provider 连续返回 429/500,验证熔断器正确触发并在冷却期后恢复。
- **Exit**：熔断测试通过，且已在真实"同 Provider 多实例并发"场景下验证过。

### T12.7 Role Workspace Persistence Cache（v2.0 新增）
- **优先级**：P2
- **需求**：为常驻 Role/Worker 提供非权威性能缓存（登录态/浏览器会话/本地索引）,`authoritative: false`,可随时丢弃重建。
- **数据来源**：Worker 执行过程中产生的会话状态。
- **权限**：缓存存储读写权限；涉及登录态时需遵守 T10.3 敏感信息边界（凭证本身走密钥管理,不进普通缓存）。
- **实现**：独立于 Context Cache 的 Workspace Cache 层,带 TTL,重启/清空不影响任务可执行性。
- **失败恢复**：Workspace Cache 损坏 → 任务必须仍能仅凭 Persistent State+Task Contract 重新执行（可能变慢）。
- **验证**：**关键测试**——清空 Workspace Cache 后重跑一个依赖它的任务,验证系统能重新建立环境并完成任务,只是耗时变长,而不是失败。
- **Exit**："缓存清空不影响正确性,只影响速度"测试通过。

### Phase 12 Stage Gate 总览（v3.2 新增，正式取代此前分散的验收表述）
以下全部 PASS 才能进入 Phase 13：
- ≥2 个真实 Worker Instance（同 Adapter/CLI 类型即可，不要求跨 CLI）
- 每个 Instance 拥有独立 process/session
- Worker Registry 正确登记、capability matching 正确
- Lease 原子领取，不发生 double dispatch
- Worker BUSY/IDLE/DEAD 生命周期正确
- Worker crash 可以回收/reassign
- Session context 不跨 Task 泄漏
- Coordination Budget 有效
- **Provider backpressure/circuit breaker 有效（T12.6，本 Phase 必过项）**
- Result/Work Receipt/Verification 保持既有不变量不退化
- 任何在此过程中遇到的外部 CLI/Provider 能力缺口，均已按 T0.3 登记为 `NON_BLOCKING` 并延期到 Phase 14，未拿来阻塞本 Gate

---

## Phase 13 — P2：Parallel / Batch

> **v3.2 边界澄清（架构文档第 36 节）**：**Phase 13 PASS 正式定义为 Personal PI P0 Multi-Worker MVP 的达成节点**——不是"两个不同 AI CLI 协同"，而是"复杂任务可以被多个真实隔离 Worker Instance 并行协作完成"。本 Phase 新增三组强制验收场景（见下方 T13.4），任一场景未通过，不得判定 Phase 13 PASS。

### T13.0 BATCH Policy
- **需求**：碰撞检查通过且上下文高度重叠的叶子任务合并为一次 Worker 调用,验收仍逐 Task 独立。
- **验证**：3 个子任务合批执行,其中 1 个故意验收失败,其余 2 个仍能独立 PASS。
- **Exit**：BATCH 验收独立性测试通过。

### T13.0-A BatchResult Envelope
- **优先级**：P2
- **需求**：定义批量结果信封,解决"一次调用、多个独立 Task 验收"的映射缺口。
```yaml
batch_result:
  batch_id:
  worker_id:
  lease_epoch:
  results:
    - {task_id:, status:, changed_files: [], artifacts: [], evidence: [], errors: []}
```
- **实现**：Controller 收到后逐条拆解为独立 Result,分别送 Verification,不允许对整批给单一 PASS/FAIL。
- **失败恢复**：批内某子任务解析失败 → 标记 UNKNOWN,其余正常验证,不因一个异常牵连整批。
- **验证**：构造解析异常的子结果,验证不影响其余子任务判定。
- **Exit**：BATCH 模式无"一荣俱荣、一损俱损"现象。

### T13.1 Parallel Eligibility（碰撞检查）
- **需求**：无依赖+无文件冲突+可隔离+可独立验证才允许并行,允许人工否决。
- **验证**：两任务改同一文件,判定"必须串行"。
- **Exit**：碰撞检查准确率测试通过。

### T13.2 Worktree Isolation
- **需求**：每个并行 Worker 独立工作副本。
- **验证**：并行执行后两 worktree 互不干扰。
- **Exit**：隔离测试通过。

### T13.3 Merge / Integration（含重新验证）
- **需求**：Integration Worker 负责合并+整体验证；**合并后必须对最终状态重跑 Verification,不能复用分支级 PASS**（见 T4.4）。
- **失败恢复**：冲突按类型分流（文本/契约/行为/范围）,契约冲突升级人工,范围冲突默认作废越界部分。
- **验证**：两分支存在文本冲突,验证正确处理或正确上报阻塞。
- **Exit**：集成测试通过,最终产出可演示。

### T13.4 三组强制验收场景（v3.2 新增，Phase 13 PASS 的必要条件）
- **优先级**：P0（Phase 13 不可跳过的验收内容，而非可选增强）
- **需求**：必须真实跑通以下三组场景，缺一不可，且第三组尤其关键——证明系统不是 happy-path demo。
- **数据来源**：一个真实项目，包含至少 3 个可并行的子任务。
- **权限**：与各子任务本身的权限声明一致。
- **实现方案与验证方法（三组场景）**：
  1. **Parallel Read/Analysis**：三个 Worker Instance 分别分析架构/代码/测试，第四个 Task 消费三份 Artifact 做 synthesis。验证：DAG fan-out/fan-in 正确，Artifact Handoff（T1.3-B）正确触发下游 READY。
  2. **Parallel Coding**（权重最高）：Worker A 改模块 A、Worker B 改模块 B、Worker C 补测试，各自在独立 Worktree（T13.2）工作；Integration Worker（T13.3）合并后重新跑 Verification，不复用分支级 PASS。验证：**必须有 timestamp/trace 证明 A/B/C 存在真实的 execution overlap**（并发窗口有重叠），不能三个 Worker 实际串行执行却被记录为"Parallel"。
  3. **Failure Recovery**：故意让 Worker B 超时/崩溃；验证 A/C 不受影响；B 的 Lease 被正确回收（T1.4 Fencing）；任务被 reassign；若旧 B 之后才迟到返回结果，其携带的过期 `lease_epoch` 必须被拒绝；最终整个 DAG 仍能完成。
- **失败恢复**：任一场景未通过 → Phase 13 不得判定 PASS，定位是碰撞检查（T13.1）、隔离（T13.2）、合并验证（T13.3）还是 Fencing（T1.4）哪一环出问题，针对性修复后重新跑全部三组场景（不能只重跑失败的那一组，防止修复引入新的回归）。
- **验证方法**：见上方三组场景描述；场景二的 execution overlap 证据是本任务的核心交付物，必须能拿出具体的时间戳数据支撑，不接受口头/推断性说明。
- **Exit**：三组场景全部真实跑通，且场景二的 execution overlap 证据完整可查。

---

### Phase 13 Stage Gate 总览（v3.2 新增）—— ★ 达成即为 Personal PI P0 Multi-Worker MVP ★
以下全部 PASS：
- T13.0/T13.0-A BATCH 与 BatchResult 独立验收正确
- T13.1 Parallel Eligibility 碰撞检查正确
- T13.2 Worktree Isolation 隔离正确
- T13.3 Merge/Integration 合并后重新验证（不复用分支级 PASS）
- **T13.4 三组强制验收场景全部通过，含真实 execution overlap 证据**
- Loop Budget / Coordination Budget 在并行场景下依然有效
- Single-Agent Baseline（T11.5）已作为前置对照完成
- **跨 CLI/Provider（异构 Worker）不要求**——这是本次 v3.2 变更评审的核心结论，见架构文档第 36 节判定表

全部满足 → 正式宣告 **Personal PI P0 Multi-Worker MVP 达成**，之后才进入 Phase 14。

---

## Phase 14 — P2：多 CRI

> **v3.2 说明**：本 Phase 是 GAP-01（Codex CLI `observed_runtime_model` 无法可靠获取）的正式处理位置——不再阻塞 Phase 12/13。

### T14.1 CRI Adapter 标准化
- **需求**：多 CLI 只是 Adapter 差异问题；新增 CRI 不修改 Controller/DAG/Verification/Persistent State，只增加 Adapter。
- **验证**：新增一个 CRI 类型的接入,改动范围局限在 Adapter 层。
- **Exit**：接入验证通过。

### T14.2 Codex Runtime Identity Attestation（v3.2 新增，处理 GAP-01）
- **优先级**：P2，非阻塞（对应 T0.3 登记的 GAP-01，`mvp_impact: NON_BLOCKING`）
- **需求**：解决 Codex CLI 无法可靠返回 `observed_runtime_model` 的问题，作为 Level C 异构 Multi-CRI 验证的一部分,不再是 Phase 12/13 的前置条件。
- **数据来源**：T0.3 登记的 GAP-01 记录。
- **权限**：Codex CLI/账号访问权限。
- **实现方案**：
  1. 优先尝试从 Codex CLI 更新版本或其他可用 telemetry 接口获取可靠的 runtime identity。
  2. 若确认 Codex 现有 execution surface 无法提供，评估是否有其他异构 Worker 候选（第二个 CLI/Provider）可以更快满足 Level C 验证需求，Codex 保留为实验性 Adapter 继续观察。
- **失败恢复**：**不允许用配置值伪造 `observed_runtime_model` 来冒充已验证**——这是 GAP-01 登记时已明确的红线，任何"变通方案"若涉及伪造证据，一律拒绝，继续保持 `NON_BLOCKING` 延期状态。
- **验证方法**：真实 probe 获取 `observed_runtime_model` 且与实际执行的 model/provider 一致。
- **Exit**：GAP-01 关闭（Codex 方案奏效）或改用第二个 CLI/Provider 完成 Level C 验证（GAP-01 保留为长期观察项，不影响 Phase 14 整体 PASS）。

### T14.3 PPH 能力边界清单落地（v3.4 新增，治理任务，贯穿全生命周期）
- **优先级**：P1，建议在每次新增能力评审时复查，不是一次性任务
- **需求**：确保 PPH 内核不吸收宿主项目的业务逻辑（具体 Provider 业务集成、OAuth 流程、API Key 轮询、SSE 转换、Token 用量页面/Dashboard、宿主项目专属 Provider 配置 UI），只提供通用的 Worker/任务/证据/验证/状态管理能力。
- **数据来源**：架构文档第 46 节；ai-proxy 真实交付场景暴露的边界模糊风险。
- **权限**：无，是代码评审/架构评审层面的纪律，不是运行时组件。
- **实现方案**：
  1. 新增能力提案时强制回答："如果换成一个完全不同的宿主项目，这个能力还有意义吗？"，答案是否定的一律不进 PPH 核心仓库。
  2. 在 CI 或代码评审清单中加入该判断标准的检查项。
- **失败恢复**：发现已有代码违反此边界（如 PPH 核心里混入了 ai-proxy 专属的 Provider 配置逻辑）→ 记为技术债，制定拆分计划迁出，不要求立即修复但需要登记跟踪。
- **验证方法**：抽查 PPH 核心代码库，确认不存在任何单一宿主项目专属的业务逻辑硬编码。
- **Exit**：边界清单成为标准评审项，纳入日常开发纪律。

---

## Phase 15 — P3：Adaptive Policy

### T15.1 Policy Calibration
- **需求**：分析哪些任务过度拆分/选错 Worker。
- **Exit**：形成可执行的 Policy 调整建议报告。

### T15.2 Learned Routing
- **需求**：轻量模型建议 + Rule Guard 强制覆盖,硬性规则永不下放。
- **验证**：模型建议违反安全规则时,Rule Guard 成功拦截。
- **Exit**：拦截测试 100% 通过。

### T15.3 Plan Regression Dataset（含 Preclassifier 假阴性子类）
- **需求**：规划失误反哺 Playbook；假阴性单独统计（见 T2.0-A）。
- **Exit**：形成可持续迭代的规划知识资产。

---

## 总体开发顺序图（v3.4）

```
T0.1→T0.2→T0.3（Known External Gap Registry）
→ T2.0-B（Task Compiler / Ingress Gate，实际最先生效）
→ T1.1→T1.1-A→T1.1-B→T1.2→T1.3→T1.3-A→T1.3-B→T1.4→T1.5→T1.6
→ T2.0→T2.0-A→T2.1→T2.2→T2.3→T2.3-A→T2.4→T2.5→T2.6→T2.7→T2.7-A（Project Registry）→T2.7-B（Task Ledger）→T2.7-C（稳定 CLI 入口）
→ T3.1→T3.2→T3.2-A→T3.2-B（Worker 降级状态+三层模型身份）→T3.3→T3.4→T3.5（含 Fresh Context/Receipt-only 规则）
→ T4.1→T4.1-A（标准化证据包）→T4.2→T4.2-A→T4.2-B→T4.2-C（Tool Gateway）→T4.3→T4.3-A（Acceptance/Commit 分离）→T4.4→T4.5
→ T5.1→T5.2→T5.3→T5.4→T5.5
→ T6.1→T6.2→T6.2-A（含 Allowlist 范围控制）→T6.3→T6.3-A（分层预算与水位线）→T6.4→T6.5（结构化压缩 Schema）
→ T7.0（Ingress Binding Verification，先于 T7.1）→T7.1→T7.2   【PERSONAL_PI_V0.1_CORE 达成】
→ T7.3→T7.4→T7.5   【验证 Always-on、Work Receipt、Routine Capture 与 Memory Consolidation】
→ T8.x→T8.4-A（resource_ceiling）→T9.x→T10.x（含 T10.4 Command Risk Classification、T10.5 Single-Purpose Tool Design）→T11.x（含 T11.4-A/T11.4-B、T11.5 Single-Agent Baseline）
→ T12.0-A（Worker Plugin Manifest 契约，可提前完成）→ T12.x（Multi-Worker，Level B：≥2 个同 Adapter 独立 Worker Instance，Provider Quota 为 Gate 必过项）
→ 【Phase 12 Stage Gate PASS】
→ T13.x（Parallel/Batch，含 T13.4 三组强制验收场景）
→ ★【Phase 13 PASS = Personal PI P0 Multi-Worker MVP 达成】★
→ T14.x（Multi-CRI，Level C：异构 CLI/Provider，GAP-01 处理，含 T14.3 PPH 能力边界清单落地）
→ T15.x（Adaptive Policy）
```

---

## 启动建议（首批交给 AI 的范围）

**第一批只做 Phase 0 + T2.0-B（Ingress Gate）+ Phase 1 全部**（`T0.1→T2.0-B→T1.6`，含 Loop Budget 与 Bound Coverage Audit），特点：范围小、无外部副作用、可自动化验证、不涉及真实 Worker 执行——用来检验"AI 能不能按这种粒度的任务契约干净利落地交付"。

跑完这一批用 Stage Gate 验收，通过后再开 Phase 2 其余任务（Plan Quality Gate、Role Profile、**新增的 Project Registry/Task Ledger/CLI 入口**），依次推进，直到拿到 `PERSONAL_PI_V0.1_CORE` 标签。**Role Profile / Artifact Handoff / Verification Recipe（v2.0）、Work Receipt / Verifier Context Isolation（v3.0）、Phased Permission Escalation / Deterministic Lifecycle Hooks / Scoped Context Assembly（v3.1）、Tool Gateway / 分层预算水位线 / 结构化压缩（v3.3）、Project Registry / Task Ledger / 标准化证据包 / Acceptance-Commit 分离（v3.4）这些小增量已经按顺序插入 Phase 1-8，会随主线自然完成，不需要额外单独立项。**

**v3.4 新增纪律（源自 ai-proxy 多项目交付场景评审）：**
10. **任务是否完成，唯一真相源是 Task Ledger（T2.7-B），不是外部项目自己的 Markdown 任务清单或 Agent 最后一段自然语言描述**——外部清单只是展示投影。
11. **任何标注为"只读/inspect/status"的操作，绝不允许产生状态写入副作用**——需要修复状态时必须走独立的显式写命令。
12. **Acceptance PASS 不等于可以 Commit/Push/Publish**——这四者永远是独立授权的动作，Commit 禁止使用 `git add -A`/`git add .`。
13. **PPH 核心不吸收任何单一宿主项目的业务逻辑**（Provider 业务集成、OAuth、Dashboard 等）——新增能力前先问"换个宿主项目这个能力还有意义吗"。

**v3.3 新增纪律（源自两次真实事故评审）：**
7. **任何执行入口在具备处理长/多步骤任务能力之前，必须先通过 Ingress Binding Verification（T7.0）**——不能只测"Pipeline 内部对不对"，要测"入口有没有真的接到 Pipeline"。
8. **Prompt View 必须始终有界**——原始日志/堆栈/搜索结果可以无限存档，但绝不允许原样堆进模型看到的上下文；到达"重建水位"就主动收敛，不要等 Provider 硬拒绝才发现问题。
9. **发现 Provider context-limit 或类似"越跑越长最终失控"的报错，第一时间检查的不是"要不要换更强模型"，而是"Tool Gateway/分层预算水位线是不是没生效"**——多数情况下这是架构执行力度问题，不是模型能力问题。

**v3.2 新增纪律（源自 Codex 卡点评审）：**
4. **Phase 12 的"至少 2 个 Worker"指的是 Instance 独立性，不是 CLI/Provider 种类**——不要为了凑异构 CLI 而卡在 Phase 12，同 Adapter 多实例即可通关。
5. **任何第三方 CLI/Provider 的能力限制，先走 T0.3 登记为 Gap，明确 BLOCKING/NON_BLOCKING，不在讨论中反复纠结**；`NON_BLOCKING` 的 Gap 不得阻塞无关 Phase。
6. **不允许为配合某个 Gap 而降低 Verification 标准**——正确做法永远是"延期该项能力的验证"，不是"放宽通过条件"。

**红线纪律（贯穿全清单）：**
1. 不要提前开始 Multi-Worker（Phase 12+）、不要加 Swarm/Event Bus/自由 Agent 群聊。
2. 每个 Phase 结束必须有可运行、可验证的系统状态。
3. 任何新增能力先问：**这是这周已经痛过的问题，还是想象中以后会痛的问题？** 后者只登记不实现。

---

## 版本日志

> 本节是唯一的版本追踪记录，与配套文档《pph_架构设计_latest.md》的版本日志一一对应。**版本标签只是变更序号索引，文件名固定为 `latest`，不随版本变化**。历史记录（v1.0-v3.4）无真实时间戳，从 v3.5 起记录真实日期。

| 版本标签 | 日期 | 变更人 | 变更类型 | 影响范围 | 变更摘要 |
|---|---|---|---|---|---|
| v1.0 | 历史记录 | 用户+Claude | 初始任务拆解 | Phase 0-15 全量 | 按五域内核拆出 Phase 0-15 完整任务清单，P0-P3 优先级标注 |
| v1.1-v1.1.1 | 历史记录 | 用户+Claude | 新增任务 | Phase 0-15 多处 | 补齐可靠性不变量对应任务（DoR、原子 Mutation、Fencing、Idempotency、Verification 绑定 Revision、Snapshot/Restore、Single-Agent Baseline 等） |
| v2.0-v2.1 | 历史记录 | 用户+Claude | 新增任务 | Phase 1-4/7/12 | Role Profile、Artifact Handoff、Verification Recipe、Trigger Gateway、Routine Capture、Reasoning Depth 映射、Worker Plugin Manifest |
| v3.0-v3.1 | 历史记录 | 用户+Claude | 新增任务 | Phase 1/3/4/6/7/10/11 | Loop Budget、Bound Coverage Audit、Work Receipt、Verifier Context Isolation、Graph Efficiency Metrics、Command Risk Classification、Phased Permission Escalation、Lifecycle Hooks、Scoped Context Assembly、Memory Consolidation |
| v3.2 | 历史记录 | 用户+Claude | 验收标准修订 | Phase 0/12/13/14 | 新增 T0.3 Gap Registry；T12.1-12.3 Exit 改为 Instance 独立性；T12.6 提级 Gate 必过项；新增 T13.4 三组强制场景；Phase 13 定义为 MVP 达成节点；新增 T14.2 |
| v3.3 | 历史记录 | 用户+Claude | 新增任务（事故驱动） | Phase 2/4/6/7/11 | 新增 T2.0-B、T7.0（Ingress 相关）；新增 T4.2-C、T6.3-A、T11.4-B（上下文治理相关）；升级 T6.5 结构化 Schema；补充 T3.5/T6.2-A |
| v3.4 | 历史记录 | 用户+Claude | 新增任务（多项目复用） | Phase 2/3/4/8/14 | 新增 T2.7-A/B/C、T3.2-B、T4.1-A、T4.3-A、T8.4-A、T14.3 |
| **v3.5** | **2026-09-19** | **用户+Claude 评审确认** | **流程变更** | **文件管理方式** | **文件更名为 `pph_可执行任务清单_latest.md`；新增本结构化版本日志；与架构文档共用"latest 持续更新 + 关键实现节点前打完整快照"的双轨机制** |

> **当前状态**：与配套架构文档一致，下一次变更前只需阅读本表最新几行即可掌握现状。
