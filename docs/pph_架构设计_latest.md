# Personal PI Harness — 项目架构设计（Latest）

> 本文档是唯一持续更新的架构权威源，自包含，不需要对照历史版本阅读。所有变更记录于文末"版本日志"，日志本身带版本标签仅作为变更序号索引，与文件名/标题无关——文件名固定为 `latest`，不随版本变化。
> **使用方式**：`latest` 随时可能被继续修改；若要在其基础上开始一段实现工作，先从本文件打一份完整快照（如 `pph_架构设计_v3.5.md`），实现期间以快照为准，`latest` 继续独立滚动更新。

---

## 0. 一句话定义（v2.0 更新）

> **Personal PI 是一个以 Persistent State + Versioned Contract 为真相源、以 Task Contract 为执行契约、
> 以 Master/Controller 为可重建的调度大脑、以 Worker 为可替换执行后端、以 Evidence + Verification 为完成判定标准的可靠个人软件交付内核；
> 在这个内核之上，可以叠加一层 Persona/Chief of Staff 交互外壳，让用户以"分配给某个角色"的直觉方式使用系统，但这层外壳永远不掌握真相、不做最终裁决。**

```
Persona / Team 外壳（UX，可选，不影响内核正确性）
──────────────────────────────────────
Reliable Kernel（Task/Contract/State/Evidence/Verification）
```

它不是：
- ❌ 一个"多 Agent 框架"
- ❌ 一群有记忆、有身份、靠聊天协作的"数字员工"（这是 Grok Bot 的模型，故意不采用）
- ❌ 蜂群（Swarm）的缩小版

它是：
- ✅ 先把"契约化任务 + 中控调度 + 证据验证 + 状态一致性"这个**内核**跑到生产级可靠，再在其上包一层让人好用的角色化交互界面。

---

## 1. 十八条冻结架构原则（P0 级，不可违反）

| 编号 | 原则 | 来源 |
|---|---|---|
| P0-01 | Master PI 只负责控制（理解/评估/调度/验收），不负责业务执行。 | v1.0 |
| P0-02 | 所有执行必须落到标准 Task Contract，禁止"裸提示词"直接派工。 | v1.0 |
| P0-03 | Task 是核心对象，Task Graph（DAG）只是组织形式。 | v1.0 |
| P0-04 | Worker 不拥有任务调度权，不能自己领单。 | v1.0 |
| P0-05 | 完成判定必须走 Evidence → Verification → PASS，不采信 Worker 自称完成。 | v1.0 |
| P0-06 | 上下文采用 Projection（引用式），禁止全量复制。 | v1.0 |
| P0-07 | Context/Artifact/Result 用统一内容可寻址缓存，优先复用事实。 | v1.0 |
| P0-08 | 执行策略（单/拆/并）由 Assessment + Policy 决定，不靠 Master 黑盒判断。 | v1.0 |
| P0-09 | Multi-Agent/Parallel/Multi-CRI 是可替换的执行策略，不属于内核。 | v1.0 |
| P0-10 | 任何能力进阶必须通过 Stage Gate，代码写完 ≠ 阶段完成。 | v1.0 |
| **P0-11** | **任何判断类输出（Assessment/Verification/Capability/Ready 判定）都必须有独立于产出者本身的低成本复核点。** | v1.1 |
| **P0-12** | **Master/Controller 是逻辑唯一但物理可替换的控制者；真正的真相源是 Persistent State + Versioned Contract，不是任何单个进程或聊天上下文。** | v1.1-audit |
| **P0-13** | **协议元数据（revision/fencing/idempotency 类字段）只在 Controller↔Worker 协议层传递，禁止整体注入 LLM Prompt。** | v1.1.1 |
| **P0-14** | **Persona/Chief of Staff/Role 是 UX 与路由便利层，永远不是真相源、不能自己判定 risk/READY/approval 有效性/verification 是否 PASS。** | v2.0 |
| **P0-15（新增）** | **任何可能重新进入先前执行状态的反馈路径（Worker↔Verifier↔Repair、Decomposer 递归、未来的多 Agent 交接循环等），都必须被至少一个可机器验证的确定性预算（Loop Budget）覆盖；模型判断、工具返回或自然语言"完成"不得作为唯一终止条件。** | v3.0 |
| **P0-16（新增）** | **Multi-Worker 的验证单元是 Worker Instance（独立 process/session/lease_epoch/workspace），不是 Worker CLI/Provider 种类；跨 CLI/Provider 的协议适配属于 Multi-CRI 的独立验证范畴，不得作为 Multi-Worker Stage Gate 的前置条件。** | v3.2 |
| **P0-17（新增，重大缺口修复）** | **任何面向用户的执行入口（CLI/交互式会话/coding-agent）在执行超出预设边界的多步骤实质性工作前，必须经过 Task Compiler 接入 Pipeline（Task Contract → Dispatch → Loop Budget → Persistent State）。若该入口当前无法完成这一接入，必须 Fail-Closed（拒绝执行或降级为受严格预算限制的单一有边界任务），禁止以"在同一会话内批量调用工具、自行模拟多步协作"的方式替代真正的 Pipeline 接入。** | v3.3 |
| **P0-18（新增）** | **任何一次模型调用看到的上下文（Prompt View）必须是从完整审计记录/工具输出中按预算与引用规则重新构建的有界视图，不得等于或包含未过滤的原始会话/工具输出全文。原始记录（日志、堆栈、搜索结果）可以无限增长并完整保存于 Artifact Store，但 Prompt View 必须始终有界——审计完整性不得反过来吞噬模型上下文。** | v3.3 |

---

## 2. 总体架构图（v2.0）

```
                              USER
                               │
                    ┌──────────▼──────────┐
                    │  Chief of Staff /    │   ← P1，可选 UX 外壳
                    │  Persona Interaction │      （P0-14：无裁决权）
                    └──────────┬──────────┘
                               │ Intent / Goal
════════════════════ Reliability Boundary ════════════════════
                               │
                    ┌──────────▼──────────┐
                    │      MASTER PI       │  ← Control Brain
                    │   Control Plane      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Requirement Contract │  ← 八栏澄清
                    │ (含商业/非功能维度)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ RISK PRECLASSIFIER   │  ← 规则式，零 LLM 成本
                    │  FAST / SLOW 分流    │
                    └────┬─────────────┬───┘
                    FAST │             │ SLOW
                         │      ┌──────▼──────┐
                         │      │ Architecture │
                         │      │ & Commercial │
                         │      │  Assessment  │
                         │      └──────┬──────┘
                         │      ┌──────▼──────┐
                         │      │ PLAN QUALITY │
                         │      │    GATE      │  ← 人工冻结签字
                         │      └──────┬──────┘
                         └──────┬──────┘
                                ▼
                    ┌──────────────────────┐
                    │   TASK GRAPH (DAG)    │
                    │ Node + Typed Edge     │
                    │ + Artifact Handoff    │  ← v2.0 新增
                    │ + Revision            │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼──────────┐
                    │  DEFINITION OF READY │  ← Schema/权限/Acceptance 复检
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   TASK ASSESSMENT    │  + 规则级交叉校验（P0-11）
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   DISPATCH POLICY    │  SINGLE/DECOMPOSE/PARALLEL/BATCH
                    │  + worker_tier 成本  │
                    │  + Role Profile 匹配 │  ← v2.0 新增
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ CONTROLLER/DISPATCH  │  Lease + Fencing Token
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ CONTEXT PROJECTION   │  引用式 + Prompt Cache
                    │ （协议元数据物理隔离）│  ← P0-13
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   WORKER ADAPTER     │  execute(Contract)→Result
                    │  + Role Profile 注入 │  ← v2.0 新增
                    │  + Workspace Cache   │  ← v2.0 新增（非权威）
                    └───┬──────┬──────┬───┘
                        ▼      ▼      ▼
                  Worker PI  CLI   其他 Agent
                        └──────┼──────┘
                               ▼
                    ┌──────────────────┐
                    │   RUN / ATTEMPT   │  idempotency_key
                    └────────┬──────────┘
                               ▼
                    ┌──────────────────┐
                    │ RESULT / EVIDENCE │  （支持 BatchResult 信封）
                    └────────┬──────────┘
                               ▼
                    ┌──────────────────┐
                    │   VERIFICATION    │  绑定 commit/diff/artifact digest
                    │ 确定性优先 + 强度分级│
                    └───┬───┬───┬──────┘
                        ▼   ▼   ▼
                     DONE RETRY BLOCKED
                               │
                    ┌──────────▼──────────┐
                    │  PERSISTENT STATE    │  ← 唯一真相源（P0-12）
                    │ + Snapshot/Restore   │
                    └──────────┬──────────┘
                               │
                          NEXT READY TASK（循环直至叶子全完成）
```

**横切基础设施：**
```
Context Cache | Artifact Store | Trace/Audit | Decision Record | Token/Cost/Cache 统计
Effect Journal（幂等副作用） | Trigger Gateway（外部事件→Task Contract）
```

---

## 3. 分层结构

### 3.1 Core Kernel（P0）—— 5 大内核域，原有 13 项能力不变

| 内核域 | 能力 | 职责 |
|---|---|---|
| ① Control | Master、Risk Preclassifier、Policy、Controller | 唯一调度者 |
| ② Task | Task Contract（含 revision）、DAG（含 Artifact Handoff 边）、State Machine、Atomic Mutation | 核心状态对象 |
| ③ Execution | Worker Runtime、Run/Attempt（含 idempotency_key）、Lease/Fencing | 可替换执行后端 |
| ④ Quality | Result Contract、Evidence、Verification（强度分级+revision绑定） | 证据判定完成 |
| ⑤ State | Persistent State（唯一真相源）、Context Projection、Snapshot/Restore、基础 Trace | 崩溃可恢复、可回溯 |

> **五域数量维持不变**——v1.1、v1.1.1、v2.0 的所有新增能力全部挂在这五域下，没有出现需要独立于五域之外的新职责，说明原始内核边界划分是对的。

### 3.2 Application Layer（P1）

