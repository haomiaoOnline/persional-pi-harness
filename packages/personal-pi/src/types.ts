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
