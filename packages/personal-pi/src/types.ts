/**
 * Personal PI 的公共领域类型。
 *
 * 这些类型刻意与 Worker 实现解耦：Task Contract、状态、证据和协议对象
 * 都属于内核边界，不能由某个具体模型或 CLI 私自扩展语义。
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkerType = "pi" | "codex" | "claude" | "local_model" | "cli";
export type WorkerTier = "cheap" | "standard" | "frontier";
export type ReasoningDepth = "low" | "medium" | "high" | "extended";
export type WorkerPluginAuthType = "none" | "api_key";
export type WorkerInstanceState = "COLD" | "WARMING" | "IDLE" | "LEASED" | "BUSY" | "DEAD";
export type WorkerCapability = "available" | "unavailable";
export type WorkerDeliveryExecutionMode = "normal" | "root_only" | "degraded";
export type DeliveryStatus = "normal" | "degraded";

export interface WorkerStatus {
	worker_capability: WorkerCapability;
	execution_mode: WorkerDeliveryExecutionMode;
	delivery_status: DeliveryStatus;
}

export interface ModelIdentity {
	requested_model: string;
	platform_accepted_model: string;
	observed_runtime_model: string;
}

export interface WorkerPluginModel {
	model: string;
	reasoning_levels: ReasoningDepth[];
}

export interface WorkerPluginManifest {
	worker_plugin: {
		id: string;
		adapter_entry: string;
		models_supported: WorkerPluginModel[];
		capability_tags: string[];
		context_limit: number;
		cost_tier: WorkerTier;
		auth: {
			type: WorkerPluginAuthType;
			env_var?: string;
		};
		discovery: {
			type: "static_config";
		};
	};
}
export type ExecutionMode = "single" | "decompose" | "parallel" | "batch";
export type NetworkPermission = "deny" | "allow";
export type CredentialPermission = "deny" | "allow";
export type RiskLevel = "low" | "medium" | "high";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type VerificationStrategy = "automated" | "manual";
export type VerificationStrength = "strong" | "weak" | "none";
export type VerificationStatus = "PASS" | "FAIL" | "UNKNOWN";

/** Task Contract 的状态集合；NOT_READY 是 DoR 结果，不是可持久化任务状态。 */
export type TaskStatus =
	| "DRAFT"
	| "READY"
	| "RUNNING"
	| "VERIFYING"
	| "DONE"
	| "FAILED"
	| "BLOCKED"
	| "CANCELLED"
	| "OBSOLETE";

export type EdgeType = "DEPENDS_ON" | "PRODUCES_ARTIFACT" | "PROVIDES_DATA" | "BLOCKS" | "REQUIRES_APPROVAL";

export interface TaskScope {
	files: string[];
}

export interface TaskPermissions {
	filesystem: {
		read: string[];
		write: string[];
	};
	shell: {
		allowed: string[];
	};
	network: NetworkPermission;
	credentials: CredentialPermission;
	git?: {
		allowed: string[];
	};
}

export interface PermissionRequest {
	filesystem?: {
		read?: string[];
		write?: string[];
	};
	shell?: string[];
	network?: boolean;
	git?: string[];
	credentials?: boolean;
	credential_service?: string;
	credential_scopes?: string[];
}

export interface TaskExecution {
	worker_type: WorkerType;
	worker_tier: WorkerTier;
	reasoning_depth: ReasoningDepth;
	capability_tags: string[];
	mode: ExecutionMode;
	working_directory: string;
	allowed_tools: string[];
	idempotency_key?: string;
}

export interface LoopBudget {
	max_attempts: number;
	max_model_calls: number;
	max_tool_calls: number;
	max_handoffs: number;
	max_elapsed_ms: number;
	max_input_tokens: number;
	max_output_tokens: number;
	max_cost_usd: number;
	max_state_growth_bytes: number;
	on_exhaustion: {
		action: "BLOCKED";
		escalation: "human";
	};
}

export interface LoopUsage {
	attempts: number;
	model_calls: number;
	tool_calls: number;
	handoffs: number;
	elapsed_ms: number;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	state_growth_bytes: number;
}

/**
 * Worker 适配器在一次执行中继续调用模型或工具时，必须通过这组控制点申请配额。
 * 控制点只返回持久化后的累计用量，不把预算对象或凭证带入 Worker 协议正文。
 */