| 模块 | 说明 | 来源 |
|---|---|---|
| 八栏 Requirement Contract | 用户/数据/权限/交付/验收/未知项 + 可持续性/商业化路径 | v1.1 |
| Architecture & Commercial Assessment + Plan Quality Gate | 中高风险/新项目才触发，防止 Master 单点规划偏差 | v1.1 |
| Fast/Slow Risk Preclassifier | 规则式零成本分流，防止小任务被过度治理 | v1.1 |
| Definition of Ready（DoR） | Ready 判定前复用 Schema Validator | v1.1 |
| 原子 Graph Mutation | Decomposition 写入必须整批提交 | v1.1 |
| Verification 强度分级 | strong/weak/none，weak 不解锁高风险下游 | v1.1 |
| Context Compaction Policy | 跨任务摘要级引用，不整体复制 Evidence | v1.1 |
| Worker Pool Lifecycle Manager | Warm Pool/Ephemeral 分类、idle_timeout | v1.1 |
| Human Approval Gate（升级） | 绑定 action_digest+revision+expires_at | v1.1-audit |
| Persistent State Snapshot + Restore Drill | 备份必须验证可恢复 | v1.1-audit |
| Decomposition Budget | max_depth/children/tasks/replan | v1.1-audit |
| Single-Agent Baseline & Eval Isolation | Multi-Worker 前必须有同预算对照组；回归用例不进 Worker Context | v1.1-audit |
| Plan Regression Dataset（含 Preclassifier 假阴性子类） | 规划失误反哺 Playbook | v1.1/v1.1.1 |
| Protocol Metadata Isolation | 见 P0-13 | v1.1.1 |
| **Role Profile（新）** | 长期角色定义，Role ≠ Worker Instance | v2.0 |
| **Artifact Handoff Contract（新）** | Task 依赖升级为带 schema/digest 校验的产物依赖 | v2.0 |
| **Verification Recipe（新）** | 按任务类别预定义"如何证明完成"，纳入 Playbook | v2.0 |
| **Trigger Gateway（新）** | Cron/Webhook → 创建 Task Contract，不直接调用 Worker | v2.0 |
| **Demonstration-based Routine Capture（新）** | 成功 Run 经人工确认后提炼为可复用 Task Template | v2.0 |
| **Coordination Budget（新）** | max_active_workers/max_handoffs_per_task/max_concurrent_roles，限制"组织膨胀" | v2.0 |
| **Loop Budget（新）** | Task 级、跨 Run 的反馈路径累计预算，落地 P0-15 | v3.0 |
| **Bound Coverage Audit（新）** | Stage Gate 新增设计审查项：每条可回到旧状态的路径必须有确定性预算覆盖 | v3.0 |
| **Work Receipt / No-op Receipt（新）** | 区分"Pipeline Green"与"真实工作发生"，no_op 需显式理由 | v3.0 |
| **Verifier Context Isolation（新）** | Verifier 输入白名单，禁止读取 Worker 私有推理/scratchpad | v3.0 |
| **Graph Efficiency Metrics（新）** | Coordination Efficiency = Verified Tasks / (Handoffs+Retries+Calls)，"最小图"优化方向 | v3.0 |

### 3.3 Execution Scaling（P2）

> **v3.2 澄清**：本层对应 Worker 三层成熟度模型（见第 35 节）的 Level B（Phase 12,同 Adapter 多实例）与 Level C（Phase 14,异构 Multi-CRI）。**Multi-Worker（Phase 12）不要求跨 CLI/Provider，只要求 Worker Instance 相互独立**；跨 CLI/Provider 的适配问题正式归属 Phase 14。

| 模块 | 说明 | 来源 |
|---|---|---|
| Multi-Worker / Worker Registry / Worker Capability | 统一 Adapter 接入 PI/Codex/Claude/CLI；**Phase 12 MVP 只需同一 Adapter 下 ≥2 个独立 Worker Instance** | v1.0，v3.2 澄清 |
| Provider Quota / Backpressure / Circuit Breaker | 防止多 Worker 压垮 Provider；**v3.2：同 Adapter 多实例更容易撞同一 Provider 限流，此项提升为 Phase 12 Stage Gate 必过项** | v1.1-audit，v3.2 提级 |
| Parallel Execution Wave / Worktree Isolation / Integration Worker | 并行执行；**v3.2：Phase 13 PASS 正式定义为 P0 Multi-Worker MVP 达成节点**（见第 36 节） | v1.0，v3.2 澄清 |
| BATCH Policy + BatchResult 信封 | 上下文高度重叠的叶子任务合并派发，逐子任务独立验收 | v1.1/v1.1.1 |
| Multi-CRI | Adapter 层问题，非架构问题；**外部 CLI/Provider 能力缺口（如 runtime identity attestation）统一走 Known External Gap Registry 登记（第 37 节），不阻塞 Phase 12/13** | v1.0，v3.2 澄清 |
| **Role Workspace Persistence Cache（新）** | 非权威缓存：登录态/浏览器会话/本地索引，可丢弃重建 | v2.0 |

### 3.4 Intelligence / Distributed Layer（P3）

| 模块 | 说明 |
|---|---|
| Policy Calibration | 用历史数据校准过度拆分/选错 Worker |
| Learned Routing | 规则+历史数据+轻量模型，硬性安全规则永不下放 |
| Swarm 实验 / Event Bus / Remote Worker | 明确推迟，不因为看到 Grok Bot / 其他多 Agent 产品而提前 |
| Dashboard / 长期优化 | 面向长期使用的可视化 |

---

## 4. 里程碑成熟度矩阵（M0–M7）

| Milestone | 名称 | 对应 Phase | 核心验收 |
|---|---|---|---|
| M0 | PI Baseline | Phase 0 | 原生 PI 稳定跑通固定测试任务 |
| M1 | Personal PI（个人上下文分层） | — | 20 项个人评估集通过 |
| M2 | Single-Agent Harness | Phase 1–2 | Task→Verify 闭环，含 v1.1 全部可靠性不变量 |
| **M2.5（新）** | **Role-Aware Single Worker** | Phase 2.7 | 单 Worker 已能按不同 Role Profile 切换行为边界，Persona 先成熟 |
| M3 | Sub-Agent / Handoff | Phase 3 | 结构化交接（Artifact Handoff Contract）验证通过 |
| M4 | Agent Pool / Routing | Phase 12 起步 | Routing Accuracy ≥ 90% |
| M5 | Workflow / Pipeline | Phase 8 | 复杂任务自动拆解为 DAG 并端到端跑通 |
| M6 | Fan-out / Fan-in | Phase 11/13 | 2 个并行 Agent 互不干扰，Integration Worker 正确合并 |
| M7 | Swarm / Multi-CRI | Phase 12–14 | 多 CRI 只是 Adapter 差异 |

---

## 5. Task Contract 标准 Schema（v2.0，累计所有字段）

```yaml
task:
  id:
  schema_version: 2
  task_revision: 1              # 乐观并发控制
  graph_revision:                # 所属 Graph 的版本
  type:
  title:

  objective:
  requirements:
  constraints:
  scope:
    files: []

  role_profile_ref:              # v2.0 新增：引用 Role Profile（可空=不区分角色）

  inputs:
  data_sources: []
  data_references: []            # 引用式

  permissions:
    filesystem: {read: [], write: []}
    shell: {allowed: []}
    network: deny|allow
    credentials: deny            # 默认拒绝；如需，走 role_profile.credential_scope

  execution:
    worker_type: pi|codex|claude|local_model|cli
    worker_tier: cheap|standard|frontier          # v2.1 新增：选哪档模型/供应商
    reasoning_depth: low|medium|high|extended     # v2.1 新增：该模型内部开多大推理/思考预算
    capability_tags: []                            # v2.1 新增：任务所需能力标签，如 [coding, browsing, long_context, math, tool_use]
    mode: single|decompose|parallel|batch
    working_directory:
    allowed_tools: []
    idempotency_key:             # 涉及外部副作用时必填

  dependencies: []                # DEPENDS_ON 边
  artifact_dependencies: []       # v2.0：Artifact Handoff Contract 引用（见第 12 节）
  expected_outputs: []

  acceptance_criteria: []
  verification:
    strategy: automated|manual
    commands: []
    checks: []
    evidence_required: []
    strength: strong|weak|none    # v1.1 新增
    recipe_ref:                    # v2.0 新增：引用 Verification Recipe

  context:
    required: []                  # content-hash 引用
    optional: []
    excluded: []
    budget: {max_input_tokens: }

  risk: low|medium|high
  priority: P0|P1|P2|P3
  timeout:                        # 单次 Run 的超时（Run 级）
  retry_policy: {max_attempts:, backoff:}   # 单次 Run 的重试配置（Run 级）

  loop_budget:                    # v3.0 新增：跨越多次 Run/工具调用/模型调用的整条反馈路径累计上限（Task 级）
    max_attempts:                  # 该 Task 允许的 Run 总次数上限（含 retry/repair/reassign）
    max_model_calls:
    max_tool_calls:
    max_handoffs:                  # 未来多 Agent 交接场景的上限
    max_elapsed_ms:
    max_input_tokens:
    max_output_tokens:
    max_cost_usd:
    max_state_growth_bytes:
    on_exhaustion:
      action: BLOCKED
      escalation: human

  approval:                       # v1.1-audit
    required: false
    action_digest:
    bound_revision:
    expires_at:
```

> **`loop_budget` 与 `timeout`/`retry_policy` 的关系（不是重复字段）**：`timeout`/`retry_policy` 管的是**单次 Run**；`loop_budget` 管的是**这个 Task 从创建到终态，跨越多次 Run、多次工具调用、多次模型调用（包括未来的 Decomposer 递归、Worker↔Verifier↔Repair 循环、多 Agent 交接）的累计上限**。前者是局部约束，后者是全局兜底——即便每次 Run 都遵守了 timeout，外层反复"失败→修复→重试"的循环仍可能在总量上失控，`loop_budget` 就是堵这个口子。

> 协议元数据字段（`task_revision/graph_revision/lease_epoch/idempotency_key/action_digest` 等，见第 11 节 Run Contract）**只在 Controller↔Worker 协议层传递，不整体进入 Prompt**（P0-13）。

---

## 6. Task Graph 模型（v2.0）

- Tree 是 DAG 特例，调度器操作 DAG，UI 可展示 Tree。
- 五种边类型（不变）：`DEPENDS_ON / PRODUCES_ARTIFACT / PROVIDES_DATA / BLOCKS / REQUIRES_APPROVAL`。
- **v2.0 升级**：`PRODUCES_ARTIFACT` 可绑定 **Artifact Handoff Contract**（见第 12 节），使"上游 DONE"和"下游 READY"解耦——上游完成不等于下游可以开始，必须产物通过 schema/digest 校验。
- 禁止环，写入时检测。
- Graph 写入必须走**原子 Mutation**（整批子任务+依赖边一起提交或全不提交）。

---

## 7. Context Projection & 统一缓存系统（不变，P0）

（同 v1.0/v1.1，核心原则：Cache Facts, not Cache Conversation）

**v2.0 补充**：Role Workspace Persistence Cache（第 13 节）是**独立于**本节 Context Cache 的另一层缓存，二者不可混用——Context Cache 缓存"事实"（文件/产物/测试结果），Workspace Cache 缓存"环境状态"（登录态/浏览器会话），前者是权威可复用引用，后者是非权威、可随时丢弃重建的性能优化。

---

## 8. 可靠性不变量（v1.1-audit 全量保留）

### 8.1 Fencing Token
Lease 采用单调递增 `lease_epoch`；Worker 回传结果必须携带其领取时的 epoch，Controller 只接受当前最新 epoch 的结果，过期 epoch 一律拒绝（防止旧 Worker 迟到写入）。

### 8.2 Effect Journal（幂等副作用）
```yaml
effect:
  idempotency_key:
  action_digest:
  target:
  status: pending|committed|failed
  reversible: true|false
  compensation_action:           # 下游系统不支持幂等键时的补偿动作（Saga 模式兜底）
```

### 8.3 Verification 绑定 Revision
PASS 结果必须绑定 `commit_hash / diff_digest / artifact_digest / task_revision`；工作区在验证后发生变化，旧 PASS 自动失效，必须重新验证（防 TOCTOU）。并行分支合并后必须对最终状态重跑 Integration Verification，不能复用分支级 PASS。

### 8.4 Approval Binding
```yaml
approval:
  action_digest:      # 绑定具体动作内容的哈希
  bound_revision:      # 绑定当时的 task/graph revision
  expires_at:
```
架构/契约发生变更后，原审批自动失效，不能被新方案复用。

