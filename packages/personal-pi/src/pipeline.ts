import { randomUUID } from "node:crypto";
import { authorizeCommand, type CommandApproval, CommandRiskClassifier } from "./command-risk.ts";
import { type ContextResolver, evaluateContextReadiness } from "./context.ts";
import { EvidenceCollector } from "./evidence.ts";
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
import { ensureWorkReceipt, validateResultContract } from "./result.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import { computeGraphEfficiencyMetrics, createRegressionCase, TraceRecorder } from "./trace.ts";
import type {
	ArchitectureCommercialAssessment,
	CommandEvidence,
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
	WorkerExecutionControls,
	WorkerProtocolRequest,
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

function failureResult(
	request: WorkerProtocolRequest,
	workerId: string,
	error: unknown,
	summary = "worker adapter threw before returning a Result Contract",
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
	if (validation.valid) {
		const identityErrors = [
			result.task_id === request.task.id ? undefined : `task_id mismatch: expected ${request.task.id}`,
			result.run_id === request.run_id ? undefined : `run_id mismatch: expected ${request.run_id}`,
			result.worker_id === workerId ? undefined : `worker_id mismatch: expected ${workerId}`,
			result.lease_epoch === request.protocol.lease_epoch
				? undefined
				: `lease_epoch mismatch: expected ${request.protocol.lease_epoch}`,
		].filter((error): error is string => error !== undefined);
		if (identityErrors.length === 0) return ensureWorkReceipt(result);
		return failureResult(request, workerId, new Error(identityErrors.join("; ")), "worker result identity mismatch");
	}
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

function blockedCommandEvidence(
	command: string,
	action: "ask_user" | "block",
	reasons: readonly string[],
): CommandEvidence {
	return {
		command,
		exit_code: action === "block" ? 126 : 125,
		stdout: "",
		stderr: `${action}: ${reasons.join("; ")}`,
	};
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

	constructor(options: PersonalPiPipelineOptions = {}) {
		this.stateStore = options.state_store ?? new PersistentStateStore();
		this.leaseManager = options.lease_manager ?? new LeaseManager(this.stateStore);
		this.evidenceCollector = options.evidence_collector ?? new EvidenceCollector();
		this.verificationEngine = options.verification_engine ?? new VerificationEngine();
		this.acceptanceGate = options.acceptance_gate ?? new AcceptanceGate();
		this.loopBudgetController = new LoopBudgetController(this.stateStore);
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
		const tracer = new TraceRecorder(request.task.id, undefined, at);
		const lifecycleEvidence: string[] = [];
		if (
			request.requirement.user.length === 0 ||
			request.requirement.delivery.length === 0 ||
			request.requirement.acceptance.length === 0
		) {
			throw new PipelineStageError("REQUIREMENT", "Requirement Contract is incomplete");
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
		tracer.record("DISPATCH", dispatch.mode, at, {
			worker_tier: dispatch.worker_tier,
			reasoning_depth: dispatch.reasoning_depth,
			graph_width: 1,
			graph_depth: 1,
			active_workers: 1,
			handoff_count: 0,
			replan_count: 0,
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
			this.loopBudgetController.beforeModelCall(request.task);
			const controls: WorkerExecutionControls = {
				beforeModelCall: () => this.loopBudgetController.beforeModelCall(request.task),
				beforeToolCall: () => this.loopBudgetController.beforeToolCall(request.task),
			};
			result = normalizeResult(
				workerRequest,
				await request.worker.execute(workerRequest, controls),
				request.worker.worker_id,
			);
		} catch (error) {
			if (error instanceof LoopBudgetExhaustedError || error instanceof LoopBudgetMissingError) {
				const reason = error.message;
				const blockedResult = failureResult(workerRequest, request.worker.worker_id, error);
				this.stateStore.saveResult(blockedResult, at);
				task = this.stateStore.updateTask(new TaskStateMachine().transition(task, "BLOCKED", reason, at));
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
			result = failureResult(workerRequest, request.worker.worker_id, error);
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
		const commandRiskClassifier =
			request.command_risk_classifier ?? (request.lifecycle_hooks ? new CommandRiskClassifier() : undefined);
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
					if (!preTool.allowed) commandEvidence = blockedCommandEvidence(command, "block", preTool.failures);
				}
				if (!commandEvidence && authorization && authorization.action !== "auto_run")
					commandEvidence = blockedCommandEvidence(command, authorization.action, authorization.reasons);
				if (!commandEvidence) {
					try {
						commandEvidence = await request.command_runner(command);
						toolExecuted = commandEvidence !== undefined;
					} catch {
						// 缺失的命令证据由 Verifier 记为 UNKNOWN；不把环境异常伪装成通过。
					}
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
					}
				}
				if (commandEvidence) verifierCommands.push(commandEvidence);
			}
		}

		const evidence = this.evidenceCollector.collect({
			task_id: task.id,
			run_id: run.id,
			changed_files: result.changed_files,
			commands: verifierCommands,
			stdout: result.summary,
			stderr: result.errors.join("; "),
			artifacts: result.artifacts,
			evidence_types: [
				...new Set([
					...result.evidence,
					...lifecycleEvidence,
					...(verifierCommands.some((command) => command.exit_code === 0) ? ["independent_command"] : []),
				]),
			],
			captured_at: at,
		});
		this.stateStore.saveEvidence(evidence);
		tracer.record("EVIDENCE", "Evidence recorded", at);
		task = this.stateStore.updateTask(
			new TaskStateMachine().transition(task, "VERIFYING", "Result and Evidence recorded", at),
		);

		const verificationSnapshot = request.workspace_snapshot_provider?.(result.artifacts) ?? request.snapshot;
		const verificationRequest: VerificationRequest = {
			task,
			evidence,
			snapshot: verificationSnapshot,
			currentSnapshot: request.current_snapshot ?? verificationSnapshot,
			commandRunner: undefined,
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

		if (verification.status === "PASS" && result.status === "success") {
			try {
				const acceptanceSnapshot =
					request.workspace_snapshot_provider?.(result.artifacts) ??
					request.current_snapshot ??
					verificationSnapshot;
				task = this.acceptanceGate.markDone(task, verification, acceptanceSnapshot, result);
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