export interface WorkerExecutionControls {
	beforeModelCall(): LoopUsage;
	beforeToolCall(): LoopUsage;
	observeContextUsage?(observation: ContextBudgetObservation): ContextBudgetWatermark;
	observePromptViewAudit?(audit: PromptViewAudit): void;
	observeBackpressure?(observation: {
		scope: "domain" | "provider";
		source: string;
		action: "ALLOW" | "QUEUE";
		wait_ms: number;
		reason: string;
	}): void;
}

export type ContextBudgetLayer = "tool_output" | "prompt" | "run" | "task";
export type ContextBudgetWatermark = "LOW" | "WARNING" | "REBUILD" | "HARD";

export interface ContextBudgetMetrics {
	tokens: number;
	tool_calls: number;
	raw_log_bytes: number;
	injected_context_bytes: number;
	duplicate_ratio: number;
	state_growth_bytes: number;
	elapsed_ms: number;
	retries: number;
}

export interface ContextBudgetObservation {
	layer: Exclude<ContextBudgetLayer, "task">;
	metrics: ContextBudgetMetrics;
}

export interface ContextBudgetLayerState {
	token_limit: number;
	metrics: ContextBudgetMetrics;
	watermark: ContextBudgetWatermark;
}

export interface ContextBudgetState {
	task_id: string;
	run_id: string;
	context_limit: number;
	layers: Record<ContextBudgetLayer, ContextBudgetLayerState>;
	updated_at: string;
}

export interface TaskVerification {
	strategy: VerificationStrategy;
	commands: string[];
	checks: string[];
	evidence_required: string[];
	strength: VerificationStrength;
	recipe_ref?: string;
}

export interface TaskContext {
	required: string[];
	optional: string[];
	excluded: string[];
	budget: {
		max_input_tokens: number;
	};
}

export interface RetryPolicy {
	max_attempts: number;
	backoff: number;
}

export interface TaskApproval {
	required: boolean;
	action_digest?: string;
	bound_revision?: number;
	expires_at?: string;
}

/** v2.1 Task Contract。所有执行入口都必须先通过这个结构的校验。 */
export interface TaskContract {
	id: string;
	schema_version: 2;
	task_revision: number;
	graph_revision: number;
	type: string;
	title: string;
	objective: string;
	requirements: string[];
	constraints: string[];
	scope: TaskScope;
	role_profile_ref?: string;
	inputs: Record<string, JsonValue>;
	data_sources: string[];
	data_references: string[];
	permissions: TaskPermissions;
	execution: TaskExecution;
	dependencies: string[];
	artifact_dependencies: string[];
	expected_outputs: string[];
	acceptance_criteria: string[];
	verification: TaskVerification;
	context: TaskContext;
	risk: RiskLevel;
	priority: Priority;
	timeout: number;
	retry_policy: RetryPolicy;
	loop_budget?: LoopBudget;
	approval: TaskApproval;
}

export interface TransitionAuditEntry {
	from: TaskStatus;
	to: TaskStatus;
	at: string;
	reason?: string;
}

export interface TaskRecord extends TaskContract {
	state: TaskStatus;
	audit_log: TransitionAuditEntry[];
}

export interface ValidationResult<T> {
	valid: boolean;
	value?: T;
	errors: string[];
}

export interface GraphNode {
	id: string;
	task_id: string;
}

export interface ArtifactRequirement {
	type: string;
	schema_version: number;
}

export interface ArtifactBinding {
	artifact_digest: string;
	producer_task_revision: number;
}

export interface ArtifactHandoffContract {
	readiness: {
		requires_artifact: ArtifactRequirement;
	};
	binding: ArtifactBinding;
}

export interface GraphEdge {
	id: string;
	from: string;
	to: string;
	type: EdgeType;
	handoff?: ArtifactHandoffContract;
}