### 8.5 Snapshot + Restore Drill
Stage Gate 通过后自动快照；快照必须定期演练恢复（Restore Drill），"有备份"不等于"能恢复"。

### 8.6 Decomposition Budget
```yaml
decomposition_budget:
  max_depth:
  max_children_per_task:
  max_total_open_tasks:
  max_replan_count:
```

### 8.7 Single-Agent Baseline & Eval Isolation
Multi-Worker 上线前必须有相同预算下的单 Worker 基线对照；Regression/Eval 用例不得进入 Worker Context，防止评估数据污染。

---

## 9. Fork / 上游同步策略（不变）

三层 Fork（Upstream Core / Thin Patch / Personal Harness）+ 受控升级流程，详见 v1.0 原文，本版本不变。

---

## 10. 现网可借鉴生态（v2.0 新增 Grok Bot 一行）

| 类别 | 代表项目 | 借鉴内容 | 引入阶段 |
|---|---|---|---|
| 底座与官方扩展法 | earendil-works/pi, pi.dev | 最小核心、分层扩展 | 第一周必读 |
| 总控+工人包 | pi-agent-harness 系 | 六种团队结构（仅借分职） | Phase 12+ |
| 个人发行版样本 | dotagents | harness 是"可同步的文件" | 第一周 |
| 作业系统/阶段门 | pi-harness-skills | 阶段结果落盘 | Phase 0-2 |
| 演进型 harness | pi-ahe | 观察摩擦→改组件，不自动改宪法 | 稳定后 |
| **Always-on Agent Team（v2.0）** | **xAI Grok Bot** | **借：Role/Persona 分工直觉、Chief of Staff UX、Artifact 显式交接、QA Evidence Recipe、Learned Routine 的"示范录制"思路。不借：Agent 间聊天当控制协议、Persona Memory 当真相源、Role 自证验证结果、无限制账号级权限授予。** | Role Profile 等 P1 模块，见第 3.2 节 |
| **Graph/Loop Engineering（v3.0 新增）** | **《296 Agents to One Graph》+ IAL-Scan 论文（6,549 个真实 Agent 项目扫描）** | **借：Loop Budget（统一预算覆盖反馈路径）、Bound Coverage Audit、Work Receipt（"绿灯≠工作发生"）、Verifier Context Isolation（验证者不读 Worker 私有推理）、Coordination Efficiency 指标。不借：Graph 当真相源（"graph is the company"）、Role=常驻 Agent 实例、允许 Graph 出现自由 cycle、模型自己判断循环何时终止。** | Loop Budget 等 P0 模块，见第 22-25 节 |
| 反面教材 | oh-my-pi | 功能焊进核心，仅供参考交互体验 | 不建议 fork |

---

## 11. 断联/失败恢复模型（不变，v1.0）

三种失败分类 → 冻结→停工人→验现场→下结论（续做/回滚/降级/改派），详见 v1.0 原文。

---

## 12. Role Profile（v2.0 新增，核心章节）

> **Role ≠ Worker Instance**：Role Profile 定义"这个岗位该做什么、不该做什么、拿什么权限、产出什么、交接给谁"，与具体执行它的模型/进程完全解耦。同一个 Role 今天可以由本地小模型执行,明天换成 Claude/Codex，Role 本身不变——这保留了 P0-04（Worker 可替换）的原则，同时拿到了 Persona 分工的直觉体验。

```yaml
role_profile:
  id: backend-engineer
  mission: "构建后端服务与稳定的 API 契约"

  suitable_tasks: [api, database, backend, migration]
  ownership_scope:                # v2.0 明确新增：默认归属，防止多角色都"能做"但没人"该做"
    - "src/service/**"
    - "src/model/**"

  credential_scope:                # 强制字段：该角色能拿到的账号/凭证范围，禁止整体账号级授权
    allowed_services: []
    allowed_scopes: []
    forbidden: [production_deploy, permission_change, payment]

  preferred_tools: [repo, shell, test_runner]
  prohibited_actions: [production_deploy, permission_change]

  context_policy:
    required: [architecture, api_contract]
    optional: [frontend_source]

  output_contract: [changed_files, api_contract, tests, evidence]

  handoff:
    downstream: [frontend-engineer, qa]

  verifier_profile: [unit_test, integration_test]
```

**规则**：
- Role Profile 存储于 State 域（Persistent State 的一部分），不是 Worker 内部记忆。
- Dispatch Policy 选择 Worker 时，先确定 Task 对应的 `role_profile_ref`，再在该角色允许的 Worker 类型/能力范围内做 Worker Selection（T12.3），Role 决定"边界"，Worker Selection 决定"谁来执行"。
- Role Profile 不参与 Verification 判断——即便 Role 标注为 "QA"，验证仍必须走独立的 Verification Engine（P0-05/P0-11），**不因为角色名字叫 QA 就采信其自我验证**。

---

## 13. Artifact Handoff Contract（v2.0 新增）

> 把 `PRODUCES_ARTIFACT` 边正式升级为带校验的产物依赖：**上游 DONE 不自动等于下游 READY**，下游必须等到产物通过 schema/digest 校验。

```yaml
edge:
  type: PRODUCES_ARTIFACT
  from: backend-api-task
  to: frontend-ui-task
  readiness:
    requires_artifact:
      type: api_contract
      schema_version: 1
  binding:
    artifact_digest:
    producer_task_revision:
```

**流程**：`Backend DONE → 产出 API Contract Artifact → Schema 校验 → Digest 绑定 → Frontend 边状态变为 READY`。中间任何一步失败，下游保持 `BLOCKED`，不允许"上游已完成就默认可以开始"的隐式假设。

---

## 14. Verification Recipe（v2.0 新增）

> 把"如何证明这类任务真的做好了"预先定义在 Playbook 里，而不是每次临时想验收方法。

```yaml
# playbooks/web-app/verification.yaml
verification_recipe:
  web_feature:
    required: [unit_test, integration_test, browser_e2e, network_trace]
    evidence: [screenshot, video, console_log, request_trace]

# playbooks/api-service/verification.yaml
verification_recipe:
  api_endpoint:
    required: [unit_test, contract_test, load_smoke]
    evidence: [test_report, openapi_diff]
```

Task Contract 的 `verification.recipe_ref` 引用对应 Recipe；Verification Engine 优先按 Recipe 定义的清单执行确定性检查（P0 已有"确定性优先"硬规则），Recipe 里没覆盖的语义类验收才走 LLM Judge/人工。

---

## 15. Trigger Gateway & Demonstration-based Routine Capture（v2.0 新增）

### 15.1 Trigger Gateway
```yaml
trigger:
  id: monitor-production
  source: {type: webhook, provider: datadog}
  condition: {severity: critical}
  create_task: {template: investigate-production-incident}
```
或
```yaml
trigger:
  schedule: "0 8 * * 1-5"
  task_template: morning-inbox-summary
```

**硬规则**：`Trigger 只能创建 Task Contract，不允许直接调用 Worker`。流程永远是 `Trigger → Create Task Contract → DoR → Controller → Worker`，不新增 Event Bus，不给 Trigger 越权通道。

### 15.2 Demonstration-based Routine Capture
> 官方 Grok Bot 的"示范一次、自动学成例行任务"思路——但套进 Personal PI 的契约体系里，而不是套进某个 Bot 的私有记忆里。

流程：
```
一次成功的 Run（含完整 Task Contract + Evidence）
        ↓
人工确认："这次的做法值得复用"
        ↓
提炼为参数化 Task Template（写入 Reference Architecture Playbook）
        ↓
下次同类需求：Master 直接引用 Template，跳过重新推理分解方式
```
**规则**：模板提炼必须经人工确认才能入库（防止把一次性凑巧成功的方案过拟合成"标准做法"）；模板本身仍然是标准 Task Contract 的参数化实例，不是新的执行机制。

---

## 16. Role Workspace Persistence Cache（v2.0 新增，P2）

> 借鉴 Grok Bot"每个 Bot 有专属云环境、保持登录态"的产品价值，但明确定位为**非权威性能缓存**。

```yaml
workspace_cache:
  role_id: backend-engineer
  session_state: {logged_in_services: [], browser_profile_ref:}
  authoritative: false            # 永远为 false
  rebuildable: true
  ttl:
```

**规则**：Workspace Cache 丢失/损坏时，任务必须能仅凭 Persistent State + Task Contract 重新执行（可能变慢，但不能变得不可能）——这是检验"是否违反 P0-12"的直接测试：**关掉 Workspace Cache，系统应该依然能跑通，只是慢一点**。

---

## 17. Coordination Budget（v2.0 新增，v3.4 补充 resource_ceiling）

> 呼应 Decomposition Budget（8.6），但限制的是"组织膨胀"而不是"任务图膨胀"——第三方经验反复印证：Persona 化协作到十几个角色以上会自己变乱。

```yaml
coordination_budget:
  max_active_workers:
  max_handoffs_per_task:
  max_concurrent_roles: 4

  resource_ceiling:              # v3.4 新增：操作系统级物理资源上限，独立于 loop_budget
    max_parallel_workers:
    max_memory_mb_per_worker:
    max_total_memory_mb:
    on_pressure: degrade_to_serial   # 检测到资源压力时的默认动作
```

> **`resource_ceiling` 与 `loop_budget` 的区别（不要混用）**：`loop_budget`（第 5/22 节）管的是**逻辑执行预算**（token/调用次数/耗时），`resource_ceiling` 管的是**宿主机物理资源**（内存/并行进程数）——两者失控的表现完全不同：前者失控是"越跑越贵、越跑越长"，后者失控是操作系统直接 OOM Killer 强杀进程（`exit 137`）。这属于此前"环境/资源类失败"分类（见 Recovery 模型）里"换更强模型没用，需要自动降级串行"的具体触发信号，此前该分类下没有对应的确定性字段，本次补上。

---

## 18. 明确不借鉴清单（v2.0 新增，与借鉴清单同等重要）

| 反模式 | 为什么不借 |
|---|---|
| Agent 间自由聊天作为控制协议 | 聊天记录是隐式状态，违反 P0-12（真相源必须是结构化 Persistent State），聊天可以做 UI 展示层，不能承载依赖/状态语义 |
| Persona Memory 作为真相源 | Role 可以有偏好/工作风格记忆，但 requirement/approval/task state/decision/artifact version 永远不能只存在于某个 Bot 的私有记忆里 |
| 因为角色叫"QA"就采信其自我验证 | 违反 P0-05/P0-11，验证者与执行者必须独立，不因命名/角色标签而放松 |
| 无限制账号级权限一次性授予 Persona | 违反最小权限原则（T10.x）；权限必须通过 `credential_scope` 按角色显式声明范围 |
| 因为看到多 Agent 产品火爆就提前上 Swarm/Event Bus | 违反"不跳阶段"纪律（P0-10）；Multi-Worker 前必须先有 Single-Agent Baseline |
| **Graph 允许自由 cycle、由框架层（如 LangGraph/AutoGen 式）自动重入（v3.0）** | **IAL-Scan 论文扫描 6,549 个真实 Agent 项目发现的 68 个 infinite-agent-loop 失败案例中，LangGraph+AutoGen 类框架占比 66.2%；根因是两个 Agent 来回调用、workflow cycle 没有真实 bound。我们的 Task Graph 必须保持 DAG（P0-03），循环只能存在于 Run/Attempt 的 execution state machine 里，不能存在于 Task 依赖图里** |
| **让模型自己判断"循环该结束了"作为唯一终止条件（v3.0）** | **同一份 IAL-Scan 数据显示 95.6% 的确认案例可能导致 API cost exhaustion；模型输出不是 strong bound，任何反馈路径必须有 Loop Budget（P0-15）这种可机器验证的确定性上限兜底** |
| **执行入口在 Worker 派发能力不可用时，于同一会话内批量调用工具、自称"模块隔离/并行检查"来模拟多 Worker 协作（v3.3）** | **真实 session 审计（见第 38 节）证实：这是"伪造执行拓扑"，与"Worker 自证完成"是同一类问题的变体——这次是"会话自证自己是多 Agent 协作"。正确行为是诚实报告"当前入口不支持 Pipeline 接入"并 Fail-Closed（P0-17），不是自行发明一套降级协作方案** |

