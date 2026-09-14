import { randomUUID } from "node:crypto";
import { type ContextResolver, evaluateContextReadiness } from "./context.ts";
import { EvidenceCollector } from "./evidence.ts";
import { LeaseManager } from "./lease.ts";
import { LoopBudgetController, LoopBudgetExhaustedError } from "./loop-budget.ts";
import { PersistentStateStore } from "./persistence.ts";
import {
	assessArchitectureCommercial,
	assessTask,
	calculatePlanDigest,
	createDecisionRecord,
	createDispatchDecision,
	crossCheckAssessment,
	evaluatePlanQualityGate,
	preclassifyTask,
	ReferenceArchitecturePlaybook,
} from "./planning.ts";
import { createProtocolEnvelope } from "./protocol.ts";
import { evaluateDefinitionOfReady } from "./readiness.ts";
import type { VerificationRecipeRegistry } from "./recipes.ts";
import { ensureWorkReceipt, validateResultContract } from "./result.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import { createRegressionCase, TraceRecorder } from "./trace.ts";
import type {
	ArchitectureCommercialAssessment,
	DecisionRecord,
	DispatchDecision,
	DispatchRecord,
	EvidenceRecord,
	ExecutionTrace,
	PermissionRequest,
	PlanApproval,
	PlanQualityChecklist,
	PlanQualityGateResult,
	Preclassification,
	RequirementContract,
	ResolvedContext,
	ResultContract,
	RoleProfile,
	RunRecord,
	TaskAssessment,
	TaskContract,
	TaskRecord,
	VerificationRecord,
	WorkerProtocolRequest,
	WorkspaceSnapshot,
} from "./types.ts";
import { AcceptanceGate, type CommandRunner, VerificationEngine, type VerificationRequest } from "./verification.ts";
import type { WorkerAdapter } from "./worker.ts";

export type PipelineStage =
	| "REQUIREMENT"
	| "PLAN_GATE"
	| "TASK"
	| "DOR"
	| "ASSESSMENT"
	| "DISPATCH"
	| "WORKER"
	| "RUN"
	| "RESULT"
	| "EVIDENCE"
	| "VERIFICATION"
	| "ACCEPTANCE";

export class PipelineStageError extends Error {
	readonly stage: PipelineStage;
	readonly task_id?: string;

	constructor(stage: PipelineStage, message: string, taskId?: string) {
		super(`${stage}: ${message}`);
		this.name = "PipelineStageError";
		this.stage = stage;
		this.task_id = taskId;
	}
}

export interface PipelineRequest {
	requirement: RequirementContract;
	task: TaskContract;
	worker: WorkerAdapter;
	plan_checklist: PlanQualityChecklist;
	plan_approval: PlanApproval;
	plan_assessment?: ArchitectureCommercialAssessment;
	playbook?: ReferenceArchitecturePlaybook;
	role_profile?: RoleProfile;
	requested_actions?: string[];
	permission_request?: PermissionRequest;
	context_resolver?: ContextResolver;
	command_runner?: CommandRunner;
	recipe_registry?: VerificationRecipeRegistry;
	snapshot: WorkspaceSnapshot;
	current_snapshot?: WorkspaceSnapshot;
	existing_task?: TaskRecord;
	at?: string;
}

export interface PipelineExecution {
	task: TaskRecord;
	run: RunRecord;
	result: ResultContract;
	evidence: EvidenceRecord;
	verification: VerificationRecord;
	plan_gate: PlanQualityGateResult;
	preclassification: Preclassification;
	assessment: TaskAssessment;
	dispatch: DispatchDecision;
	decisions: DecisionRecord[];
	resolved_context?: ResolvedContext;
	trace: ExecutionTrace;
}

export interface PersonalPiPipelineOptions {
	state_store?: PersistentStateStore;
	lease_manager?: LeaseManager;
	evidence_collector?: EvidenceCollector;
	verification_engine?: VerificationEngine;
	acceptance_gate?: AcceptanceGate;
}

function dispatchMode(mode: DispatchDecision["mode"]): DispatchRecord["mode"] {
	if (mode === "DECOMPOSE") return "decompose";
	if (mode === "PARALLEL") return "parallel";
	if (mode === "BATCH") return "batch";
	return "single";
}

