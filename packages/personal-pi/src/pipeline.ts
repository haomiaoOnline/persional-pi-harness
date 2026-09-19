import { createHash, randomUUID } from "node:crypto";
import { ArtifactStore } from "./artifacts.ts";
import { authorizeCommand, type CommandApproval, CommandRiskClassifier } from "./command-risk.ts";
import {
	ContextCompactionPolicy,
	type ContextResolver,
	evaluateContextReadiness,
	FreshContextBuilder,
} from "./context.ts";
import {
	ContextRebuildRequiredError,
	contextBudgetMetricsAreValid,
	createContextBudgetState,
	updateContextBudgetLayer,
	zeroContextBudgetMetrics,
} from "./context-budget.ts";
import { createDeliveryEvidencePackage, EvidenceCollector } from "./evidence.ts";
import { buildMasterHandoffReceipt, createArchivedHandoffFailure } from "./handoff.ts";
import { LeaseManager } from "./lease.ts";
import type { LifecycleHookManager, LifecycleHookRunResult } from "./lifecycle-hooks.ts";
import { LoopBudgetController, LoopBudgetExhaustedError, LoopBudgetMissingError } from "./loop-budget.ts";
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
import { type DefinitionOfReadyInput, evaluateDefinitionOfReady } from "./readiness.ts";
import type { VerificationRecipeRegistry } from "./recipes.ts";
import { createModelIdentity, ensureWorkReceipt, validateResultContract, validateWorkerStatus } from "./result.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import { ToolGateway } from "./tool-gateway.ts";
import { computeGraphEfficiencyMetrics, createRegressionCase, TraceRecorder } from "./trace.ts";
import type {
	AcceptanceRecord,
	ArchitectureCommercialAssessment,
	CommandEvidence,
	ContextBudgetMetrics,
	DecisionRecord,
	DispatchDecision,
	DispatchRecord,
	EvidenceRecord,
	ExecutionMode,
	ExecutionTrace,
	Lease,
	MasterHandoffReceipt,
	PermissionRequest,
	PlanApproval,
	PlanQualityChecklist,
	PlanQualityGateResult,
	Preclassification,
	ProviderMode,
	RequirementContract,
	ResolvedContext,
	ResultContract,
	RoleProfile,
	RunRecord,
	TaskAssessment,
	TaskContract,
	TaskRecord,
	ToolResultEnvelope,
	VerificationRecord,
	WorkerExecutionControls,
	WorkerProtocolRequest,
	WorkerStatus,
	WorkspaceSnapshot,
} from "./types.ts";
import {
	AcceptanceGate,
	type CommandRunner,
	sanitizeResultForVerification,
	VerificationEngine,
	type VerificationRequest,
} from "./verification.ts";
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
	/** Explicit environment label; never inferred from provider/model/adapter identity. */
	provider_mode: ProviderMode;
	/** Explicit controller/project baseline; never synthesized from provider output. */
	baseline_commit: string;
	worker: WorkerAdapter;
	worker_status: WorkerStatus;
	plan_checklist: PlanQualityChecklist;
	plan_approval: PlanApproval;
	plan_assessment?: ArchitectureCommercialAssessment;
	playbook?: ReferenceArchitecturePlaybook;
	role_profile?: RoleProfile;
	requested_actions?: string[];
	permission_request?: PermissionRequest;
	context_resolver?: ContextResolver;
	handoff_task_ids?: readonly string[];
	command_runner?: CommandRunner;
	command_risk_classifier?: CommandRiskClassifier;
	command_approval?: CommandApproval;
	lifecycle_hooks?: LifecycleHookManager;
	previous_working_directory?: string;
	recipe_registry?: VerificationRecipeRegistry;
	snapshot: WorkspaceSnapshot;
	current_snapshot?: WorkspaceSnapshot;
	workspace_snapshot_provider?: (artifacts: readonly string[]) => WorkspaceSnapshot;
	existing_task?: TaskRecord;
	definition_of_ready?: DefinitionOfReadyInput;
	dispatch_execution?: {
		requested_mode: ExecutionMode;
		effective_mode: ExecutionMode;
		executor_kind: DispatchRecord["executor_kind"];
		planned_worker_count: number;
		effective_worker_count: number;
		degrade_reason?: string;
		overlap_proof_ref?: string;
	};
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
	dispatch_record: DispatchRecord;
	decisions: DecisionRecord[];
	resolved_context?: ResolvedContext;
	trace: ExecutionTrace;
	handoff: MasterHandoffReceipt;
}

export interface PersonalPiPipelineOptions {
	state_store?: PersistentStateStore;
	lease_manager?: LeaseManager;
	evidence_collector?: EvidenceCollector;
	verification_engine?: VerificationEngine;
	acceptance_gate?: AcceptanceGate;
	artifact_store?: ArtifactStore;
	tool_gateway?: ToolGateway;
}

function dispatchMode(mode: DispatchDecision["mode"]): ExecutionMode {
	if (mode === "DECOMPOSE") return "decompose";
	if (mode === "PARALLEL") return "parallel";
	if (mode === "BATCH") return "batch";
	return "single";
}