---

## 19. 借鉴优先级路线（v2.0）

```
现有 P0 / P1-Early
        │
        ├── Role Profile              ← 小增量
        ├── Artifact Handoff Contract  ← 小增量
        ├── Verification Recipe        ← 小增量
        │
        ▼
     v1.1 Core Gate（PERSONAL_PI_V0.1_CORE_V1.1）
        │
        ▼
   真实项目 E2E
        │
        ├── Trigger Gateway            ← 验证 always-on 场景
        ├── Demonstration Routine Capture
        │
        ▼
 Single Worker Baseline（含 Role-Aware，M2.5）
        │
        ▼
 Worker Pool（含 Role Workspace Cache）
        │
        ▼
 Multi-Worker / Parallel / BATCH
```

**红线不变**：不加入 Swarm，不加入自由 Agent Mail，不加入 Event Bus，不做"多个 Bot 自己开会"。

---

## 20. Reasoning Depth 映射（v2.1 新增）

> 区分两个正交决策维度：**`worker_tier` 回答"用哪档模型/供应商"，`reasoning_depth` 回答"同一个模型该开多大的思考预算"**。两者不合并成一个字段，以后单独调其中一维不会互相牵扯。这一层现在就该定义，不需要等 Multi-Worker（Phase 12）基础设施——即便当前只有一种 Worker（PI），底层模型大概率也能配置推理强度，现在不管等于放弃一个几乎零架构成本、但直接影响成本与质量的杠杆。

**硬规则：`reasoning_depth` 必须由 Dispatch Policy 用确定性映射表算出，禁止为此新增一次 LLM 判断往返**（否则会反向制造 v1.1 已经治理过的 token 爆炸问题）。映射表直接复用 T2.2 Task Assessment 已算出的字段：

```
risk=low  AND uncertainty=low  AND workload=small     → reasoning_depth = low
risk=medium OR verification.strength=weak              → reasoning_depth = medium
risk=high OR dependency=complex OR confidence<0.6       → reasoning_depth = high
架构决策/Plan Quality Gate 自身评估（T2.5/T2.6）         → reasoning_depth = extended
```

`capability_tags`（如 `[coding, browsing, long_context, math, tool_use]`）由 Task Assessment 或规则从任务描述/scope 中提取，供 Phase 12 的 Worker Selection（T12.3）匹配 Worker Capability 使用；在 Multi-Worker 尚未实现的当下，该字段先落盘记录，不参与实际路由决策，为以后无缝接入 Worker Selection 做好数据积累。

---

## 21. Worker Plugin Manifest（v2.1 新增，契约先行、实现留插件）

> 回答"多 Agent/CLI 的发现、能力边界、调度、编排该不该现在做"：**编排调度的执行逻辑（自动发现、多 CLI 并行）留给 Phase 12/14 的插件实现，但插件的契约形状现在就定义**，避免以后接入新 CLI（Codex/Cursor Agent/Gemini CLI 等）时还要回头改核心 Task Contract Schema 或 Controller 代码。

```yaml
# plugin_manifest.yaml —— 每个 CLI/Agent 一份，Phase 12 才被 Worker Registry 真正读取
worker_plugin:
  id: codex-cli
  adapter_entry: adapters/codex.py
  models_supported:
    - {model: gpt-5-codex, reasoning_levels: [low, medium, high]}
  capability_tags: [coding, shell]
  context_limit: 200000
  cost_tier: standard
  auth: {type: api_key, env_var: CODEX_API_KEY}
  discovery: {type: static_config}      # 现在只支持静态配置声明，日后可升级为 auto_probe（自动探活）
```

**规则**：
- `capability_tags`/`cost_tier` 与 Task Contract 的同名字段（第 5 节）语义对齐，Worker Selection（T12.3）用它们做匹配。
- `discovery.type` 现阶段只需要 `static_config`（人工在配置文件里声明有哪些 Worker 可用），**不实现自动探活/自动注册**——这属于 Phase 12 才评估是否值得做的增强，不在 v2.1 范围内。
- 这份 Manifest 本身不需要立刻有代码去读取它；只需要作为**新 Worker 接入的标准格式**先冻结下来，任何人（包括未来的你自己）想接一个新 CLI，只要照着这个格式写一份文件+一个 Adapter 实现（T3.1 已定义的统一接口），不需要碰 Controller/Task/Verification 等内核代码。

---

## 22. Loop Budget & Bound Coverage Audit（v3.0 新增，P0，落地 P0-15）

> 来源：《From 296 Agents to One Graph: Graph & Loop Engineering》一文及其引用的 IAL-Scan 论文（扫描 6,549 个真实 Agent 项目，确认 68 个 infinite-agent-loop 失败案例，68/68 都缺少覆盖真实反馈路径的 strong bound）。核心教训：**我们已经分别设计了 `timeout`/`retry_policy`/`Decomposition Budget`/`Coordination Budget`，但这些是分散的局部约束，没有一个统一原则要求"每一条可能重新进入先前状态的执行路径都必须有累计上限覆盖"**——这正是 P0-15 要补的漏洞。

### 22.1 Loop Budget（Schema 见第 5 节）
`loop_budget` 覆盖的是 Task 级、跨 Run 的累计上限：`max_attempts`（含 retry/repair/reassign）、`max_model_calls`、`max_tool_calls`、`max_handoffs`、`max_elapsed_ms`、`max_input/output_tokens`、`max_cost_usd`、`max_state_growth_bytes`。任一维度耗尽 → `on_exhaustion.action = BLOCKED` + 上报人工，**不允许静默继续循环，也不允许仅凭"模型觉得快好了"延长预算**。

### 22.2 Bound Coverage Audit（Stage Gate 新增检查项）
每次 Stage Gate 验收时，除了原有的功能测试，新增一项设计审查：**枚举当前系统里所有"可能重新进入先前执行状态"的路径**（Worker↔Verifier↔Repair、Decomposer 递归、未来的 Multi-Agent 交接循环），对每一条路径逐一确认：

```
路径：Worker → Verifier FAIL → Repair → Worker → ...
覆盖预算：loop_budget.max_attempts = 3   ✅
路径：Decomposer → Task → 判定过粗 → Decomposer 重新分解
覆盖预算：Decomposition Budget.max_replan_count   ✅
路径（未来）：Worker A → Worker B → Verifier → Replan → Worker A
覆盖预算：loop_budget.max_handoffs   ⚠️ 待 Phase 12 补齐
```

**规则**：任何一条路径如果找不到对应的确定性预算字段覆盖，Stage Gate 不得判定 PASS，必须先补上覆盖字段（哪怕只是给个保守的硬上限），才允许进入下一阶段。这是纯设计纪律，不需要新增运行时组件，成本极低。

---

## 23. Work Receipt / No-op Receipt（v3.0 新增，P1-Early）

> 来源同上：文章举了一个真实案例——一个按小时运行的 triage workflow 记录了 6,290 次 successful run，却一次真正的 agent execution 都没发生。**Pipeline green ≠ Work happened**。这个问题对我们已经设计的 Trigger Gateway（第 15 节）/ Always-on 场景尤其致命，必须现在补上。

在 Result Contract（第 5 节 Task Contract 之外，Worker 返回的 Result 结构）里增加：

```yaml
work_receipt:
  work_attempted: true
  effects_count: 3
  artifacts_created: []
  state_changed: true
  no_op: false
  no_op_reason:              # 合法的"这次确实不需要做任何事"，必须显式给理由
  evidence_refs: []
```

**规则**：
- `no_op: true` 且给出合理 `no_op_reason`（如"没有新的收件箱消息"）是**合法且正确**的结果，不应被当成失败。
- 但如果 `status = PASS` 且同时 `artifacts_created` 为空、`state_changed = false`、又没有 `no_op_reason`——这是一个**异常状态**，必须被系统自动标记为可疑（`work_receipt_anomaly`），不能直接放行为正常 DONE。这条规则本质上是 P0-05（Evidence→Verification→PASS）在"任务是否真的发生过"这个更底层问题上的延伸。
- 此项对 Trigger Gateway（15.1）创建的任务**强制要求**，对普通任务建议默认开启。

---

## 24. Verifier Context Isolation（v3.0 新增，P1-Early，落地 P0-11）

> 来源同上：好的 Graph/Loop 系统里 Verifier 独立检查 Worker 的输出和证据，**不读 Worker 的私有推理/草稿**——因为如果验证者读到了 Worker"我这样做是对的，因为 X"的解释，很容易不自觉地继承 Worker 的错误假设，验证就退化成了"复核 Worker 讲的故事是否自洽"，而不是"核对 Worker 声称的结果是否符合现实"。

**Verifier 输入白名单（第 4.2 节 Verification Engine 的补充硬规则）：**

```
允许：
  Task Contract / Acceptance Criteria / Result（结构化字段）
  Artifact / Evidence（diff/日志/测试结果）
  Repository / 运行环境的实际状态
  Verification Recipe（第 14 节）

禁止：
  Worker 的私有推理过程 / scratchpad / "我为什么这么做"的自然语言解释
```

**规则**：即便 Worker Result 里附带了推理说明，Verification Engine 的输入组装逻辑必须显式过滤掉这部分，只保留结构化结果与证据。可以把这理解成：验证做的是 `Contract + Reality → Judgment`，而不是 `Contract + Worker 的故事 → Judgment`。

---

## 25. Graph Efficiency Metrics / Coordination Efficiency（v3.0 新增，P1）

> 现有的 Decomposition Budget / Coordination Budget 都是"硬上限"（ceiling），还缺一个"优化方向"（metric）。建议在既有 Trace/Metrics（第 11 节应用层 Token/Cache 指标）基础上追加：

```
graph_width / graph_depth / handoff_count / peak_active_workers
retry_depth / replan_count
useful_work_ratio                    # 由第 23 节 work_receipt 统计得出
verification_first_pass_rate
cost_per_verified_task
time_per_verified_task

coordination_efficiency = verified_tasks / (handoffs + retries + agent_calls)
```

**方向性原则**：**不是"更多 Worker/更多 Agent 更好"，而是"在满足 Verification 的前提下，选择最小 coordination graph"**。这组指标不改变任何调度逻辑，只是为将来 Phase 15 Policy Calibration 提供真实的优化目标，避免"看起来热闹的多 Agent 编排"被误当成进步。

---

## 27. Command Risk Classification（v3.1 新增，P1）

