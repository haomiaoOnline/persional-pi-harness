import { randomUUID } from "node:crypto";
import { type ContextResolver, evaluateContextReadiness } from "./context.ts";
import { EvidenceCollector } from "./evidence.ts";
import { LeaseManager } from "./lease.ts";
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
import { validateResultContract } from "./result.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import type {
	ArchitectureCommercialAssessment,
	DecisionRecord,
	DispatchDecision,
	DispatchRecord,
	EvidenceRecord,
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
	};
}

function normalizeResult(request: WorkerProtocolRequest, result: ResultContract, workerId: string): ResultContract {
	const validation = validateResultContract(result);
	if (validation.valid) return structuredClone(result);
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

	constructor(options: PersonalPiPipelineOptions = {}) {
		this.stateStore = options.state_store ?? new PersistentStateStore();
		this.leaseManager = options.lease_manager ?? new LeaseManager();
		this.evidenceCollector = options.evidence_collector ?? new EvidenceCollector();
		this.verificationEngine = options.verification_engine ?? new VerificationEngine();
		this.acceptanceGate = options.acceptance_gate ?? new AcceptanceGate();
	}

	async execute(request: PipelineRequest): Promise<PipelineExecution> {
		const at = request.at ?? new Date().toISOString();
		if (
			request.requirement.user.length === 0 ||
			request.requirement.delivery.length === 0 ||
			request.requirement.acceptance.length === 0
		) {
			throw new PipelineStageError("REQUIREMENT", "Requirement Contract is incomplete");
		}

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

		const preclassification = preclassifyTask({
			description: `${request.task.title}\n${request.task.objective}\n${request.requirement.delivery}`,
			files: request.task.scope.files,
		});
		const assessment = crossCheckAssessment(
			assessTask(request.task.objective, request.task.scope.files),
			request.task.objective,
			request.task.scope.files,
		);
		const dispatch = createDispatchDecision(request.task, assessment, request.role_profile);
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
		for (const decision of decisions) this.stateStore.addDecision(decision);

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
		const lease = this.leaseManager.acquire(task.id, request.worker.worker_id, at);
		const run = this.stateStore.createRun(task.id, request.worker.worker_id, lease.lease_epoch, at);
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
			checked_at: at,
		};
		const verification = await this.verificationEngine.verify(verificationRequest);
		this.stateStore.saveVerification(verification);
		this.stateStore.addDecision(
			createDecisionRecord(
				"verification",
				verification.status,
				verification.reasons.join("; ") || "checks passed",
				[verification.id],
				at,
			),
		);

		if (verification.status === "PASS" && result.status === "success") {
			task = this.acceptanceGate.markDone(task, verification, request.current_snapshot ?? request.snapshot);
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
		this.leaseManager.release(lease);
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