function directDispatchExecution(
	dispatch: DispatchDecision,
	assessment: TaskAssessment,
): NonNullable<PipelineRequest["dispatch_execution"]> {
	const requestedMode = dispatchMode(dispatch.mode);
	const plannedWorkerCount =
		requestedMode === "parallel" ? Math.max(2, assessment.parallel_plan_hint?.independent_units.length ?? 0) : 1;
	return {
		requested_mode: requestedMode,
		effective_mode: "single",
		executor_kind: "direct_worker",
		planned_worker_count: plannedWorkerCount,
		effective_worker_count: 1,
		...(requestedMode !== "single"
			? { degrade_reason: "single-task Pipeline requires an outer DispatchExecutor for non-single execution" }
			: {}),
	};
}

function failureResult(
	request: WorkerProtocolRequest,
	workerId: string,
	error: unknown,
	summary = "worker adapter threw before returning a Result Contract",
	requestedModel = "unknown",
): ResultContract {
	return {
		task_id: request.task.id,
		run_id: request.run_id ?? randomUUID(),
		worker_id: workerId,
		lease_epoch: request.protocol.lease_epoch,
		status: "failure",
		summary,
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors: [error instanceof Error ? error.message : String(error)],
		model_identity: createModelIdentity(requestedModel),
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

function normalizeResult(
	request: WorkerProtocolRequest,
	result: ResultContract,
	workerId: string,
	requestedModel: string,
): ResultContract {
	const validation = validateResultContract(result);
	if (validation.valid) {
		const identityErrors = [
			result.task_id === request.task.id ? undefined : `task_id mismatch: expected ${request.task.id}`,
			result.run_id === request.run_id ? undefined : `run_id mismatch: expected ${request.run_id}`,
			result.worker_id === workerId ? undefined : `worker_id mismatch: expected ${workerId}`,
			result.model_identity.requested_model === requestedModel
				? undefined
				: `requested_model mismatch: expected ${requestedModel}`,
			result.lease_epoch === request.protocol.lease_epoch
				? undefined
				: `lease_epoch mismatch: expected ${request.protocol.lease_epoch}`,
		].filter((error): error is string => error !== undefined);
		if (identityErrors.length === 0) return ensureWorkReceipt(result);
		return failureResult(
			request,
			workerId,
			new Error(identityErrors.join("; ")),
			"worker result identity mismatch",
			requestedModel,
		);
	}
	return failureResult(
		request,
		workerId,
		new Error(validation.errors.join("; ")),
		"worker adapter returned malformed Result Contract",
		requestedModel,
	);
}

function blockedCommandReason(action: "ask_user" | "block", reasons: readonly string[]): string {
	return `${action}: ${reasons.join("; ")}`;
}

function recordLifecycleResult(evidence: string[], result: LifecycleHookRunResult): void {
	evidence.push(...result.evidence, ...result.warnings.map((warning) => `hook-warning:${warning}`));
}

export class PersonalPiPipeline {
	readonly stateStore: PersistentStateStore;
	private readonly leaseManager: LeaseManager;
	private readonly evidenceCollector: EvidenceCollector;
	private readonly verificationEngine: VerificationEngine;
	private readonly acceptanceGate: AcceptanceGate;
	private readonly loopBudgetController: LoopBudgetController;
	private readonly artifactStore: ArtifactStore;
	private readonly toolGateway: ToolGateway;

	constructor(options: PersonalPiPipelineOptions = {}) {
		this.stateStore = options.state_store ?? new PersistentStateStore();
		this.leaseManager = options.lease_manager ?? new LeaseManager(this.stateStore);
		this.evidenceCollector = options.evidence_collector ?? new EvidenceCollector();
		this.verificationEngine = options.verification_engine ?? new VerificationEngine();
		this.acceptanceGate = options.acceptance_gate ?? new AcceptanceGate();
		this.loopBudgetController = new LoopBudgetController(this.stateStore);
		this.artifactStore = options.artifact_store ?? new ArtifactStore(this.stateStore.artifactStoreRootPath());
		this.toolGateway = options.tool_gateway ?? new ToolGateway({ artifact_store: this.artifactStore });
	}

	private persistMasterHandoff(input: {
		task: TaskRecord;
		result: ResultContract;
		git_sha: string;
		plan_assessment: ArchitectureCommercialAssessment;
		evidence_refs?: readonly string[];
		verification_status?: VerificationRecord["status"];
		verification_reasons?: readonly string[];
		verification_id?: string;
		acceptance?: AcceptanceRecord;
	}): MasterHandoffReceipt {
		const normalizedResult = ensureWorkReceipt(input.result);
		if (!normalizedResult.work_receipt) throw new Error("terminal Run is missing a Work Receipt");
		const acceptance =
			input.task.state === "DONE" && input.acceptance
				? "PASS"
				: input.task.state === "FAILED" || input.verification_status === "FAIL"
					? "FAIL"
					: "UNKNOWN";
		const nextAction =
			input.task.state === "DONE"
				? "proceed_to_next_task"
				: input.task.state === "BLOCKED"
					? "resolve_blocker_or_request_human_review"
					: input.task.state === "FAILED"
						? "inspect_failure_artifacts_and_replan_or_reassign"
						: "review_terminal_task_state_before_continuing";
		const failure =
			input.task.state === "DONE"
				? undefined
				: createArchivedHandoffFailure({
						artifact_store: this.artifactStore,
						task_id: input.task.id,
						task_revision: input.task.task_revision,
						raw_failure_detail: {
							result_status: normalizedResult.status,
							result_summary: normalizedResult.summary,
							errors: normalizedResult.errors,
							requested_context: normalizedResult.requested_context ?? [],
							verification_status: input.verification_status ?? "UNKNOWN",
							verification_reasons: [...(input.verification_reasons ?? [])],
						},
						classification: "terminal_worker_failure",
					});
		return this.stateStore.saveHandoffReceipt(
			buildMasterHandoffReceipt({
				task_id: input.task.id,
				status: input.task.state as MasterHandoffReceipt["status"],
				git_sha: input.git_sha,
				acceptance,
				evidence_refs: input.evidence_refs ?? [],
				unresolved_risks: input.plan_assessment.open_risks,
				next_action: nextAction,
				work_receipt: normalizedResult.work_receipt,
				failure,
			}),
			{
				task_revision: input.task.task_revision,
				run_id: normalizedResult.run_id,
				verification_id: input.verification_id,
				acceptance_id: input.acceptance?.id,
			},
		);
	}

	probeDispatchCapability(task: TaskContract, roleProfile?: RoleProfile): DispatchDecision {
		const assessment = crossCheckAssessment(
			assessTask(task.objective, task.scope.files),
			task.objective,
			task.scope.files,
		);
		return createDispatchDecision(task, assessment, roleProfile);
	}

	async execute(request: PipelineRequest): Promise<PipelineExecution> {
		const at = request.at ?? new Date().toISOString();
		const requestedModel = request.worker.requested_model?.trim() || "unknown";
		const workerStatus = request.worker_status;
		const workerStatusValidation = validateWorkerStatus(workerStatus);
		if (!workerStatusValidation.valid)
			throw new PipelineStageError("DISPATCH", `invalid WorkerStatus: ${workerStatusValidation.errors.join("; ")}`);
		const tracer = new TraceRecorder(request.task.id, undefined, at);
		const lifecycleEvidence: string[] = [];
		if (
			request.requirement.user.length === 0 ||
			request.requirement.delivery.length === 0 ||
			request.requirement.acceptance.length === 0
		) {
			throw new PipelineStageError("REQUIREMENT", "Requirement Contract is incomplete");
		}
		if (
			request.command_runner &&
			request.task.verification.commands.length > 0 &&
			!this.toolGateway.hasDurableArchive()
		) {
			throw new PipelineStageError(
				"EVIDENCE",
				"ToolGateway raw archive is not durable; verification command execution is blocked",
				request.task.id,
			);
		}
		tracer.record("REQUIREMENT", "Requirement Contract accepted", at);
		if (request.lifecycle_hooks) {
			const started = await request.lifecycle_hooks.run("on_start", {
				task_id: request.task.id,
				cwd: request.task.execution.working_directory,
			});
			recordLifecycleResult(lifecycleEvidence, started);
			if (!started.allowed)
				throw new PipelineStageError(
					"REQUIREMENT",
					`on_start hook failed: ${started.failures.join("; ")}`,
					request.task.id,
				);
			if (
				request.previous_working_directory &&
				request.previous_working_directory !== request.task.execution.working_directory
			) {
				const cwdChanged = await request.lifecycle_hooks.run("on_cwd_change", {
					task_id: request.task.id,
					cwd: request.task.execution.working_directory,
				});
				recordLifecycleResult(lifecycleEvidence, cwdChanged);
				if (!cwdChanged.allowed)
					throw new PipelineStageError(
						"REQUIREMENT",
						`on_cwd_change hook failed: ${cwdChanged.failures.join("; ")}`,
						request.task.id,
					);
			}
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
		const dispatchExecution = request.dispatch_execution ?? directDispatchExecution(dispatch, assessment);
		tracer.record("DISPATCH", dispatch.mode, at, {
			worker_tier: dispatch.worker_tier,
			reasoning_depth: dispatch.reasoning_depth,
			requested_mode: dispatchExecution.requested_mode,
			effective_mode: dispatchExecution.effective_mode,
			executor_kind: dispatchExecution.executor_kind,
			planned_worker_count: dispatchExecution.planned_worker_count,
			effective_worker_count: dispatchExecution.effective_worker_count,
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
		const definitionOfReadyInput = request.definition_of_ready ?? {
			dependencies_ready: request.task.dependencies.length === 0,
			artifact_edges: [],
		};
		const definitionOfReady = evaluateDefinitionOfReady(
			request.task,
			definitionOfReadyInput.dependencies_ready,
			definitionOfReadyInput.artifact_edges,
			definitionOfReadyInput.artifact_store,
		);
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
		if (request.handoff_task_ids && request.handoff_task_ids.length > 0) {
			try {
				const handoffReceipts = request.handoff_task_ids.map((taskId) => {
					const receipt = this.stateStore.getHandoffReceipt(taskId);
					if (!receipt) throw new Error(`missing persisted Master handoff receipt for ${taskId}`);
					return receipt;
				});
				const remainingTokens = request.task.context.budget.max_input_tokens - (resolvedContext?.total_tokens ?? 0);
				const freshContext = new FreshContextBuilder().build(handoffReceipts, remainingTokens);
				const items = [...(resolvedContext?.items ?? []), ...freshContext.items];
				resolvedContext = {
					items,
					text: items.map((item) => item.content).join("\n"),
					total_tokens: items.reduce((sum, item) => sum + item.token_estimate, 0),
					cache_hit: false,
					omitted_optional: [...(resolvedContext?.omitted_optional ?? [])],
					manifest_digest: createHash("sha256")
						.update(JSON.stringify(items.map((item) => item.digest)))
						.digest("hex"),
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
				throw new PipelineStageError("DOR", reason, task.id);
			}
		}

		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "READY", "Definition of Ready passed", at),
		);
		if (workerStatus.worker_capability === "unavailable") {
			this.stateStore.addDispatch({
				id: randomUUID(),
				task_id: task.id,
				worker_id: request.worker.worker_id,
				requested_mode: dispatchExecution.requested_mode,
				effective_mode: "single",
				executor_kind: dispatchExecution.executor_kind,
				planned_worker_count: dispatchExecution.planned_worker_count,
				effective_worker_count: 0,
				degrade_reason: dispatchExecution.degrade_reason ?? "worker capability unavailable",
				worker_status: structuredClone(workerStatus),
				requested_model: requestedModel,
				created_at: at,
			});
			const reason = "Worker capability unavailable; root-only degraded delivery requires an explicit root executor";
			task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
			tracer.record("WORKER", `${request.worker.worker_id}:unavailable/root_only/degraded`, at);
			tracer.record("RUN", "blocked before Lease/Run creation", at);
			tracer.finish("BLOCKED", at);
			tracer.setGraphEfficiencyMetrics(computeGraphEfficiencyMetrics(tracer.snapshot()));
			this.stateStore.addTrace(tracer.snapshot());
			throw new PipelineStageError("WORKER", reason, task.id);
		}
		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "RUNNING", "dispatch policy accepted", at),
		);
		tracer.record("DOR", "Definition of Ready passed", at);
		tracer.record("WORKER", request.worker.worker_id, at, {
			graph_width: 1,
			graph_depth: 1,
			active_workers: 1,
		});
		let run!: RunRecord;
		let lease!: Lease;
		let workerRequest!: WorkerProtocolRequest;
		let result!: ResultContract;
		let dispatchRecord!: DispatchRecord;
		let workerToolResults: ToolResultEnvelope[] = [];
		let suppressOptionalContext = false;
		const workerContextLimit =
			request.worker.context_limit &&
			Number.isFinite(request.worker.context_limit) &&
			request.worker.context_limit > 0
				? request.worker.context_limit
				: request.task.context.budget.max_input_tokens;
		const taskTokenLimit = request.task.loop_budget
			? request.task.loop_budget.max_input_tokens + request.task.loop_budget.max_output_tokens
			: request.task.context.budget.max_input_tokens;

		while (true) {
			try {
				this.loopBudgetController.beforeRun(request.task);
			} catch (error) {
				const reason = error instanceof LoopBudgetExhaustedError ? error.message : String(error);
				task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
				const decision = createDecisionRecord("loop_budget", "BLOCKED", reason, [task.id], at);
				this.stateStore.addDecision(decision);
				tracer.addDecision(decision);
				tracer.record("RUN", "blocked before Run creation", at);
				tracer.setMetrics({
					token_per_task: 0,
					cache_hit_rate: 0,
					worker_tier: request.task.execution.worker_tier,
				});
				tracer.finish("BLOCKED", at);
				tracer.setGraphEfficiencyMetrics(computeGraphEfficiencyMetrics(tracer.snapshot()));
				this.stateStore.addTrace(tracer.snapshot());
				throw new PipelineStageError("RUN", reason, task.id);
			}

			lease = this.leaseManager.acquire(task.id, request.worker.worker_id, at);
			run = this.stateStore.createRun(task.id, request.worker.worker_id, lease.lease_epoch, {
				worker_status: workerStatus,
				model_identity: createModelIdentity(requestedModel),
				started_at: at,
				workspace_commit_hash: request.snapshot.commit_hash,
			});
			tracer.attachRun(run.id);
			tracer.record("RUN", "Run created", at);
			dispatchRecord = {
				id: randomUUID(),
				task_id: task.id,
				worker_id: request.worker.worker_id,
				lease_epoch: lease.lease_epoch,
				requested_mode: dispatchExecution.requested_mode,
				effective_mode: dispatchExecution.effective_mode,
				executor_kind: dispatchExecution.executor_kind,
				planned_worker_count: dispatchExecution.planned_worker_count,
				effective_worker_count: dispatchExecution.effective_worker_count,
				degrade_reason: dispatchExecution.degrade_reason,
				overlap_proof_ref: dispatchExecution.overlap_proof_ref,
				worker_status: structuredClone(workerStatus),
				requested_model: requestedModel,
				created_at: at,
			};
			this.stateStore.addDispatch(dispatchRecord);

			const previousBudget = this.stateStore.getContextBudgetState(task.id);
			let contextBudget = createContextBudgetState({
				task_id: task.id,
				run_id: run.id,
				context_limit: workerContextLimit,
				layer_token_limits: {
					tool_output: request.task.context.budget.max_input_tokens,
					prompt: workerContextLimit,
					run: workerContextLimit,
					task: taskTokenLimit,
				},
				updated_at: at,
			});
			if (previousBudget) {
				contextBudget = updateContextBudgetLayer(contextBudget, "task", previousBudget.layers.task.metrics, at);
			}
			const injectedBytes = Buffer.byteLength(resolvedContext?.text ?? "", "utf8");
			for (const layer of ["prompt", "run"] as const) {
				contextBudget = updateContextBudgetLayer(
					contextBudget,
					layer,
					{ ...zeroContextBudgetMetrics(), injected_context_bytes: injectedBytes },
					at,
				);
			}
			this.stateStore.saveContextBudgetState(contextBudget);

			const protocol = createProtocolEnvelope(task, lease.lease_epoch, calculatePlanDigest(planAssessment));
			workerRequest = {
				task: request.task,
				protocol,
				role_profile: request.role_profile,
				requested_actions: request.requested_actions,
				permission_request: request.permission_request,
				run_id: run.id,
				resolved_context: resolvedContext,
				tool_artifact_root: this.artifactStore.storageRootPath(),
			};
			try {
				this.loopBudgetController.beforeModelCall(request.task);
				const controls: WorkerExecutionControls = {
					beforeModelCall: () => this.loopBudgetController.beforeModelCall(request.task),
					beforeToolCall: () => this.loopBudgetController.beforeToolCall(request.task),
					observePromptViewAudit: (audit) => tracer.addPromptViewAudit(audit),
					observeBackpressure: (observation) => {
						if (observation.action !== "QUEUE" && observation.wait_ms <= 0) return;
						tracer.record("WORKER", `backpressure:${observation.scope}:${observation.source}`, at, {
							backpressure_scope: observation.scope,
							backpressure_source: observation.source,
							backpressure_wait_ms: observation.wait_ms,
							backpressure_action: observation.action,
						});
					},
					observeContextUsage: (observation) => {
						if (!contextBudgetMetricsAreValid(observation.metrics)) {
							throw new ContextRebuildRequiredError(
								observation.layer,
								`context accounting unavailable for ${observation.layer}`,
							);
						}
						const current = this.stateStore.getContextBudgetState(task.id);
						if (!current || current.run_id !== run.id)
							throw new ContextRebuildRequiredError(observation.layer, "context budget state is stale");
						const previousRunMetrics = current.layers.run.metrics;
						const previousTaskWatermark = current.layers.task.watermark;
						let next = updateContextBudgetLayer(current, observation.layer, observation.metrics, at);
						if (observation.layer === "run") {
							const taskMetrics: ContextBudgetMetrics = {
								tokens:
									next.layers.task.metrics.tokens +
									Math.max(0, observation.metrics.tokens - previousRunMetrics.tokens),
								tool_calls:
									next.layers.task.metrics.tool_calls +
									Math.max(0, observation.metrics.tool_calls - previousRunMetrics.tool_calls),
								raw_log_bytes:
									next.layers.task.metrics.raw_log_bytes +
									Math.max(0, observation.metrics.raw_log_bytes - previousRunMetrics.raw_log_bytes),
								injected_context_bytes:
									next.layers.task.metrics.injected_context_bytes +
									Math.max(
										0,
										observation.metrics.injected_context_bytes - previousRunMetrics.injected_context_bytes,
									),
								duplicate_ratio: Math.max(
									next.layers.task.metrics.duplicate_ratio,
									observation.metrics.duplicate_ratio,
								),
								state_growth_bytes:
									next.layers.task.metrics.state_growth_bytes +
									Math.max(0, observation.metrics.state_growth_bytes - previousRunMetrics.state_growth_bytes),
								elapsed_ms:
									next.layers.task.metrics.elapsed_ms +
									Math.max(0, observation.metrics.elapsed_ms - previousRunMetrics.elapsed_ms),
								retries: Math.max(next.layers.task.metrics.retries, run.attempt - 1),
							};
							next = updateContextBudgetLayer(next, "task", taskMetrics, at);
						}
						this.stateStore.saveContextBudgetState(next);
						const observedWatermark = next.layers[observation.layer].watermark;
						const taskWatermark = next.layers.task.watermark;
						if (observedWatermark === "WARNING" || taskWatermark === "WARNING") suppressOptionalContext = true;
						if (observedWatermark === "HARD" || taskWatermark === "HARD") {
							const usage = this.loopBudgetController.usage(task.id);
							throw new LoopBudgetExhaustedError({
								allowed: false,
								projected: usage,
								exhausted: ["max_input_tokens"],
								reasons: ["loop budget exhausted: context HARD watermark"],
							});
						}
						if (
							observedWatermark === "REBUILD" ||
							(taskWatermark === "REBUILD" && previousTaskWatermark !== "REBUILD")
						)
							throw new ContextRebuildRequiredError(observation.layer);
						return observedWatermark;
					},
				};
				const workerResult = await request.worker.execute(workerRequest, controls);
				workerToolResults = request.worker.getToolResults?.() ?? [];
				const trustedResult = {
					...workerResult,
					model_identity: request.worker.getModelIdentity?.() ?? createModelIdentity(requestedModel),
				};
				result = normalizeResult(workerRequest, trustedResult, request.worker.worker_id, requestedModel);
				break;
			} catch (error) {
				if (error instanceof ContextRebuildRequiredError) {
					workerToolResults = request.worker.getToolResults?.() ?? [];
					this.stateStore.closeRunForContextRebuild(run.id, at);
					this.leaseManager.release(lease);
					const budgetState = this.stateStore.getContextBudgetState(task.id);
					if (!budgetState) throw new PipelineStageError("RUN", "context budget state missing", task.id);
					const budgetArtifact = this.artifactStore.put(
						"context_budget_state",
						1,
						JSON.parse(JSON.stringify(budgetState)),
						task.id,
						task.task_revision,
					);
					const report = new ContextCompactionPolicy().buildReport({
						state: this.stateStore.read(),
						task_ids: [task.id],
						anchor_task_id: task.id,
						tool_results: workerToolResults,
						next_action: "continue same Task with Fresh Context",
						git_sha: request.snapshot.commit_hash,
						artifact_refs: [budgetArtifact.digest],
					});
					const reportArtifact = this.artifactStore.put(
						"context_compaction_report",
						1,
						JSON.parse(JSON.stringify(report)),
						task.id,
						task.task_revision,
					);
					let freshRequired: ResolvedContext | undefined;
					if (request.context_resolver) {
						freshRequired = request.context_resolver.resolve(
							{ ...request.task.context, optional: [] },
							{ reuse_cache: false },
						);
					}
					let freshItems = [...(freshRequired?.items ?? [])];
					let freshTokens = freshItems.reduce((sum, item) => sum + item.token_estimate, 0);
					if (request.handoff_task_ids && request.handoff_task_ids.length > 0) {
						const receipts = request.handoff_task_ids.map((taskId) => {
							const receipt = this.stateStore.getHandoffReceipt(taskId);
							if (!receipt) throw new Error(`missing persisted Master handoff receipt for ${taskId}`);
							return receipt;
						});
						const receiptContext = new FreshContextBuilder().build(
							receipts,
							Math.max(1, request.task.context.budget.max_input_tokens - freshTokens),
						);
						freshItems = [...freshItems, ...receiptContext.items];
						freshTokens += receiptContext.total_tokens;
					}
					const remaining = request.task.context.budget.max_input_tokens - freshTokens;
					if (remaining < 1) {
						throw new LoopBudgetExhaustedError({
							allowed: false,
							projected: this.loopBudgetController.usage(task.id),
							exhausted: ["max_input_tokens"],
							reasons: ["loop budget exhausted: no room for Fresh Context rebuild state"],
						});
					}
					const reportContent = JSON.stringify(report);
					if (Math.max(1, Math.ceil(reportContent.length / 4)) > remaining) {
						throw new LoopBudgetExhaustedError({
							allowed: false,
							projected: this.loopBudgetController.usage(task.id),
							exhausted: ["max_input_tokens"],
							reasons: ["loop budget exhausted: structured Fresh Context report exceeds remaining budget"],
						});
					}
					freshItems.push({
						digest: reportArtifact.digest,
						content: reportContent,
						token_estimate: Math.max(1, Math.ceil(reportContent.length / 4)),
					});
					resolvedContext = {
						items: freshItems,
						text: freshItems.map((item) => item.content).join("\n\n"),
						total_tokens: freshItems.reduce((sum, item) => sum + item.token_estimate, 0),
						cache_hit: false,
						omitted_optional: suppressOptionalContext ? [...request.task.context.optional] : [],
						manifest_digest: createHash("sha256")
							.update(JSON.stringify(freshItems.map((item) => item.digest)))
							.digest("hex"),
					};
					continue;
				}
				if (error instanceof LoopBudgetExhaustedError || error instanceof LoopBudgetMissingError) {
					const reason = error.message;
					const blockedResult = failureResult(
						workerRequest,
						request.worker.worker_id,
						error,
						undefined,
						requestedModel,
					);
					this.stateStore.saveResult(blockedResult, at);
					task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
					this.persistMasterHandoff({
						task,
						result: blockedResult,
						git_sha: request.snapshot.commit_hash,
						plan_assessment: planAssessment,
					});
					const decision = createDecisionRecord("loop_budget", "BLOCKED", reason, [task.id, run.id], at);
					this.stateStore.addDecision(decision);
					tracer.addDecision(decision);
					tracer.record("RESULT", "blocked before model call", at);
					tracer.record("ACCEPTANCE", "loop budget exhaustion requires human review", at);
					this.leaseManager.release(lease);
					tracer.setMetrics({
						token_per_task: resolvedContext?.total_tokens ?? 0,
						cache_hit_rate: resolvedContext?.cache_hit ? 1 : 0,
						worker_tier: request.task.execution.worker_tier,
					});
					tracer.finish("BLOCKED", at);
					tracer.setGraphEfficiencyMetrics(computeGraphEfficiencyMetrics(tracer.snapshot()));
					this.stateStore.addTrace(tracer.snapshot());
					throw new PipelineStageError("RUN", reason, task.id);
				}
				result = failureResult(workerRequest, request.worker.worker_id, error, undefined, requestedModel);
				break;
			}
		}
		if (!this.leaseManager.acceptResult(lease).accepted) {
			throw new PipelineStageError("RESULT", "Worker result rejected by fencing lease", task.id);
		}
		this.stateStore.saveResult(result, at);
		tracer.record("RESULT", result.status, at, {
			useful_work: result.work_receipt && !result.work_receipt.no_op ? 1 : 0,
			no_op: result.work_receipt?.no_op ?? false,
		});

		const verifierCommands: CommandEvidence[] = [];
		const verifierToolResults: ToolResultEnvelope[] = workerToolResults.map((toolResult) =>
			structuredClone(toolResult),
		);
		const commandRiskClassifier = request.command_risk_classifier ?? new CommandRiskClassifier();
		if (request.command_runner) {
			for (const command of request.task.verification.commands) {
				try {
					this.loopBudgetController.beforeToolCall(request.task);
				} catch (error) {
					if (error instanceof LoopBudgetExhaustedError || error instanceof LoopBudgetMissingError) {
						const reason = error.message;
						const blockedResult = failureResult(workerRequest, request.worker.worker_id, error);
						this.stateStore.saveResult(blockedResult, at);
						task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
						this.persistMasterHandoff({
							task,
							result: blockedResult,
							git_sha: request.snapshot.commit_hash,
							plan_assessment: planAssessment,
						});
						const decision = createDecisionRecord("loop_budget", "BLOCKED", reason, [task.id, run.id], at);
						this.stateStore.addDecision(decision);
						tracer.addDecision(decision);
						tracer.record("EVIDENCE", "blocked before verification tool call", at);
						this.leaseManager.release(lease);
						tracer.setMetrics({
							token_per_task: resolvedContext?.total_tokens ?? 0,
							cache_hit_rate: resolvedContext?.cache_hit ? 1 : 0,
							worker_tier: request.task.execution.worker_tier,
						});
						tracer.finish("BLOCKED", at);
						tracer.setGraphEfficiencyMetrics(computeGraphEfficiencyMetrics(tracer.snapshot()));
						this.stateStore.addTrace(tracer.snapshot());
						throw new PipelineStageError("EVIDENCE", reason, task.id);
					}
					throw error;
				}
				const authorization = commandRiskClassifier
					? authorizeCommand(request.task, command, commandRiskClassifier, {
							approval: request.command_approval,
							now: at,
						})
					: undefined;
				if (authorization)
					lifecycleEvidence.push(`command-risk:${authorization.classification.risk}:${authorization.action}`);
				let commandEvidence: CommandEvidence | undefined;
				let toolEnvelope: ToolResultEnvelope | undefined;
				let toolExecuted = false;
				if (request.lifecycle_hooks) {
					const preTool = await request.lifecycle_hooks.run("pre_tool_use", {
						task_id: request.task.id,
						run_id: run.id,
						cwd: request.task.execution.working_directory,
						tool: {
							name: "verification",
							command,
							risk: authorization?.classification.risk ?? "risky",
						},
					});
					recordLifecycleResult(lifecycleEvidence, preTool);
					if (!preTool.allowed) {
						const blocked = this.toolGateway.createBlockedCommand({
							command,
							task_id: task.id,
							task_revision: task.task_revision,
							reason: blockedCommandReason("block", preTool.failures),
							exit_code: 126,
							captured_at: at,
						});
						toolEnvelope = blocked.envelope;
						commandEvidence = blocked.command_evidence;
					}
				}
				if (!commandEvidence && authorization && authorization.action !== "auto_run") {
					const blocked = this.toolGateway.createBlockedCommand({
						command,
						task_id: task.id,
						task_revision: task.task_revision,
						reason: blockedCommandReason(authorization.action, authorization.reasons),
						exit_code: authorization.action === "block" ? 126 : 125,
						captured_at: at,
					});
					toolEnvelope = blocked.envelope;
					commandEvidence = blocked.command_evidence;
				}
				if (!commandEvidence) {
					const gatewayExecution = await this.toolGateway.executeCommand({
						command,
						task_id: task.id,
						task_revision: task.task_revision,
						runner: request.command_runner,
						captured_at: at,
					});
					toolEnvelope = gatewayExecution.envelope;
					commandEvidence = gatewayExecution.command_evidence;
					toolExecuted = commandEvidence !== undefined;
				}
				if (commandEvidence && toolExecuted && request.lifecycle_hooks) {
					const postTool = await request.lifecycle_hooks.run("post_tool_use", {
						task_id: request.task.id,
						run_id: run.id,
						cwd: request.task.execution.working_directory,
						tool: {
							name: "verification",
							command,
							risk: authorization?.classification.risk ?? "risky",
						},
						code_changed: result.changed_files.length > 0,
						changed_files: result.changed_files,
					});
					recordLifecycleResult(lifecycleEvidence, postTool);
					if (!postTool.allowed) {
						commandEvidence = {
							...commandEvidence,
							exit_code: commandEvidence.exit_code === 0 ? 126 : commandEvidence.exit_code,
							stderr: [commandEvidence.stderr, ...postTool.failures].filter(Boolean).join("; "),
						};
						if (toolEnvelope)
							toolEnvelope = this.toolGateway.markBlocked(
								toolEnvelope,
								commandEvidence.stderr,
								commandEvidence.exit_code,
							);
					}
				}
				if (toolEnvelope) verifierToolResults.push(toolEnvelope);
				if (commandEvidence) verifierCommands.push(commandEvidence);
			}
		}

		const verificationSnapshot = request.workspace_snapshot_provider?.(result.artifacts) ?? request.snapshot;
		const evidenceTypes = [
			...new Set([
				...result.evidence,
				...lifecycleEvidence,
				...(verifierToolResults.length > 0 ? ["tool_result_envelope"] : []),
				...(verifierCommands.some((command) => command.exit_code === 0) ? ["independent_command"] : []),
			]),
		];
		const hasBrowserOrContainerEvidence = evidenceTypes.some((type) =>
			new Set([
				"browser_e2e",
				"network_trace",
				"screenshot",
				"video",
				"console_log",
				"request_trace",
				"container_verification",
			]).has(type),
		);
		const browserOrContainerEvidence = hasBrowserOrContainerEvidence ? [...result.artifacts] : [];
		const deliveryEvidencePackage = createDeliveryEvidencePackage({
			baseline_commit: request.baseline_commit,
			task_revision: task.task_revision,
			snapshot: verificationSnapshot,
			changed_files: result.changed_files,
			commands: verifierCommands,
			test_output_summary: [
				`worker_status=${result.status}`,
				`verification_commands=${verifierCommands.length}`,
				`failed_commands=${verifierCommands.filter((command) => command.exit_code !== 0).length}`,
			].join("; "),
			browser_or_container_verification: browserOrContainerEvidence,
			unfinished_items: [...result.errors, ...(result.requested_context ?? [])],
			provider_mode: request.provider_mode,
		});
		const evidence = this.evidenceCollector.collect({
			task_id: task.id,
			run_id: run.id,
			changed_files: result.changed_files,
			commands: verifierCommands,
			tool_results: verifierToolResults,
			stdout: result.summary,
			stderr: result.errors.join("; "),
			artifacts: [...result.artifacts, ...verifierToolResults.map((toolResult) => toolResult.artifact_id)],
			evidence_types: evidenceTypes,
			captured_at: at,
			delivery_evidence_package: deliveryEvidencePackage,
		});
		this.stateStore.saveEvidence(evidence);
		tracer.record("EVIDENCE", "Evidence recorded", at);
		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "VERIFYING", "Result and Evidence recorded", at),
		);

		const verificationRequest: VerificationRequest = {
			task,
			evidence,
			snapshot: verificationSnapshot,
			currentSnapshot: request.current_snapshot ?? verificationSnapshot,
			recipeRegistry: request.recipe_registry,
			workerStatus: result.status,
			result: sanitizeResultForVerification(result),
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
		tracer.record("VERIFICATION", verification.status, at, { status: verification.status });

		let acceptance: AcceptanceRecord | undefined;
		if (verification.status === "PASS" && result.status === "success") {
			try {
				const acceptanceSnapshot =
					request.workspace_snapshot_provider?.(result.artifacts) ??
					request.current_snapshot ??
					verificationSnapshot;
				const accepted = this.stateStore.acceptTask(
					task.id,
					verification.id,
					result.run_id,
					acceptanceSnapshot,
					at,
					this.acceptanceGate,
				);
				task = accepted.task;
				acceptance = accepted.acceptance;
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
		if (task.state !== "DONE") this.stateStore.updateTask(task);
		if (task.state !== "DONE") {
			this.stateStore.markRunFailed(
				run.id,
				verification.reasons.join("; ") || `verification ${verification.status}`,
				at,
			);
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
		const handoff = this.persistMasterHandoff({
			task,
			result,
			git_sha: verification.commit_hash,
			plan_assessment: planAssessment,
			evidence_refs: [evidence.id],
			verification_status: verification.status,
			verification_reasons: verification.reasons,
			verification_id: verification.id,
			acceptance,
		});
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
		});
		tracer.finish(task.state === "DONE" ? "DONE" : task.state === "BLOCKED" ? "BLOCKED" : "FAILED", at);
		tracer.setGraphEfficiencyMetrics(computeGraphEfficiencyMetrics(tracer.snapshot()));
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
			dispatch_record:
				this.stateStore.read().dispatches.find((candidate) => candidate.id === dispatchRecord.id) ?? dispatchRecord,
			decisions: [
				...decisions,
				...this.stateStore.read().decisions.filter((decision) => decision.inputs.includes(verification.id)),
			],
			resolved_context: resolvedContext,
			trace,
			handoff,
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