> 来源：Claude Code《12 Agentic Harness Patterns》第 10 项。你现在的权限模型是**任务级**的（Task Contract 声明 `permissions.shell.allowed` 白名单），这里补的是**命令级**的实时分类——即便某个 Task 已被批准可以使用 shell，具体执行到哪条命令时依然要再分类一次，拦住"任务权限没问题，但执行时敲出/被诱导敲出一条危险命令"的场景。

```yaml
command_risk_rules:
  - pattern: "npm test|pytest|go test"
    risk: safe
    action: auto_run
  - pattern: "git diff|git status|git log"
    risk: safe
    action: auto_run
  - pattern: "git push --force|git reset --hard"
    risk: risky
    action: ask_user
  - pattern: "rm -rf /|:(){ :|:& };:"
    risk: danger
    action: block
```

**规则**：这层分类挂在 Worker Adapter 的 Shell 执行入口，在 Task Contract 的白名单校验**之后**、真正执行**之前**再过一遍；`danger` 一律硬拒绝不可覆盖，`risky` 触发人工确认（复用 Human Approval Gate 的 action_digest 绑定机制），`safe` 才自动放行。这是 Least Privilege（T10.2）在命令粒度上的补强，不是替代。

---

## 28. Phased Permission Escalation（v3.1 新增，P1，强化最小权限原则）

> 来源：《12 Agentic Harness Patterns》第 6 项 Explore-Plan-Act Loop（`read-only → read-only → full access`）。同一个 Run 内部按执行阶段分级授权，而不是从 Run 一开始就把 Task Contract 声明的全部写权限一次性开放。

```
Run 生命周期内的权限分级：
  Explore 阶段  → 只读（读代码、读文档、读测试结果）
  Plan 阶段     → 只读（产出修改方案，但不落盘）
  Act 阶段      → 开放 Task Contract 声明的写权限
```

**规则**：Worker Runtime 在 Run 内部维护一个"当前阶段"标记，写操作请求必须先检查是否已进入 Act 阶段，未进入则拒绝（哪怕 Task Contract 本身允许写）。这样"探索/规划阶段想岔了"造成的破坏面被压缩到零——写权限被推迟到"确定要做什么"之后才开放。此机制不需要新的架构组件，只是 T3.2 PI Worker 执行逻辑的一层内部状态机。

---

## 29. Progressive Tool Expansion & Single-Purpose Tool Design（v3.1 新增，P1/P2）

> 来源：《12 Agentic Harness Patterns》第 9、11 项。两条合并成一节，因为都是 Worker Adapter 工具注册表的设计准则，不是独立模块。

**Progressive Tool Expansion**：Worker 默认只暴露一组精简的内建工具（建议上限 <20 个），只有当 Task 的 `capability_tags` 明确需要时才追加 MCP 工具，Remote/跨设备工具放在最后才考虑。这与 Worker Plugin Manifest（第 21 节）的 `discovery` 机制天然配合，也直接服务于 token/上下文经济——工具描述本身要占 Prompt 空间，工具越多，每次调用的固定开销越大。

**Single-Purpose Tool Design**：工具注册表优先暴露单一职责工具（`Read/Edit/Grep/Glob`），只有明确必要时才开放通用 `Bash` 逃生舱（`cat/sed/grep/find` 全塞一个工具里）。窄职责工具天然更容易做权限收敛（第 27 节 Command Risk Classification 对通用 Bash 的管控成本远高于对专用工具）、更容易审计（Evidence 里"调用了 Edit 工具改了哪个文件"比"跑了一条 sed 命令"更容易验证）。**规则**：新增工具时默认走单一职责设计，只有真的没有等价专用工具时才退回 Bash。

---

## 30. Deterministic Lifecycle Hooks（v3.1 新增，P1，强化"确定性优先"）

> 来源：《12 Agentic Harness Patterns》第 12 项（`Start→ToolUse→validate→test`，`CwdChg→reload`）。给 T4.2 的"确定性优先验证"提供一个更早介入的挂载点——不用等到 Run 结束、走完整 Verification 才发现问题，而是在执行过程中的关键节点就插入确定性检查。

```yaml
lifecycle_hooks:
  on_start: [load_env]
  pre_tool_use: [validate_command_risk]   # 挂第 27 节 Command Risk Classification
  post_tool_use: [run_lint_if_code_changed]
  on_cwd_change: [reload_project_rules]
```

**规则**：Hook 触发的检查必须是确定性的（脚本/静态检查），不允许在 Hook 里插入 LLM 判断（否则又会制造新的 token 消耗点，也违反第 22 节 Loop Budget 的"确定性优先"精神）。Hook 失败时的默认行为是阻断当前工具调用并把错误回传给 Worker，而不是让 Worker 带着错误继续往下走到最终 Verification 才暴露。

---

## 31. Scoped Context Assembly（v3.1 新增，P1，Context Manifest 解析机制具体化）

> 来源：《12 Agentic Harness Patterns》第 2 项（`org > dir` 层级作用域）。给 T6.2 Context Manifest 的 `required/optional/excluded` 提供一个具体的解析算法，而不是平铺列表。

```
作用域层级（更具体覆盖更宽泛）：
  org-level rules（项目全局规则，如"禁止提交密钥"）
    └── project-level rules（如"这个项目用 pytest 不用 unittest"）
        └── directory-level rules（如"src/legacy/ 下不做重构，只修 bug"）
```

**规则**：Context Resolver（T6.3）解析 `required` 引用时，按层级从粗到细依次加载规则，更具体层级的规则覆盖更宽泛层级的同名规则；`excluded` 同理，可以在目录级排除某个组织级默认包含的内容。这个机制本身很轻量，主要是把"规则去哪找、谁覆盖谁"这件事显式化，避免每次都要 Master 重新判断。

---

## 32. Background Memory Consolidation / Dream Consolidation（v3.1 新增，P2）

> 来源：《12 Agentic Harness Patterns》第 4 项。这是本次调研里**唯一一个不是老模块实现细节、而是概念上真正新增的机制**：后台空闲时主动把累积的历史 Evidence/Decision Record 蒸馏成更紧凑的长期摘要，与 Context Compaction Policy（T6.5，被动地在汇报时压缩）性质不同——一个是"按需现场压缩"，一个是"闲时主动整理"。

```yaml
consolidation_job:
  trigger: {schedule: "0 3 * * *"}          # 复用 Trigger Gateway（第 15 节），无需新基础设施
  scope: {lookback_days: 7}
  actions:
    - summarize_completed_tasks
    - compact_decision_records
    - archive_raw_evidence_to_cold_storage   # 原始证据不删除，只是从热路径移到冷存储
work_receipt:                                # 复用第 23 节，Consolidation Job 本身也是一个 Task
  no_op_reason: "过去 7 天无新增可整理的历史记录"
```

**规则**：Consolidation Job 用你已有的 Trigger Gateway 调度，产出物是"结论级摘要"，原始 Evidence 不删除（审计/回溯需要），只是从热路径移到冷存储；Job 本身也要走完整的 Task Contract + Work Receipt 流程，不是特权后台任务。

---

## 33. 关于跨 Worker 消息通信的澄清（v3.1，强化第 18 节不借鉴清单）

> 来源：《12 Agentic Harness Patterns》Multi-Agent Layer 展示的 `Teammate Mailboxes（Redis pub/sub）+ FSM Protocol（IDLE→REQUEST→WAIT→RESPOND）`。这不是要新增模块，而是把第 18 节"不借鉴 Agent 间自由聊天"这条原则说得更精确——**不是不能有 Agent 间消息，而是消息不能承载状态语义**。

```
可以接受（Phase 12+ 若需要）：
  消息 = 有限状态、结构化、只做"叫醒/通知"
  例：{type: HANDOFF_READY, task_id: T-123, from: backend, to: frontend}
  → 收到消息只是触发 Controller 重新检查该 Task 的 Ready 判定（走既有 Artifact Handoff Contract，第 13 节）
  → 消息本身不是任务状态的来源，Persistent State 才是

不可接受：
  Agent 之间开放式自然语言对话
  任务状态/决策依据只存在于聊天记录里
```

这条不新增任务，作为 Phase 12 设计时的一条澄清写入即可。

---

## 35. Worker 三层能力成熟度模型（v3.2 新增，Phase 12/13/14 边界权威定义）

> 来源：Codex Type B Worker（异构 CLI）在实施过程中因 `observed_runtime_model` 无法可靠取得而卡住 Phase 12 推进，引发的正式变更评审。核心问题：**Multi-Worker（Phase 12）此前被隐性理解为"必须接入 ≥2 种异构 CLI"，导致一个 Phase 14 才该处理的外部能力缺口（Codex telemetry 限制）反过来阻塞了 Phase 12。本节正式厘清三个层级，消除"Multi-Worker 是否要求异构"的反复歧义。**

```
Level A — In-process Multi-Worker（不建议单独作为 MVP 证据）
  Controller Process
   ├─ Worker Object A
   ├─ Worker Object B
   └─ Worker Object C
  可验证：DAG scheduling / Lease / Worker Selection / Budget / Artifact Handoff / failure state machine
  局限：隔离强度不足，不能证明真实进程/会话隔离

Level B — Multi-process Isolated Worker（Phase 12 的正式最低标准）
                 Controller
            ┌────────┼────────┐
            ↓        ↓        ↓
        Adapter#1 Adapter#2 Adapter#3   ← 可以是同一 CLI binary 的多个独立进程/Session
            │        │        │
         Run A    Run B    Run C
            │        │        │
      worktree A worktree B worktree C
  证明：真实模型执行、进程隔离、Session 隔离、Context 隔离、Workspace 隔离、
        并发执行、Crash 隔离、独立 Lease、独立 Result

Level C — Heterogeneous Multi-CRI（Phase 14 的正式标准）
  Controller
   ├─ PI / DeepSeek
   ├─ Codex / GPT
   ├─ Claude CLI
   └─ Remote Worker
  证明：新增 CRI 只增加 Adapter，不修改 Controller/DAG/Verification/Persistent State（T14.1）
```

**权威定义（正式取代此前"至少 2 种 Worker 类型"的模糊表述）：**

> **P0-16（建议新增，落地"Multi-Worker ≠ Multi-CLI"）：Phase 12 Multi-Worker MVP 的验证单元是 Worker Instance（拥有独立 `worker_instance_id/process/session/lease_epoch/workspace/context projection/loop usage`），不是 Worker CLI/Provider 种类。跨 CLI/Provider 的协议适配属于 Phase 14 Multi-CRI 的独立验证范畴，不得作为 Phase 12 Stage Gate 的前置条件。**

这条不新增大模块、不改变五域边界，只是把 P0-09（"Multi-Agent/Parallel/Multi-CRI 是可替换的执行策略，不属于内核"）在 Phase 边界层面进一步精确化，避免同一份原则在不同 Phase 被不同松紧的实施理解。

---

## 36. Phase 13 作为 P0 Multi-Worker MVP 正式达成节点（v3.2 新增）

> 明确 Phase 12 PASS 只是"Worker Pool 正确"，Phase 13 PASS 才是"复杂任务可以被多个真实隔离 Worker 并行协作完成"这个最终能力目标的正式达成节点。

**Phase 13 PASS 的最终判定表（取代此前分散、抽象的描述）：**