export interface TaskGraph {
	revision: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface GraphMutation {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface ArtifactRecord {
	digest: string;
	type: string;
	schema_version: number;
	payload: JsonValue;
	producer_task_id: string;
	producer_task_revision: number;
}

export interface ReadinessEvaluation {
	ready: boolean;
	state: "READY" | "NOT_READY" | "BLOCKED";
	reasons: string[];
}

export interface Lease {
	task_id: string;
	worker_id: string;
	lease_epoch: number;
	issued_at: string;
}

export interface LeaseDecision {
	accepted: boolean;
	reason: "current" | "stale_result" | "unknown_lease" | "worker_mismatch";
}

/** Controller↔Worker 协议元数据，禁止进入 PromptPayload。 */
export interface ProtocolEnvelope {
	task_id: string;
	schema_version: number;
	task_revision: number;
	graph_revision: number;
	lease_epoch: number;
	idempotency_key?: string;
	action_digest?: string;
}

/** 只包含业务执行所需内容；它与 ProtocolEnvelope 是两个不同对象。 */
export interface PromptPayload {
	objective: string;
	requirements: string[];
	constraints: string[];
	scope: TaskScope;
	inputs: Record<string, JsonValue>;
	context: TaskContext;
}

export type RiskPath = "FAST" | "SLOW";
export type Workload = "small" | "medium" | "large";
export type Uncertainty = "low" | "medium" | "high";
export type DependencyComplexity = "simple" | "complex";
export type Parallelism = "eligible" | "ineligible";
export type DispatchMode = "SINGLE_WORKER" | "DECOMPOSE" | "PARALLEL" | "BATCH";
export type DispatchExecutorKind = "direct_worker" | "worker_pool" | "batch_executor" | "decomposer";

export interface Preclassification {
	path: RiskPath;
	reasons: string[];
	matched_signals: string[];
	confidence: number;
}

export interface PreclassifierIncident {
	task_id: string;
	predicted_path: RiskPath;
	missed_signal: string;
	correction: string;
	at: string;
}

export interface TaskAssessment {
	scope: string[];
	workload: Workload;
	risk: RiskLevel;
	uncertainty: Uncertainty;
	dependency: DependencyComplexity;
	parallelism: Parallelism;
	verification: VerificationStrength;
	context_budget: number;
	confidence: number;
	capability_tags: string[];
	parallel_plan_hint?: ParallelPlanHint;
}

export interface ParallelWorkUnit {
	key: string;
	objective: string;
	source_scope: string[];
	output_schema_ref?: string;
}

export interface ParallelPlanHint {
	independent_units: ParallelWorkUnit[];
	shared_context_refs: string[];
	fan_in_required: boolean;
}

export interface DispatchDecision {
	mode: DispatchMode;
	worker_tier: WorkerTier;
	reasoning_depth: ReasoningDepth;
	candidate_worker_types: WorkerType[];
	capability_tags: string[];
	reason: string;
}

export interface DecisionRecord {
	id: string;
	decision_type: string;
	decision: string;
	reason: string;
	inputs: string[];
	at: string;
}

export type TraceOutcome = "DONE" | "FAILED" | "BLOCKED" | "UNKNOWN";

export interface TraceEvent {
	stage: string;
	detail: string;
	at: string;
	fields?: Record<string, string | number | boolean>;
}

export interface TraceMetrics {
	token_per_task: number;
	cache_hit_rate: number;
	worker_tier_distribution: Record<WorkerTier, number>;
	graph_efficiency?: GraphEfficiencyMetrics;
}

export interface PromptViewAudit {
	turn_id: string;
	total_size: number;
	sources: string[];
	truncated_items: string[];
	contamination_ratio: number;
}

export interface GraphEfficiencyMetrics {
	graph_width: number;
	graph_depth: number;
	handoff_count: number;
	peak_active_workers: number;
	retry_depth: number;
	replan_count: number;
	useful_work_ratio: number;
	verification_first_pass_rate: number;
	cost_per_verified_task: number;
	time_per_verified_task: number;
	agent_calls: number;
	coordination_efficiency: number;
}

export interface ExecutionTrace {
	trace_id: string;
	task_id: string;
	run_id?: string;
	started_at: string;
	ended_at?: string;
	outcome?: TraceOutcome;
	events: TraceEvent[];
	decisions: DecisionRecord[];
	metrics: TraceMetrics;
	prompt_view_audits?: PromptViewAudit[];
	replayable: boolean;
}

export interface RegressionCase {
	id: string;
	category: string;
	task_id?: string;
	expected: string;
	actual: string;
	evidence_ref?: string;
	created_at: string;
	resolved: boolean;
}

export interface RequirementContract {
	user: string;
	data_sources: string[];
	permission_location: string[];
	delivery: string;
	acceptance: string[];
	constraints: string[];
	unknowns: string[];
	sustainability: string[];
	non_functional: string[];
	commercialization: string[];
}

export interface ArchitectureCommercialAssessment {
	scalability: string;
	security: string;
	cost: string;
	extensibility: string;
	testability: string;
	business_viability: string;
	confidence: number;
	open_risks: string[];
	playbook_refs: string[];
}

export interface PlanQualityChecklist {
	technical_feasibility: boolean;
	scalability: boolean;
	commercial_reasonableness: boolean;
	testability: boolean;
}

export interface PlanApproval {
	approved_by: string;
	action_digest: string;
	bound_revision: number;
	expires_at: string;
}

export interface PlanQualityGateResult {
	passed: boolean;
	checklist: PlanQualityChecklist;
	approval?: PlanApproval;
	reasons: string[];
}

export interface CredentialScope {
	allowed_services: string[];
	allowed_scopes: string[];
	forbidden: string[];
}

export interface RoleProfile {
	id: string;
	mission: string;
	suitable_tasks: string[];
	ownership_scope: string[];
	credential_scope: CredentialScope;
	preferred_tools: string[];
	prohibited_actions: string[];
	context_policy: {
		required: string[];
		optional: string[];
	};
	output_contract: string[];
	handoff: {
		downstream: string[];
	};
	verifier_profile: string[];
}

export type ResultStatus = "success" | "failure" | "timeout" | "INSUFFICIENT_CONTEXT";

export interface WorkReceipt {
	work_attempted: boolean;
	effects_count: number;
	artifacts_created: string[];
	state_changed: boolean;
	no_op: boolean;
	no_op_reason?: string;
	evidence_refs: string[];
}

export type MasterHandoffAcceptance = "PASS" | "FAIL" | "UNKNOWN";
export type MasterHandoffStatus = Extract<TaskStatus, "DONE" | "FAILED" | "BLOCKED" | "CANCELLED" | "OBSOLETE">;

export interface MasterHandoffFailure {
	error_summary: string;
	artifact_refs: string[];
}

/**
 * Receipt-only cross-Task handoff boundary. Deliberately excludes Worker
 * transcript, Result summary/errors, raw Evidence, and ResolvedContext.
 */
export interface MasterHandoffReceipt {
	task_id: string;
	status: MasterHandoffStatus;
	git_sha: string;
	acceptance: MasterHandoffAcceptance;
	evidence_refs: string[];
	unresolved_risks: string[];
	next_action: string;
	work_receipt: WorkReceipt;
	failure?: MasterHandoffFailure;
}

/** Controller-only provenance. Never expose this through the Master receipt. */
export interface MasterHandoffBinding {
	task_id: string;
	task_revision: number;
	run_id: string;
	provenance_stage: "pre_verification" | "verified";
	git_sha: string;
	work_receipt_digest: string;
	evidence_refs: string[];
	verification_id?: string;
	acceptance_id?: string;
}

export interface ResultContract {
	task_id: string;
	run_id: string;
	worker_id: string;
	lease_epoch: number;
	status: ResultStatus;
	summary: string;
	changed_files: string[];
	artifacts: string[];
	evidence: string[];
	errors: string[];
	model_identity: ModelIdentity;
	requested_context?: string[];
	work_receipt?: WorkReceipt;
}

export interface BatchResultItem {
	task_id: string;
	status: ResultStatus;
	changed_files: string[];
	artifacts: string[];
	evidence: string[];
	errors: string[];
	requested_context?: string[];
	work_receipt?: WorkReceipt;
}

export interface BatchResultEnvelope {
	batch_id: string;
	worker_id: string;
	lease_epoch: number;
	results: BatchResultItem[];
}

export interface WorkerProtocolRequest {
	task: TaskContract;
	protocol: ProtocolEnvelope;
	role_profile?: RoleProfile;
	requested_actions?: string[];
	run_id?: string;
	resolved_context?: ResolvedContext;
	permission_request?: PermissionRequest;
	/** Controller-owned raw tool artifact root. Never include this path in PromptPayload. */
	tool_artifact_root?: string;
}

export interface WorkerExecutionInput {
	prompt: PromptPayload;
	role_profile?: RoleProfile;
	requested_actions: string[];
	resolved_context?: ResolvedContext;
	loop_budget?: WorkerExecutionControls;
}

export interface WorkerExecutionOutput {
	status: ResultStatus;
	summary: string;
	changed_files?: string[];
	artifacts?: string[];
	evidence?: string[];
	errors?: string[];
	requested_context?: string[];
	work_receipt?: WorkReceipt;
}

export interface EffectRecord {
	idempotency_key: string;
	action_digest: string;
	target: string;
	status: "pending" | "committed" | "failed";
	reversible: boolean;
	compensation_action?: string;
	updated_at: string;
}

export interface EffectExecutionResult {
	committed: boolean;
	reused: boolean;
	record: EffectRecord;
}

export interface CommandEvidence {
	command: string;
	exit_code: number;
	stdout: string;
	stderr: string;
}

export type ToolResultStatus = "success" | "failure" | "error" | "blocked";

export type ToolOutputKind = "compile" | "test" | "stack" | "search" | "large_file" | "generic";

export interface ToolResultEnvelope {
	exit_code: number;
	status: ToolResultStatus;
	duration: number;
	stdout_summary: string;
	stderr_summary: string;
	error_fingerprint: string | null;
	relevant_stack_frames: string[];
	artifact_id: string;
	truncated: boolean;
	next_cursor: string | null;
}

export interface ToolArtifactPage {
	artifact_id: string;
	content: string;
	next_cursor: string | null;
	truncated: boolean;
	sensitive_info: "none" | "possible";
}

export type ProviderMode = "mock" | "local" | "real";

export interface ExecutionSurfaceAttestation {
	entrypoint: "interactive" | "stable_cli" | "api" | "other";
	pph_commit: string;
	bundle_sha256: string;
	ingress_bound: boolean;
	pipeline_bound: boolean;
	scheduler_enabled: boolean;
	scheduler_kind: "direct" | "worker_pool";
}

export interface DeliveryEvidencePackage {
	baseline_commit: string;
	actual_diff: {
		files: string[];
		digest: string;
	};
	task_revision: number;
	workspace_snapshot_ref: string;
	commands_and_exit_codes: Array<{
		command: string;
		exit_code: number;
	}>;
	test_output_summary: string;
	artifact_digest: string;
	browser_or_container_verification: string[];
	unfinished_items: string[];
	provider_mode: ProviderMode;
}

export type SourceProvenanceType = "official" | "filing" | "media" | "third_party" | "derived";

export interface SourceProvenance {
	source_ref: string;
	source_type: SourceProvenanceType;
	published_at?: string;
	observed_at: string;
	metric: string;
	value: JsonValue;
	unit?: string;
	period?: string;
	population_scope?: string;
	formula_ref?: string;
	input_evidence_refs?: string[];
	confidence: number;
}

export interface EvidenceRecord {
	id: string;
	task_id: string;
	run_id: string;
	captured_at: string;
	diff: {
		files: string[];
		digest: string;
	};
	commands: CommandEvidence[];
	/** Bounded model-facing tool results. Raw output lives only in Artifact Store. */
	tool_results?: ToolResultEnvelope[];
	stdout: string;
	stderr: string;
	test_result?: string;
	build_result?: string;
	artifacts: string[];
	evidence_types: string[];
	source_provenance?: SourceProvenance[];
	/** Optional only for loading/replaying pre-v3.4 legacy Evidence. New verification requires it. */
	delivery_evidence_package?: DeliveryEvidencePackage;
}

export interface WorkspaceSnapshot {
	commit_hash: string;
	diff_digest: string;
	artifact_digest: string;
}

export interface VerificationRecord {
	id: string;
	task_id: string;
	/** Required on all newly-produced verification records; optional only for legacy persisted records. */
	evidence_id?: string;
	/** Content binding for the exact standardized package used by this verification. */
	delivery_evidence_package_digest?: string;
	status: VerificationStatus;
	verification_confidence: VerificationStrength;
	task_revision: number;
	commit_hash: string;
	diff_digest: string;
	artifact_digest: string;
	checked_at: string;
	checks: string[];
	reasons: string[];
}

export interface VerificationRecipe {
	id: string;
	task_type: string;
	required: string[];
	evidence: string[];
	required_provider_mode?: ProviderMode;
}

export type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "CRASHED";

export interface RunRecord {
	id: string;
	task_id: string;
	/** Immutable Task revision captured when this Run was created. */
	task_revision?: number;
	attempt: number;
	worker_id: string;
	lease_epoch: number;
	worker_status: WorkerStatus;
	model_identity: ModelIdentity;
	status: RunStatus;
	started_at: string;
	/** Controller-observed workspace commit at Run start; Worker cannot attest this. */
	workspace_commit_hash?: string;
	ended_at?: string;
	result_id?: string;
	failure_reason?: string;
}

export interface WorkerInstanceRecord {
	worker_instance_id: string;
	adapter_id: string;
	pid: number | null;
	session_id: string;
	session_id_sha256: string;
	lease_epoch: number;
	workspace_path: string;
	context_projection_digest: string;
	loop_usage: LoopUsage;
	state: WorkerInstanceState;
	execution_started_at?: string;
	execution_ended_at?: string;
	updated_at: string;
}

export interface StateSnapshot {
	id: string;
	created_at: string;
	digest: string;
	state: PersistentState;
}

export interface RecoveryDecision {
	run_id: string;
	task_id: string;
	action: "RECLAIM" | "BLOCK" | "NOOP";
	reason: string;
}

export interface ControlPlaneReconstruction {
	next_ready_task_ids: string[];
	running_run_ids: string[];
	blocked_task_ids: string[];
	decision_ids: string[];
	active_leases: Lease[];
	lease_epochs: Record<string, number>;
	snapshot_ids: string[];
}

export interface PersistentState {
	version: 2;
	projects: ProjectRecord[];
	task_ledger: TaskLedgerBinding[];
	acceptances: AcceptanceRecord[];
	human_approvals: HumanApprovalRecord[];
	delivery_actions: DeliveryActionRecord[];
	handoff_receipts: MasterHandoffReceipt[];
	handoff_bindings: Record<string, MasterHandoffBinding>;
	tasks: TaskRecord[];
	graphs: TaskGraph[];
	dispatches: DispatchRecord[];
	runs: RunRecord[];
	results: ResultContract[];
	evidence: EvidenceRecord[];
	verifications: VerificationRecord[];
	decisions: DecisionRecord[];
	role_profiles: RoleProfile[];
	effects: EffectRecord[];
	/** 分解/协调预算的累计用量，按预算作用域持久化。 */
	budget_usage: Record<string, BudgetUsageState>;
	/** 分解/协调预算的允许与拒绝决策，按预算作用域持久化。 */
	budget_decisions: Record<string, BudgetDecisionState[]>;
	/** 当前有效租约；释放后删除，历史 epoch 由 lease_epochs 保留。 */
	leases: Record<string, Lease>;
	/** 每个 Task 最近分配过的 epoch，防止 Controller 重启后 epoch 回退。 */
	lease_epochs: Record<string, number>;
	/** Level-B Worker Instance 的非机密运行时身份与生命周期快照。 */
	worker_instances: Record<string, WorkerInstanceRecord>;
	loop_usage: Record<string, LoopUsage>;
	context_budget: Record<string, ContextBudgetState>;
	traces: ExecutionTrace[];
	regressions: RegressionCase[];
	snapshots: Array<Pick<StateSnapshot, "id" | "created_at" | "digest">>;
	snapshot_payloads: Record<string, { created_at: string; digest: string; state: PersistentState }>;
}

export interface BudgetUsageState {
	open_tasks: number;
	replan_count: number;
	active_workers: number;
	handoffs_by_task: Record<string, number>;
	concurrent_roles: number;
}

export interface BudgetDecisionState {
	id: string;
	dimension: string;
	action: "ALLOW" | "DENY" | "INCREASE";
	reason: string;
	approved_by?: string;
	at: string;
}

export interface ContextReference {
	digest: string;
	source_path?: string;
	token_estimate: number;
	held_out?: boolean;
}

export interface ContextManifest {
	required: string[];
	optional: string[];
	excluded: string[];
	budget: {
		max_input_tokens: number;
	};
}

export interface ResolvedContextItem {
	digest: string;
	content: string;
	token_estimate: number;
}

export interface ResolvedContext {
	items: ResolvedContextItem[];
	text: string;
	total_tokens: number;
	cache_hit: boolean;
	omitted_optional: string[];
	manifest_digest: string;
}

export interface ContextCacheStats {
	hits: number;
	misses: number;
}

export interface EvidenceSummary {
	task_id: string;
	status: VerificationStatus;
	summary: string;
	evidence_ref: string;
}

export interface ContextCompactionReport {
	facts: string[];
	decisions: string[];
	completed_tasks: string[];
	open_tasks: string[];
	open_risks: string[];
	verified_evidence: string[];
	failed_attempts: Array<{ error_fingerprint: string }>;
	next_action: string;
	git_sha: string;
	artifact_refs: string[];
}

export interface ProjectRecord {
	project_id: string;
	repo_path: string;
	baseline_commit: string;
	architecture_doc_ref: string;
	task_ledger_ref: string;
}

export type TaskLedgerGateStatus = "PENDING" | "PASS" | "FAIL" | "UNKNOWN";

/**
 * Persistent identity/ownership metadata for an external project task.
 * Mutable execution status is deliberately excluded and projected from the
 * canonical TaskRecord/Verification state instead.
 */
export interface TaskLedgerBinding {
	project_id: string;
	project_task_id: string;
	pph_task_id: string;
	phase: string;
	unknowns: string[];
}

/** Machine-readable Task Ledger view defined by the v3.4 architecture. */
export interface TaskLedgerEntry extends TaskLedgerBinding {
	task_revision: number;
	owner: string;
	scope: string[];
	status: TaskStatus;
	verification_recipe: string | null;
	evidence_refs: string[];
	gate_status: TaskLedgerGateStatus;
}

export interface AcceptanceRecord {
	id: string;
	task_id: string;
	task_revision: number;
	verification_id: string;
	run_id: string;
	/** Required for new acceptances; optional only for pre-v3.4 legacy state. */
	evidence_id?: string;
	/** Required for new acceptances; never inferred for legacy state. */
	provider_mode?: ProviderMode;
	accepted_at: string;
}

export type HumanApprovalAction = "commit" | "push" | "publish";

export interface HumanApprovalRecord {
	id: string;
	task_id: string;
	task_revision: number;
	action: HumanApprovalAction;
	action_digest: string;
	expires_at: string;
	approved_at: string;
	approved_by: string;
}

interface DeliveryActionRecordBase {
	id: string;
	task_id: string;
	task_revision: number;
	approval_id: string;
	action_digest: string;
	acceptance_id: string;
	evidence_id: string;
	delivery_evidence_package_digest: string;
	attempted_at: string;
	detail?: string;
}

export type DeliveryActionRecord =
	| (DeliveryActionRecordBase & {
			action: "commit";
			status: "COMMITTED";
			repo_path: string;
			scope_files: string[];
			commit_sha: string;
			parent_sha: string;
	  })
	| (DeliveryActionRecordBase & {
			action: "commit";
			status: "FAILED" | "BLOCKED";
			repo_path: string;
			scope_files: string[];
			commit_sha?: string;
			parent_sha: string;
	  })
	| (DeliveryActionRecordBase & {
			action: "push";
			status: "PUSHED" | "FAILED" | "BLOCKED";
			repo_path: string;
			commit_sha: string;
			remote: string;
			refspec: string;
	  })
	| (DeliveryActionRecordBase & {
			action: "publish";
			status: "PUBLISHED" | "FAILED" | "BLOCKED";
			commit_sha: string;
			package_name: string;
			version: string;
			registry: string;
	  });

export interface DispatchRecord {
	id: string;
	task_id: string;
	worker_id: string;
	lease_epoch?: number;
	requested_mode: ExecutionMode;
	effective_mode: ExecutionMode;
	executor_kind: DispatchExecutorKind;
	planned_worker_count: number;
	effective_worker_count: number;
	degrade_reason?: string;
	overlap_proof_ref?: string;
	worker_status: WorkerStatus;
	requested_model: string;
	created_at: string;
}