function failureResult(request: WorkerProtocolRequest, workerId: string, error: unknown): ResultContract {
	return {
		task_id: request.task.id,
		run_id: request.run_id ?? randomUUID(),
		worker_id: workerId,
		lease_epoch: request.protocol.lease_epoch,
		status: "failure",
		summary: "worker adapter threw before returning a Result Contract",
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors: [error instanceof Error ? error.message : String(error)],
		work_receipt: {
			work_attempted: false,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: true,
			no_op_reason: "worker adapter threw before execution",
			evidence_refs: [],
		},
	};
}

function normalizeResult(request: WorkerProtocolRequest, result: ResultContract, workerId: string): ResultContract {
	const validation = validateResultContract(result);
	if (validation.valid) return ensureWorkReceipt(result);
	return {
		task_id: request.task.id,
		run_id: request.run_id ?? randomUUID(),
		worker_id: workerId,
		lease_epoch: request.protocol.lease_epoch,
		status: "failure",
		summary: "worker adapter returned malformed Result Contract",
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors: validation.errors,
	};
}

export class PersonalPiPipeline {
	readonly stateStore: PersistentStateStore;
	private readonly leaseManager: LeaseManager;
	private readonly evidenceCollector: EvidenceCollector;
	private readonly verificationEngine: VerificationEngine;
	private readonly acceptanceGate: AcceptanceGate;
	private readonly loopBudgetController: LoopBudgetController;

	constructor(options: PersonalPiPipelineOptions = {}) {
		this.stateStore = options.state_store ?? new PersistentStateStore();
		this.leaseManager = options.lease_manager ?? new LeaseManager();
		this.evidenceCollector = options.evidence_collector ?? new EvidenceCollector();
		this.verificationEngine = options.verification_engine ?? new VerificationEngine();
		this.acceptanceGate = options.acceptance_gate ?? new AcceptanceGate();
		this.loopBudgetController = new LoopBudgetController(this.stateStore);
	}