| 能力 | MVP 是否必须 |
|---|---|
| 单 Worker 真实 E2E | 必须（Phase 7 已达成） |
| Task DAG / Dynamic Decomposition | 必须（Phase 8 已达成） |
| Worker Registry / ≥2 个真实 Worker Instance | 必须（Phase 12） |
| 独立 process/session（Level B） | 必须（Phase 12） |
| Parallel execution + **execution overlap 时间戳证据** | 必须（Phase 13，见下方三组场景） |
| Worktree Isolation / Artifact Handoff / Integration Worker | 必须（Phase 13） |
| 合并后 Final Re-verification（不复用分支级 PASS，见第 8.3 节） | 必须（Phase 13） |
| Crash/Timeout Recovery + Stale Lease 拒绝（第 8.1 节 Fencing） | 必须（Phase 13） |
| Loop Budget / Coordination Budget 生效 | 必须（已在 Phase 1/8 落地，Phase 13 验证其在并行场景下依然有效） |
| Single-Agent Baseline 对照 | 必须（T11.5，Multi-Worker 上线前置条件） |
| **跨 CLI/Provider（异构 Worker）** | **不要求**——这是本次变更评审的核心结论 |

**必须补齐的三组真实验收场景（不能只有 happy-path demo）：**

1. **Parallel Read/Analysis**：三个 Worker 分别分析架构/代码/测试，第四个 Task 消费三份 Artifact 做 synthesis——验证 DAG fan-out/fan-in 的基本正确性。
2. **Parallel Coding**（最重要）：Worker A 改模块 A、Worker B 改模块 B、Worker C 补测试，各自在独立 Worktree 工作；Integration Worker 合并后**必须对最终状态重新跑 Verification**，不能复用任一分支的分支级 PASS（见第 8.3 节 TOCTOU 防护原则的直接应用）。
3. **Failure Recovery**：故意让 Worker B 超时/崩溃，验证 A/C 不受影响、B 的 Lease 被正确回收、任务被 reassign；若旧 B 之后才迟到返回结果，其携带的过期 `lease_epoch` 必须被拒绝（见第 8.1 节 Fencing Token）；最终整个 DAG 仍能完成。这一组场景是证明"这不是 happy-path demo"的关键证据，比前两组更重要。

**证据要求**：Parallel Coding 场景必须有 timestamp/trace 证明 A/B/C 存在真实的 execution overlap（并发窗口有重叠），不能三个 Worker 实际串行执行却被记录成"Parallel"。

---

## 37. Known External Gap Registry（v3.2 新增，通用外部依赖缺口登记机制）

> 来源：GAP-01（Codex CLI 无法可靠返回 `observed_runtime_model`，导致 runtime identity attestation 无法完成）。这不是 Personal PI Worker Adapter 的控制逻辑缺陷，而是外部 CLI 的 telemetry 能力限制——**正确的处理方式是登记、延期、不阻塞主线，而不是放松 Verification 证据标准去凑一个假通过，也不是让它无限期卡住不相关的 Phase**。这个登记格式具有通用性，正式吸收为标准机制，不只用于 Codex。

```yaml
external_gap:
  id: GAP-01
  symptoms: "Codex CLI 可实际启动执行,但无法可靠返回同一 Run 的 model/provider identity"
  evidence: "probe 结果 observed_runtime_model=unknown"
  root_cause: "Codex CLI execution surface/telemetry 能力限制,非 Worker Adapter 核心逻辑错误"
  decision: "不伪造 identity,不用配置值冒充 observed runtime identity"
  resolution: "延期到 Phase 14 Multi-CRI"
  current_consequence: "Codex 可继续作为实验性 Adapter,但不能作为'已完全验证异构 backend'的证据"
  mvp_impact: NON_BLOCKING   # 或 BLOCKING——由登记时明确判定,不允许含糊
```

**规则**：
- 任何第三方 CLI/Provider 的能力限制（telemetry 缺失、配额耗尽、协议不完整等）发现后必须先登记一条 Gap 记录，明确 `mvp_impact` 是否为 `BLOCKING`，而不是在讨论中反复重新判断"这算不算卡住我们"。
- `NON_BLOCKING` 的 Gap 不得以任何理由阻塞与其无关的 Phase（本次 Codex 案例的核心教训）。
- Gap Registry 与 T2.0-A（Preclassifier 假阴性追踪）、T15.3（Plan Regression Dataset）同属"结构化记录不确定性而非无限期卡住主线"的同一类机制，但登记对象是**外部依赖**而非**内部判断失误**，两者不合并。
- Verification 标准不得为配合某个 Gap 而降低——GAP-01 的正确处理是"延期"而不是"放宽 Codex 的验证要求让它勉强算通过"。

---

## 38. Task Compiler / Ingress Gate（v3.3 新增，重大缺口修复，落地 P0-17）

> **事故来源**：一份真实 7 小时 14 分钟的 `pph` 交互式 coding-agent session 审计（474 条 assistant 消息、878 次工具调用）证实：Pipeline 的全部核心组件（`MasterControlPlane`/`pipeline.ts`/`loop-budget.ts`/`persistence.ts`）在代码里都已实现，但用户实际使用的交互式入口（`session-manager.ts`）从未调用这些组件——`beforeRun`/`beforeToolCall` 全程未触发，没有 TaskContract、没有 Run 记录、没有 PersistentState 落盘。最终以 Provider `context-limit` 报错强制中止，而不是受控的 `BLOCKED`/`DONE`。**这不是某条 P0 原则被违反，而是这些原则对这条执行路径从未生效过**——架构设计的完备程度和系统实际可靠程度之间存在过一次真实的系统性落差。

### 38.1 根因定位：并列问题实为因果关系

审计报告最初把"没有 Worker 能力时采用了错误的降级策略"和"没有 Fail-Closed 硬门"列为并列根因，v3.3 修正为因果关系：**正是因为不存在 Fail-Closed 硬门，模型才有机会自行发明"同一会话内批量工具调用模拟并行"这种降级方案**。若 Fail-Closed 硬门存在，请求在最开始就会被拒绝或转为受限任务，模型根本不会走到"需要自创降级策略"这一步。因此补丁必须打在**入口的"门"上**，而不是打在"规范模型的降级决策逻辑"上——后者治标，且每次只能堵住这一次被发现的具体降级话术，前者治本。

### 38.2 Task Compiler / Ingress Gate

```
用户请求
   ↓
┌─────────────────────┐
│   TASK COMPILER       │  ← 新增，强制关卡，位于 Control 域下，不可绕过
│   (Ingress Gate)       │
└──────────┬────────────┘
           │
   ┌───────┴────────┐
   │  Pipeline 是否   │
   │  已正确接入？     │
   └───┬────────┬────┘
      是│        │否
       ↓         ↓
  正常走既有     FAIL-CLOSED：
  Task/Dispatch/  拒绝执行，或降级为
  Verification    单一受限任务（硬编码
  流程            max_tool_calls/max_elapsed_ms，
                  不依赖 Pipeline 组件本身）
```

**关键设计点（不可妥协）**：Fail-Closed 分支里的硬限制必须是**独立于 Pipeline 组件之外的兜底红线**（如写死在 `session-manager.ts` 里的 `max_tool_calls`/`max_elapsed_ms`），不能依赖"Loop Budget 组件本身"去限制——因为这次事故恰恰证明了 Loop Budget 组件可能压根没被这条路径调用。**兜底红线必须比它要保护的机制更底层、更难被绕过**，否则就是用同一个可能失效的东西去防止自己失效。

### 38.3 Ingress Binding Verification（新的一类测试，不同于既有的组件正确性测试）

此前所有验证（Phase 1-13 的各类测试）都是"给定一个 Task Contract，验证 Pipeline 内部行为正确"——这是**组件正确性测试**。这次缺失的是**入口接入正确性测试**：

```
测试方法：不 mock 任何组件，从真实用户入口（如 pph CLI）发起一个请求，
断言：TaskContract 被创建 且 Dispatch 被调用 且
      LoopBudget.beforeRun 被触发 且 PersistentState 有对应写入
```

这类测试的地位应该**在 T7.1 End-to-End 集成测试之前**——T7.1 验证的是"Pipeline 内部链路正确"，Ingress Binding Verification 验证的是"用户真实敲命令这个动作，是否真的走到了 Pipeline"，后者是前者成立的前提，此前从未被单独验证过。

### 38.4 与既有原则的关系

P0-17 不是对 P0-02（禁止裸提示词直接派工）的重复——**P0-02 假设 Pipeline 已经在正常工作，管的是"单次派工必须走 Task Contract"；P0-17 管的是更底层的前提："整条执行入口本身有没有资格派工"**。一个系统可以完美满足 P0-02（每次派工都走 Task Contract），但如果压根没有任何机制强制"用户请求必须先到达派工这一步"，P0-02 对绕开它的入口毫无约束力——这正是这次事故发生的方式。

---

## 39. Context Builder & Tool Gateway（v3.3 新增，落地 P0-18，直接修复 Provider context-limit 事故）

> **问题来源**：即使任务已拆到叶子节点、单个子节点内部，上下文逼近临界值同样会造成模型注意力稀释、计算成本暴涨、中间遗忘、错误范例被当成事实污染后续判断。尤其是终端工具调用产生的海量输出——一次失败的几百行异常堆栈、一次全局搜索的几百个文件路径——终端会话机制不会自动清理，这些"工程废料"像水泥块一样冻结在上下文里，此后每一轮都要重新读一遍。这正是 Provider `context-limit` 报错的直接成因。
>
> **核心判断：这必须从架构上解决，不能只靠提示词自觉。** 五条外围防线（杜绝全量 Dump、截断控制台输出、忽略规则、规则下沉指令文件、Git 微步提交）方向都对，但都是**外围防线**，且都假设"模型/使用者会自觉遵守"——真正的核心命题是：**把"完整会话/审计日志"与"模型每轮实际看到的 Prompt View"彻底分离。** 完整记录可以无限增长，但 Prompt View 必须始终有界，这就是 P0-18。

### 39.1 总体数据流

```
用户请求
  ↓
Task Compiler（第 38 节）
  ↓
TaskContract + 当前状态
  ↓
┌─────────────────────┐
│   CONTEXT BUILDER     │  ← 新增，State 域下的核心组件
│  ├─ 精确文件切片        │     （取代"整段读取"）
│  ├─ 符号/依赖信息        │
│  ├─ 最近一次状态变化      │
│  ├─ 关键决策与未解决风险  │
│  └─ 工具输出摘要（不含原文）│
└──────────┬────────────┘
           ↓
       Worker / Model
           ↓
┌─────────────────────┐
│    TOOL GATEWAY        │  ← 新增，Execution 域下的强制边界
│  ├─ 执行命令             │
│  ├─ 原始日志写入 Artifact Store（完整保留）│
│  ├─ 过滤/解析/去重/指纹化 │
│  └─ 只向上返回有限摘要    │
└──────────┬────────────┘
           ↓
   Persistent State + Evidence
```

模型每一轮实际接收的，只应包含：当前 Task 的目标/范围/验收标准、当前 Git SHA、已完成/未完成步骤、相关文件的精确切片、最近一次状态变化、错误摘要与错误指纹、原始日志的 Artifact 引用（而非原文）、下一步允许执行的动作。**完整日志始终被保存，但不自动进入上下文**——这与 P0-06/P0-07（引用式 Context Projection、内容可寻址缓存）是同一条设计哲学的延伸，本节把它具体落到"工具输出"这个此前未被专门治理的入口上。

### 39.2 Tool Gateway：结构化工具结果信封（取代原样透传 stdout/stderr）

```yaml
tool_result:
  exit_code:
  status:
  duration:
  stdout_summary:
  stderr_summary:
  error_fingerprint:        # 同一异常的指纹，用于去重抑制（见 39.5）
  relevant_stack_frames:     # 折叠重复的依赖库帧，只保留用户代码帧
  artifact_id:               # 原始完整输出的引用，不在结果里内联
  truncated: true|false
  next_cursor:                # 分页句柄，用于按需拉取更多
```

**按输出类型的默认策略**：
- 编译失败 → 首个根异常 + 相关源码位置 + 最后 20-50 行
- 测试失败 → 失败用例 + 断言差异 + 汇总（不返回全部成功用例）
- 堆栈 → 保留异常链和用户代码帧，折叠重复的依赖库帧
- 全局搜索 → 匹配总数 + 分组目录 + 前若干条结果 + 分页句柄
- 大文件 → 默认只允许符号/函数/行号区间/上下文窗口读取，禁止整段 Dump
- 重复失败 → 只返回"与错误指纹 X 相同，本次新增差异为……"，不重复注入整段日志

原始输出**必须**完整写入 Artifact Store（内容哈希、大小、时间、敏感信息状态标识），模型只有在明确需要时才能通过 `artifact_id` 请求局部内容——这与既有的 Context Store（第 7 节）是同一套基础设施，Tool Gateway 是它在"工具输出"这个特定入口上的强制接入点。**Command Risk Classification（第 27 节）管的是"这条命令能不能执行"，Tool Gateway 管的是"执行完的输出能不能原样进入上下文"，两者是不同维度，不合并。**

### 39.3 强制范围控制：Allowlist 优先于 Denylist

`.gitignore` 只是 Git 规则，不能假设所有工具都遵守；仅靠 denylist（排除 `node_modules`/`dist`/日志目录）也不够安全。**最安全的默认值不是"全工程可搜、再排除几个目录"，而是"只允许当前 Task 声明过的目录和依赖范围"**——这是对 T6.2-A Scoped Context Assembly 与 Permission Contract（`filesystem.read`）的强化：搜索/读取工具的默认作用域应等于 Task Contract 的 `scope.files`，而不是整个工作区；搜索结果必须有数量上限、总字节上限和分页句柄；结果过多时自动要求缩小范围，而不是直接倾倒全部结果。

### 39.4 分层上下文预算与水位线（升级 Loop Budget 的执行时机）

此前 `loop_budget`（第 22 节）的语义是"超限→`BLOCKED`"，这是**事后拦截**。本节升级为**分层预算 + 水位线主动响应**，从根本上防止本次事故那种"硬撞墙后失控中止"：

**四层预算**（而不只是模型的最大上下文窗口）：
1. 单次工具输出预算
2. 单轮 Prompt 预算
3. 单个 Run 预算
4. Task 生命周期累计预算（即 `loop_budget`）

**每层预算统计的维度**不只是 token：tool call 次数、原始日志字节数、注入上下文字节数、重复内容比例、状态增长量、输入/输出 token、elapsed time、重试次数。

**四级水位线响应**（取代"未超限正常跑 / 超限直接 BLOCKED"的二元判断）：
```
低水位     → 正常执行
警戒水位   → 压缩工具输出，禁止新增无关上下文（挂在 T4.2-B pre_tool_use Hook）
重建水位   → 不在原会话里"总结一下"继续跑，而是立即落盘结构化状态（见 39.5），
             结束当前 Run，创建新的 Fresh Context 继续（见 39.6）
硬上限     → 阻断调用，标记 BLOCKED（Loop Budget 原有语义保留作最后防线）
```

**这是本次事故最直接的修复点**：如果 Context Builder 在"重建水位"就主动切换到新 Run，Provider 的硬性 `context-limit` 报错根本不会被触发——问题在够早的时候就被结构化地化解了，而不是留给 Provider 在最后一刻硬拒绝。

### 39.5 结构化状态压缩（取代"总结整段聊天"）

简单让模型总结全部历史，仍可能遗漏关键约束、把错误范例总结成事实、把旧计划和新状态混在一起、把不确定结论写成确定事实。T6.5 Context Compaction Policy 与 T7.5 Background Memory Consolidation 的产出物**必须**采用以下结构化 Schema，而不是自由文本摘要：

```yaml
compacted_state:
  facts: []
  decisions: []
  completed_tasks: []
  open_tasks: []
  open_risks: []
  verified_evidence: []      # 引用，不内联原文
  failed_attempts: []          # 含 error_fingerprint，不含完整堆栈
  next_action:
  git_sha:
  artifact_refs: []
```

**规则**：每个字段都必须能回指到源码、测试结果、Git SHA 或 Artifact，压缩的是"状态"，不是"对聊天记录的印象"。这是对 T6.5/T7.5 的具体化，不新增任务归属，是这两个既有任务的验收标准补充。

### 39.6 Fresh Context：Master 只读 Receipt,不读 Worker 完整 Transcript

对多步骤长流程,正确形态是：

```
一个叶子 Task = 一个或少量受预算限制的 Run
一个 Run 结束 = 生成结构化 Work Receipt（第 23 节，已有机制）
下一个 Task = 全新上下文,只读取 Receipt 和必要 Evidence 引用
```

Master 不需要、也不允许读取每个 Worker 的完整 transcript,只接收：Task ID、状态、Git SHA、验收结果、证据引用、未解决风险、下一步建议。子节点即使执行失败,也只留下有限的错误摘要和 Artifact 引用,不把几百行异常永久粘在后续每一轮 Prompt 里。**这是 P0-06（禁止全量复制上下文）在"Master-Worker 交接"这个具体场景下的强制应用,也是 Work Receipt（第 23 节）机制此前未明确的一条边界：Receipt 是 Master 能看到的唯一 Worker 产出摘要,完整 transcript 只存在于 Artifact Store。**

### 39.7 Git Micro-commit 与 Task 边界绑定

高频提交值得保留,但必须与 Task 边界绑定,不能是随意时点的习惯性动作：

```
叶子 Task 完成 → 测试和验收通过（Acceptance Gate,第 4.3 节）
   → 生成 Work Receipt → 提交 Git → 状态写入 Persistent State → 结束 Run
```

Git commit 只记录代码快照,不能单独表达"哪个 Task 已完成/哪次失败已被接受/是否满足 Stage Gate"。真正的恢复组合永远是 **Git SHA + Work Receipt + Persistent State + Artifact refs 四者一起**,不能只依赖 Git commit 或对话记录里的 `/new`、`checkout` 之类操作独立表达进度。

### 39.8 补充监测机制

- **错误指纹去重抑制**（见 39.2）：相同异常不重复注入全文,只传递 fingerprint 和新增差异。
- **Context Contamination Detection**：监测当前 Prompt View 中,错误日志/过期计划/无关目录路径占比,纳入第 25 节 Graph Efficiency Metrics 的扩展指标。
- **Prompt View Audit**：每轮记录模型实际看到的内容大小、来源、截断原因,作为 Trace（第 11 节应用层）的扩展字段,不是新的独立机制。

---

## 40. Project Registry & Delivery Host 编排层（v3.4 新增）

> **来源**：一次真实的 ai-proxy（Go 项目）交付场景暴露出——PPH 目前只被验证过一个项目，"注册项目、绑定架构文档、管理写入范围、选 Worker、建 worktree、跑验证、收证据"这一整条编排链路完全由宿主代码临时拼凑，没有一个正式组件负责它。
>
> **命名澄清（重要）**：这不是一个与 Task Compiler（第 38 节）并列的新入口。**Task Compiler 负责"入口安全检查"（Pipeline 有没有接上，接不上就 Fail-Closed）；本节是 Task Compiler 通过之后，紧接着的项目级编排层，是同一条链路的下一段**。真正新增的组件是 **Project Registry**——此前不存在，是让"同一套 PPH 服务 N 个项目"成立的必要条件。

```
用户请求
  ↓
Task Compiler / Ingress Gate（第 38 节，入口安全检查）
  ↓
┌─────────────────────────┐
│      PROJECT REGISTRY     │  ← 新增组件，Control 域
│  project_id → {           │
│    repo_path,             │
│    baseline_commit,       │
│    architecture_doc_ref,  │
│    task_ledger_ref }      │
└──────────┬───────────────┘
           ↓
   Delivery Host 编排（Task Compiler 的下一段，非新入口）
   ├─ 读取该项目的 Task Ledger（第 41 节）
   ├─ 管理文件写入范围（= Task Contract scope，见第 5 节）
   ├─ 选择 Worker（T12.3 既有逻辑）
   ├─ 创建临时 Worktree（T13.2 既有逻辑）
   ├─ 运行验证命令（T4.2 既有逻辑）
   ├─ 收集 Evidence（标准化证据包，见第 42 节）
   ├─ 触发独立 Verification（T4.2 既有逻辑）
   └─ 进入 Acceptance（第 44 节，含 Commit 分离）
```

**目标结构**（对应既有组件，不新增域）：
```
PPH
├── Project Registry          ← 新增（本节）
├── Task Ledger                ← 新增（第 41 节）
├── Task Compiler / Delivery Host 编排（第 38 节 + 本节，同一条链路）
├── Worker Adapter              ← 既有（T3.1/T12.x）
├── Verification Recipe         ← 既有（第 14 节）
└── Acceptance Gate             ← 既有（T4.3），本版新增 Commit 分离（第 44 节）
```

**规则**：Project Registry 只存储"项目身份与坐标"（路径、基线 Commit、架构文档引用、Task Ledger 引用），不存储项目的业务逻辑或领域知识——这与第 46 节"PPH 不应该吸收的能力清单"是同一条边界的两面。

---

## 41. 机器可读任务账本 Task Ledger（v3.4 新增）

> **来源**：外部项目自己的任务编号（如 ai-proxy 的 T1.01-T4.08）此前只是 Markdown 标题，从未正式映射进 Task Contract——"任务是否完成"退化成"靠 Agent 最后一段话判断"，这正是 P0-05（Evidence→Verification→PASS）想防止的场景，在多项目场景下换了一种方式重新出现。

```yaml
task_ledger_entry:
  project_task_id: "T1.01"          # 外部项目自己的编号，人类可读
  pph_task_id: "task-uuid-xxxx"      # 内部 Task Contract 的正式 ID
  task_revision: 1
  phase: "P0"
  owner: "backend-engineer"          # 对应 Role Profile（第 12 节）
  scope: ["src/proxy/*.go"]
  status: "READY"                    # 复用 T1.2 状态机
  verification_recipe: "api-service" # 对应第 14 节
  evidence_refs: []
  gate_status: "PENDING"
  unknowns: []                        # 显式列出尚未澄清的假设，不允许留空
```

**规则**：`project_task_id` 与 `pph_task_id` 一一映射且双向可查；外部项目的任务清单（Markdown/其他格式）只是 Task Ledger 的**展示投影**，`status`/`gate_status` 的唯一真相源是 Task Ledger（本质是 Persistent State 的一个视图，不违反 P0-12），不允许任何格式的任务清单文档自己维护一份独立的"完成"状态。

---

## 42. 标准化证据包（v3.4 新增，落地既有 T4.1/T4.5，具体化到可对外交付）

> 把 Evidence System（第 4.1 节）和 Verification Recipe（第 14 节）的字段要求，具体化到"可以直接作为对外项目交付物"的标准清单，不是新机制：