	async execute(request: PipelineRequest): Promise<PipelineExecution> {
		const at = request.at ?? new Date().toISOString();
		const tracer = new TraceRecorder(request.task.id, undefined, at);
		if (
			request.requirement.user.length === 0 ||
			request.requirement.delivery.length === 0 ||
			request.requirement.acceptance.length === 0
		) {
			throw new PipelineStageError("REQUIREMENT", "Requirement Contract is incomplete");
		}
		tracer.record("REQUIREMENT", "Requirement Contract accepted", at);

		const planAssessment =
			request.plan_assessment ??
			assessArchitectureCommercial(
				request.requirement,
				request.task.type,
				request.playbook ?? new ReferenceArchitecturePlaybook(),
			);
		const planGate = evaluatePlanQualityGate(
			planAssessment,
			request.plan_checklist,
			request.plan_approval,
			Date.parse(at),
		);
		if (!planGate.passed) throw new PipelineStageError("PLAN_GATE", planGate.reasons.join("; "));
		tracer.record("PLAN_GATE", "plan quality gate passed", at);

		const preclassification = preclassifyTask({
			description: `${request.task.title}\n${request.task.objective}\n${request.requirement.delivery}`,
			files: request.task.scope.files,
		});
		tracer.record("PRECLASSIFY", preclassification.path, at);
		const assessment = crossCheckAssessment(
			assessTask(request.task.objective, request.task.scope.files),
			request.task.objective,
			request.task.scope.files,
		);
		tracer.record("ASSESSMENT", `${assessment.risk}/${assessment.workload}`, at);
		const dispatch = createDispatchDecision(request.task, assessment, request.role_profile);
		tracer.record("DISPATCH", dispatch.mode, at, {
			worker_tier: dispatch.worker_tier,
			reasoning_depth: dispatch.reasoning_depth,
		});
		const decisions = [
			createDecisionRecord(
				"preclassification",
				preclassification.path,
				preclassification.reasons.join("; "),
				[request.task.id],
				at,
			),
			createDecisionRecord(
				"assessment",
				assessment.risk,
				`confidence=${assessment.confidence}`,
				[request.task.id],
				at,
			),
			createDecisionRecord("dispatch_policy", dispatch.mode, dispatch.reason, [request.task.id], at),
		];
		for (const decision of decisions) {
			this.stateStore.addDecision(decision);
			tracer.addDecision(decision);
		}

		let task: TaskRecord;
		if (request.existing_task) {
			if (request.existing_task.id !== request.task.id) {
				throw new PipelineStageError(
					"TASK",
					"existing Task Record does not match Task Contract id",
					request.task.id,
				);
			}
			const persisted = this.stateStore.getTask(request.existing_task.id);
			if (!persisted)
				throw new PipelineStageError("TASK", "existing Task Record is not in Persistent State", request.task.id);
			if (persisted.state !== "DRAFT")
				throw new PipelineStageError("TASK", `existing task is ${persisted.state}`, request.task.id);
			task = persisted;
		} else {
			task = this.stateStore.createTask(request.task);
		}
		tracer.record("TASK", "Task Contract persisted", at);
		const definitionOfReady = evaluateDefinitionOfReady(request.task, true);
		if (!definitionOfReady.ready) {
			task = this.stateStore.updateTask(
				new TaskStateMachine().transition(task, "BLOCKED", definitionOfReady.reasons.join("; "), at),
			);
			throw new PipelineStageError("DOR", definitionOfReady.reasons.join("; "), task.id);
		}

		let resolvedContext: ResolvedContext | undefined;
		if (request.context_resolver) {
			const contextReady = evaluateContextReadiness(request.task.context, request.context_resolver);
			if (!contextReady.ready) {
				task = this.stateStore.updateTask(
					new TaskStateMachine().transition(task, "BLOCKED", contextReady.reasons.join("; "), at),
				);
				throw new PipelineStageError("DOR", contextReady.reasons.join("; "), task.id);
			}
			resolvedContext = request.context_resolver.resolve(request.task.context);
		} else if (request.task.context.required.length > 0) {
			task = this.stateStore.updateTask(
				new TaskStateMachine().transition(
					task,
					"BLOCKED",
					"context resolver is required for referenced context",
					at,
				),
			);
			throw new PipelineStageError("DOR", "context resolver is required for referenced context", task.id);
		}

		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "READY", "Definition of Ready passed", at),
		);
		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "RUNNING", "dispatch policy accepted", at),
		);
		tracer.record("DOR", "Definition of Ready passed", at);
		tracer.record("WORKER", request.worker.worker_id, at);
		try {
			this.loopBudgetController.beforeRun(request.task);
		} catch (error) {
			const reason = error instanceof LoopBudgetExhaustedError ? error.message : String(error);
			task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
			const decision = createDecisionRecord("loop_budget", "BLOCKED", reason, [task.id], at);
			this.stateStore.addDecision(decision);
			tracer.addDecision(decision);
			tracer.record("RUN", "blocked before Run creation", at);
			tracer.finish("BLOCKED", at);
			this.stateStore.addTrace(tracer.snapshot());
			throw new PipelineStageError("RUN", reason, task.id);
		}
		const lease = this.leaseManager.acquire(task.id, request.worker.worker_id, at);
		const run = this.stateStore.createRun(task.id, request.worker.worker_id, lease.lease_epoch, at);
		tracer.attachRun(run.id);
		tracer.record("RUN", "Run created", at);
		this.stateStore.addDispatch({
			id: randomUUID(),
			task_id: task.id,
			worker_id: request.worker.worker_id,
			lease_epoch: lease.lease_epoch,
			mode: dispatchMode(dispatch.mode),
			created_at: at,
		});

		const protocol = createProtocolEnvelope(task, lease.lease_epoch, calculatePlanDigest(planAssessment));
		const workerRequest: WorkerProtocolRequest = {
			task: request.task,
			protocol,
			role_profile: request.role_profile,
			requested_actions: request.requested_actions,
			permission_request: request.permission_request,
			run_id: run.id,
			resolved_context: resolvedContext,
		};
		let result: ResultContract;
		try {
			result = normalizeResult(workerRequest, await request.worker.execute(workerRequest), request.worker.worker_id);
		} catch (error) {
			result = failureResult(workerRequest, request.worker.worker_id, error);
		}
		if (!this.leaseManager.acceptResult(lease).accepted) {
			throw new PipelineStageError("RESULT", "Worker result rejected by fencing lease", task.id);
		}
		this.stateStore.saveResult(result, at);
		tracer.record("RESULT", result.status, at);

		const evidence = this.evidenceCollector.collect({
			task_id: task.id,
			run_id: run.id,
			changed_files: result.changed_files,
			stdout: result.summary,
			stderr: result.errors.join("; "),
			artifacts: result.artifacts,
			evidence_types: result.evidence,
			captured_at: at,
		});
		this.stateStore.saveEvidence(evidence);
		tracer.record("EVIDENCE", "Evidence recorded", at);
		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "VERIFYING", "Result and Evidence recorded", at),
		);

		const verificationRequest: VerificationRequest = {
			task,
			evidence,
			snapshot: request.snapshot,
			currentSnapshot: request.current_snapshot ?? request.snapshot,
			commandRunner: request.command_runner,
			recipeRegistry: request.recipe_registry,
			workerStatus: result.status,
			result,
			checked_at: at,
		};
		const verification = await this.verificationEngine.verify(verificationRequest);
		this.stateStore.saveVerification(verification);
		const verificationDecision = createDecisionRecord(
			"verification",
			verification.status,
			verification.reasons.join("; ") || "checks passed",
			[verification.id],
			at,
		);
		this.stateStore.addDecision(verificationDecision);
		tracer.addDecision(verificationDecision);
		tracer.record("VERIFICATION", verification.status, at);

		if (verification.status === "PASS" && result.status === "success") {
			try {
				task = this.acceptanceGate.markDone(
					task,
					verification,
					request.current_snapshot ?? request.snapshot,
					result,
				);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.startsWith("work_receipt_anomaly:")) throw error;
				const reason = error.message;
				task = new TaskStateMachine().transition(task, "BLOCKED", reason, at);
				const decision = createDecisionRecord("work_receipt", "BLOCKED", reason, [task.id, run.id], at);
				this.stateStore.addDecision(decision);
				tracer.addDecision(decision);
				tracer.record("ACCEPTANCE", "work receipt anomaly requires human review", at);
			}
		} else {
			const terminalState =
				result.status === "INSUFFICIENT_CONTEXT" || verification.status === "UNKNOWN" ? "BLOCKED" : "FAILED";
			task = new TaskStateMachine().transition(
				task,
				terminalState,
				result.status === "INSUFFICIENT_CONTEXT"
					? "Worker requested more context"
					: verification.reasons.join("; ") || `verification ${verification.status}`,
				at,
			);
		}
		this.stateStore.updateTask(task);
		if (task.state !== "DONE") {
			this.stateStore.addRegression(
				createRegressionCase({
					category: "pipeline_failure",
					task_id: task.id,
					expected: "DONE",
					actual: task.state,
					evidence_ref: evidence.id,
					created_at: at,
				}),
			);
		}
		this.leaseManager.release(lease);
		if (
			task.state !== "BLOCKED" ||
			!tracer.snapshot().events.some((event) => event.detail === "work receipt anomaly requires human review")
		) {
			tracer.record("ACCEPTANCE", task.state, at);
		}
		tracer.setMetrics({
			token_per_task: resolvedContext?.total_tokens ?? 0,
			cache_hit_rate: resolvedContext?.cache_hit ? 1 : 0,
			worker_tier: request.task.execution.worker_tier,
			graph_efficiency: {
				graph_width: 1,
				graph_depth: 1,
				handoff_count: 0,
				peak_active_workers: 1,
				retry_depth: Math.max(0, run.attempt - 1),
				replan_count: 0,
				useful_work_ratio: result.work_receipt?.no_op ? 0 : 1,
				verification_first_pass_rate: verification.status === "PASS" && run.attempt === 1 ? 1 : 0,
				cost_per_verified_task: 0,
				time_per_verified_task: 0,
				agent_calls: 1,
				coordination_efficiency: task.state === "DONE" ? 1 : 0,
			},
		});
		tracer.finish(task.state === "DONE" ? "DONE" : task.state === "BLOCKED" ? "BLOCKED" : "FAILED", at);
		const trace = tracer.snapshot();
		this.stateStore.addTrace(trace);
		return {
			task,
			run: this.stateStore.getRuns(task.id).find((candidate) => candidate.id === run.id) ?? run,
			result,
			evidence,
			verification,
			plan_gate: planGate,
			preclassification,
			assessment,
			dispatch,
			decisions: [
				...decisions,
				...this.stateStore.read().decisions.filter((decision) => decision.inputs.includes(verification.id)),
			],
			resolved_context: resolvedContext,
			trace,
		};
	}
}

export function createPlanApproval(
	assessment: ArchitectureCommercialAssessment,
	approvedBy: string,
	boundRevision = 1,
	expiresAt = "2999-01-01T00:00:00.000Z",
): PlanApproval {
	return {
		approved_by: approvedBy,
		action_digest: calculatePlanDigest(assessment),
		bound_revision: boundRevision,
		expires_at: expiresAt,
	};
}

export function createTaskRecordForPipeline(contract: TaskContract): TaskRecord {
	return createTaskRecord(contract);
}