```yaml
delivery_evidence_package:
  baseline_commit:
  actual_diff:
  task_revision:
  workspace_snapshot_ref:
  commands_and_exit_codes: []
  test_output_summary:
  artifact_digest:
  browser_or_container_verification: []   # 对应第 14 节 web_feature Recipe
  unfinished_items: []
  provider_mode: mock|local|real           # 明确标注这次验证用的是模拟/本地/真实 Provider
```

**规则**：`provider_mode` 字段是本次新增的关键防线——**用 mock/local Provider 跑通的验证结果，不能被静默当成 real Provider 的等价证据**；证据包必须显式标注,交付评审时一眼可辨，避免"用便宜的模拟环境测过"被误当成"生产环境已验证"。

---

## 43. 只读操作纪律（v3.4 新增，P0-12 的推论，不新增 P0 编号）

> **来源**：审计发现"某些恢复脚本在查看过程中顺手写入了恢复状态"——一个理应只读的检查命令，实际上产生了状态副作用。

> **推论（挂在 P0-12 之下，不单独编号）：任何标注为"只读检查/inspect/status"类操作，禁止产生任何 Persistent State 写入副作用。若某次检查确实需要修复状态（如检测到不一致并自动纠正），必须作为独立的、显式命名的写操作（如 `pph task repair`），不能隐藏在只读命令的执行路径里。**

这条纪律看似很小，但价值很大：**如果连"只读"这个词本身都不可信，Persistent State 作为真相源（P0-12）的可信度会被逐渐侵蚀**——运维人员会开始怀疑"我刚才是不是看了一眼就把状态改了"，这种不信任感一旦出现很难消除。

---

## 44. Acceptance 与 Git 副作用分离（v3.4 新增，Acceptance Gate 的扩展规则，不新增 P0）

> 本质是已有 Approval Gate（`action_digest+revision+expires_at`，第 8.4 节）原则在"Git 副作用"这个具体场景的应用，不是新原则。

```
任务通过 Acceptance
      ≠
   允许 Commit
      ≠
   允许 Push
      ≠
   允许 Publish/Release
```

**规则**：
- Commit 是用户授权后的独立副作用，与 Acceptance 判定解耦——Acceptance PASS 只代表"这次改动被验证正确"，不代表"现在就应该落进版本历史"。
- Commit 操作只提交明确列出的文件，**禁止使用 `git add .` 或 `git add -A`**——这类命令归入第 27 节 Command Risk Classification 的 `risky` 档（触发人工确认），因为它们会把 Task Contract `scope.files` 之外的意外改动一并提交，破坏"每次 Commit 对应哪个 Task"的可追溯性。
- Commit 记录本身必须关联对应的 Acceptance 证据（第 42 节证据包），保留可追溯性。

---

## 45. Worker 能力降级状态与三层模型身份 Schema（v3.4 新增，正式化既有实践）

> **来源**：GAP-01（Codex Runtime Identity Attestation，第 37 节）此前只是一次性探测，这次要求把它变成任何 Worker 派发前都必须显式声明的标准字段，而不是遇到问题才临时排查。

```yaml
worker_status:
  worker_capability: available|unavailable
  execution_mode: normal|root_only|degraded
  delivery_status: normal|degraded

model_identity:
  requested_model:            # 请求时声明要用的模型
  platform_accepted_model:     # Provider 平台实际接受/路由到的模型
  observed_runtime_model:      # 该次 Run 真实回显确认的模型，无法确认则必须是字面值 unknown
```

**硬规则**：
- 当 `worker_capability=unavailable` 时，系统必须显式记录 `execution_mode=root_only, delivery_status=degraded`——**不允许用"在同一工作区并行跑几个 Shell 命令"冒充 Multi-Worker 流程已完成**，这是第 18 节"伪造执行拓扑"反模式的具体落地场景之一。
- 三层模型身份中，只要同一次 Run 没有真实运行时回显，`observed_runtime_model` 必须保留字面值 `unknown`，不允许用 `requested_model` 或配置值填充——这是 GAP-01 处理原则（"不伪造 identity"）的正式 Schema 化，此前只停留在文字描述,现在成为强制字段。

---

## 46. PPH 能力边界：不应该吸收的能力清单（v3.4 新增，独立于第 18 节不借鉴清单）

> 与第 18 节"不借鉴清单"性质不同——那份是"不学别的系统的坏设计"，这份是"不要把调用方/宿主项目的业务逻辑长进 PPH 内核"，两者不合并。

| 不应进入 PPH 核心 | 原因 |
|---|---|
| 具体 Provider 的业务集成（如 ChatGPT/Claude/Grok/Gemini 的专有 API 细节） | PPH 只通过 Worker Plugin Manifest（第 21 节）统一接入，不承载任何单一 Provider 的业务逻辑 |
| OAuth 业务流程 / API Key 轮询 | 属于宿主项目（如 ai-proxy）自身的凭证管理，PPH 只消费 Task Contract 声明的 `credential_scope`（第 12 节） |
| SSE 转换 / Token 用量页面 / Dashboard | 属于宿主项目的产品功能，与"任务/证据/验证/状态管理"这个 PPH 的核心职责无关 |
| 任何宿主项目专属的 Provider 配置 UI | 同上 |

**判定标准**：**PPH 只提供通用的 Worker、任务、证据、验证和状态管理能力**——任何新增能力先问一句"如果换成一个完全不同的宿主项目（前端项目/另一个 Go 项目），这个能力还有意义吗？"，答案是否定的，就不该进 PPH 核心，应该留在宿主项目自己的代码里。

---

## 47. 版本日志

> 本节是唯一的版本追踪记录。**日志表格里的"版本标签"只是变更序号索引，不代表文件本身有多个版本文件**——本文档永远叫 `latest`。规划下一次变更时，只需要读这张表就能知道"现状是什么、已经改过什么"，不需要对比历史文稿。
> 表格上方的历史记录（v1.0-v3.4）建立于本日志结构生效之前，没有留存真实自然时间戳，如实标注"历史记录"；从本次（v3.5）开始的每一行都记录真实日期。

| 版本标签 | 日期 | 变更人 | 变更类型 | 影响范围 | 变更摘要 |
|---|---|---|---|---|---|
| v1.0 | 历史记录 | 用户+Claude | 初始冻结 | 全文 | 五域内核冻结（Control/Task/Execution/Quality/State） |
| v1.1 | 历史记录 | 用户+Claude | 新增原则+新增模块 | Control/Task/Quality | P0-11；Plan Quality Gate；Fast/Slow；DoR；原子 Graph Mutation；Verification Strength；Worker Pool Lifecycle；成本/Token 治理 |
| v1.1-audit | 历史记录 | 用户+Claude | 新增原则+可靠性不变量 | Task/Execution/Quality/State | P0-12；revision/fencing/idempotency/approval binding/verification revision binding/restore drill/decomposition budget/eval isolation/single-agent baseline |
| v1.1.1 | 历史记录 | 用户+Claude | 收尾补丁 | Execution/Quality/Control | P0-13；BatchResult 信封；Preclassifier 假阴性独立追踪 |
| v2.0 | 历史记录 | 用户+Claude | 新增原则+新增模块 | Control/Task/State/生态借鉴 | P0-14；Role Profile；Artifact Handoff Contract；Verification Recipe；Trigger Gateway；Demonstration-based Routine Capture；Role Workspace Persistence Cache；Coordination Budget；明确不借鉴清单（吸收 Grok Bot / Always-on Agent Team 产品经验） |
| v2.1 | 历史记录 | 用户+Claude | Schema 扩展 | Task Contract/Execution Scaling | 新增 `reasoning_depth`/`capability_tags` 字段 + 确定性映射表；新增 Worker Plugin Manifest 契约 |
| v3.0 | 历史记录 | 用户+Claude | 新增原则+新增模块 | Execution/Quality/Application | P0-15；Loop Budget；Bound Coverage Audit；Work Receipt/No-op Receipt；Verifier Context Isolation；Graph Efficiency Metrics/Coordination Efficiency；吸收《296 Agents to One Graph》/ IAL-Scan 论文调研结论 |
| v3.1 | 历史记录 | 用户+Claude | 实现机制细化 | Execution/Quality/State | Command Risk Classification；Phased Permission Escalation；Progressive Tool Expansion + Single-Purpose Tool Design；Deterministic Lifecycle Hooks；Scoped Context Assembly；Background Memory Consolidation；跨 Worker 消息通信澄清；吸收 Claude Code 官方架构图 + 12 Agentic Harness Patterns 调研，无新增 P0 原则 |
| v3.2 | 历史记录 | 用户+Claude | 边界澄清+验收标准修订 | Execution Scaling/Phase 12-14 | P0-16（Multi-Worker ≠ Multi-CLI）；Worker 三层能力成熟度模型（Level A/B/C）；Phase 13 正式定义为 P0 Multi-Worker MVP 达成节点；Known External Gap Registry；T12.1-12.3 Exit 标准由"Worker 类型数"改为"Worker Instance 独立性"；T12.6 提级为 Gate 必过项。源自 Codex Type B Worker 卡点评审 |
| v3.3 | 历史记录 | 用户+Claude | 重大缺口修复（真实事故驱动） | Control/State 新组件 | P0-17（执行入口强制绑定 Pipeline，Fail-Closed）；新增 Task Compiler / Ingress Gate；Ingress Binding Verification；不借鉴清单新增"伪造执行拓扑"；P0-18（Prompt View 必须有界）；新增 Context Builder & Tool Gateway：结构化工具结果信封、Allowlist 范围控制、四层预算+四级水位线、结构化状态压缩、Fresh Context/Receipt-only、Git Micro-commit 绑定、错误指纹去重、Contamination Detection、Prompt View Audit。源自两次真实生产事故（控制面未接入、上下文爆炸） |
| v3.4 | 历史记录 | 用户+Claude | 产品化补强（多项目复用） | Control 新组件+Acceptance/证据规范 | 新增 Project Registry + Delivery Host 编排层；新增 Task Ledger（`project_task_id↔pph_task_id` 映射）；标准化证据包（含 `provider_mode`）；只读操作纪律（P0-12 推论）；Acceptance/Commit/Push/Publish 四层分离（`git add -A` 归入 risky）；Worker 能力降级状态 + 三层模型身份 Schema；PPH 能力边界清单；`resource_ceiling` 独立于 `loop_budget`。无新增 P0 原则，源自 ai-proxy 真实交付场景评审 |
| **v3.5** | **2026-09-19** | **用户+Claude 评审确认** | **流程变更** | **文件管理方式** | **文件更名为 `pph_架构设计_latest.md`（不再在文件名/标题中体现版本号）；变更记录升级为结构化版本日志（版本标签/日期/变更人/变更类型/影响范围/变更摘要）；建立"latest 持续更新 + 关键实现节点前打完整快照（如 `pph_架构设计_v3.5.md`）"的双轨机制，执行时以快照为准，快照是完整副本而非增量差异，latest 独立继续滚动更新** |

> **当前状态**：五域内核连续四轮外部/内部真实检验（Grok Bot 借鉴、296-Agents/IAL-Scan、Claude Code 架构对照、ai-proxy 多项目交付）均未被突破，架构主干判定为稳定。**下一次变更前，只需阅读本表最新几行即可掌握现状，不需要通读全文比对差异**——这正是维护本日志的核心目的。
