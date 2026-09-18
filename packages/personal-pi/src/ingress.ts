import { LoopBudgetController } from "./loop-budget.ts";
import type { PersistentStateStore } from "./persistence.ts";
import { PersonalPiPipeline, type PipelineExecution, type PipelineRequest } from "./pipeline.ts";
import type { DefinitionOfReadyInput } from "./readiness.ts";
import { evaluateDefinitionOfReady } from "./readiness.ts";
import { validateTaskContract } from "./schema.ts";
import type {
	JsonValue,
	LoopBudget,
	RetryPolicy,
	TaskApproval,
	TaskContext,
	TaskContract,
	TaskExecution,
	TaskPermissions,
	TaskScope,
	TaskVerification,
} from "./types.ts";
import type { WorkerAdapter } from "./worker.ts";

export interface TaskIngressRequest {
	id: string;
	title: string;
	objective: string;
	type?: string;
	task_revision?: number;
	graph_revision?: number;
	requirements?: string[];
	constraints?: string[];
	scope?: TaskScope;
	role_profile_ref?: string;
	inputs?: Record<string, JsonValue>;
	data_sources?: string[];
	data_references?: string[];
	permissions?: {
		filesystem?: Partial<TaskPermissions["filesystem"]>;
		shell?: Partial<TaskPermissions["shell"]>;
		network?: TaskPermissions["network"];
		credentials?: TaskPermissions["credentials"];
		git?: TaskPermissions["git"];
	};
	execution?: Partial<TaskExecution>;
	dependencies?: string[];
	artifact_dependencies?: string[];
	expected_outputs?: string[];
	acceptance_criteria?: string[];
	verification?: Partial<TaskVerification>;
	context?: Omit<Partial<TaskContext>, "budget"> & {
		budget?: Partial<TaskContext["budget"]>;
	};
	risk?: TaskContract["risk"];
	priority?: TaskContract["priority"];
	timeout?: number;
	retry_policy?: Partial<RetryPolicy>;
	loop_budget?: LoopBudget;
	approval?: TaskApproval;
}

const DEFAULT_LOOP_BUDGET: LoopBudget = {
	max_attempts: 1,
	max_model_calls: 1,
	max_tool_calls: 0,
	max_handoffs: 0,
	max_elapsed_ms: 60_000,
	max_input_tokens: 2_000,
	max_output_tokens: 2_000,
	max_cost_usd: 0,
	max_state_growth_bytes: 0,
	on_exhaustion: { action: "BLOCKED", escalation: "human" },
};

export interface TaskCompiler {
	compile(request: TaskIngressRequest): TaskContract;
}

export class DeterministicTaskCompiler implements TaskCompiler {
	compile(request: TaskIngressRequest): TaskContract {
		return {
			id: request.id,
			schema_version: 2,
			task_revision: request.task_revision ?? 1,
			graph_revision: request.graph_revision ?? 0,
			type: request.type ?? "general",
			title: request.title,
			objective: request.objective,
			requirements: [...(request.requirements ?? [])],
			constraints: [...(request.constraints ?? [])],
			scope: { files: [...(request.scope?.files ?? [])] },
			...(request.role_profile_ref !== undefined ? { role_profile_ref: request.role_profile_ref } : {}),
			inputs: structuredClone(request.inputs ?? {}),
			data_sources: [...(request.data_sources ?? [])],
			data_references: [...(request.data_references ?? [])],
			permissions: {
				filesystem: {
					read: [...(request.permissions?.filesystem?.read ?? [])],
					write: [...(request.permissions?.filesystem?.write ?? [])],
				},
				shell: { allowed: [...(request.permissions?.shell?.allowed ?? [])] },
				network: request.permissions?.network ?? "deny",
				credentials: request.permissions?.credentials ?? "deny",
				...(request.permissions?.git ? { git: { allowed: [...request.permissions.git.allowed] } } : {}),
			},
			execution: {
				worker_type: request.execution?.worker_type ?? "pi",
				worker_tier: request.execution?.worker_tier ?? "cheap",
				reasoning_depth: request.execution?.reasoning_depth ?? "low",
				capability_tags: [...(request.execution?.capability_tags ?? [])],
				mode: request.execution?.mode ?? "single",
				working_directory: request.execution?.working_directory ?? ".",
				allowed_tools: [...(request.execution?.allowed_tools ?? [])],
				...(request.execution?.idempotency_key !== undefined
					? { idempotency_key: request.execution.idempotency_key }
					: {}),
			},
			dependencies: [...(request.dependencies ?? [])],
			artifact_dependencies: [...(request.artifact_dependencies ?? [])],
			expected_outputs: [...(request.expected_outputs ?? [])],
			acceptance_criteria: [...(request.acceptance_criteria ?? [])],
			verification: {
				strategy: request.verification?.strategy ?? "manual",
				commands: [...(request.verification?.commands ?? [])],
				checks: [...(request.verification?.checks ?? [])],
				evidence_required: [...(request.verification?.evidence_required ?? [])],
				strength: request.verification?.strength ?? "none",
				...(request.verification?.recipe_ref !== undefined ? { recipe_ref: request.verification.recipe_ref } : {}),
			},
			context: {
				required: [...(request.context?.required ?? [])],
				optional: [...(request.context?.optional ?? [])],
				excluded: [...(request.context?.excluded ?? [])],
				budget: { max_input_tokens: request.context?.budget?.max_input_tokens ?? 2_000 },
			},
			risk: request.risk ?? "low",
			priority: request.priority ?? "P2",
			timeout: request.timeout ?? 30_000,
			retry_policy: {
				max_attempts: request.retry_policy?.max_attempts ?? 1,
				backoff: request.retry_policy?.backoff ?? 0,
			},
			loop_budget: structuredClone(request.loop_budget ?? DEFAULT_LOOP_BUDGET),
			approval: structuredClone(request.approval ?? { required: false }),
		};
	}
}

export interface IngressCapabilityProbes {
	dispatch(pipeline: PersonalPiPipeline, task: TaskContract, roleProfile: PipelineRequest["role_profile"]): void;
	state_write(store: PersistentStateStore): void;
	worker_execute(worker: WorkerAdapter): void;
	loop_budget(controller: LoopBudgetController, task: TaskContract): void;
}

const DEFAULT_CAPABILITY_PROBES: IngressCapabilityProbes = {
	dispatch(pipeline, task, roleProfile) {
		pipeline.probeDispatchCapability(task, roleProfile);
	},
	state_write(store) {
		store.probeWriteCapability();
	},
	worker_execute(worker) {
		if (!worker.worker_id || typeof worker.execute !== "function")
			throw new Error("worker execute capability is unavailable");
	},
	loop_budget(controller, task) {
		controller.probeAvailability(task);
	},
};

export type IngressReadinessStage =
	| "compiler"
	| "validation"
	| "definition_of_ready"
	| "dispatch"
	| "worker"
	| "budget"
	| "state";

export interface IngressReadinessFailure {
	stage: IngressReadinessStage;
	reasons: string[];
}

export interface IngressReadinessResult {
	ready: boolean;
	task?: TaskContract;
	failure?: IngressReadinessFailure;
}

export class IngressReadinessError extends Error {
	readonly stage: IngressReadinessStage;
	readonly reasons: string[];

	constructor(failure: IngressReadinessFailure) {
		super(`ingress readiness failed at ${failure.stage}: ${failure.reasons.join("; ")}`);
		this.name = "IngressReadinessError";
		this.stage = failure.stage;
		this.reasons = [...failure.reasons];
	}
}

export interface IngressGateRequest extends Omit<PipelineRequest, "task" | "definition_of_ready"> {
	ingress: TaskIngressRequest;
	readiness: DefinitionOfReadyInput;
}

export interface IngressGateOptions {
	pipeline?: PersonalPiPipeline;
	compiler?: TaskCompiler;
	probes?: Partial<IngressCapabilityProbes>;
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class IngressGate {
	private readonly pipeline: PersonalPiPipeline;
	private readonly compiler: TaskCompiler;
	private readonly probes: IngressCapabilityProbes;
	private readonly loopBudgetController: LoopBudgetController;

	constructor(options: IngressGateOptions = {}) {
		this.pipeline = options.pipeline ?? new PersonalPiPipeline();
		this.compiler = options.compiler ?? new DeterministicTaskCompiler();
		this.probes = { ...DEFAULT_CAPABILITY_PROBES, ...options.probes };
		this.loopBudgetController = new LoopBudgetController(this.pipeline.stateStore);
	}

	probe(request: IngressGateRequest): IngressReadinessResult {
		let task: TaskContract;
		try {
			task = this.compiler.compile(request.ingress);
		} catch (error) {
			return { ready: false, failure: { stage: "compiler", reasons: [reason(error)] } };
		}

		const validation = validateTaskContract(task);
		if (!validation.valid) {
			return { ready: false, task, failure: { stage: "validation", reasons: validation.errors } };
		}

		const definitionOfReady = evaluateDefinitionOfReady(
			task,
			request.readiness.dependencies_ready,
			request.readiness.artifact_edges,
			request.readiness.artifact_store,
		);
		if (!definitionOfReady.ready) {
			return {
				ready: false,
				task,
				failure: { stage: "definition_of_ready", reasons: definitionOfReady.reasons },
			};
		}

		try {
			this.probes.dispatch(this.pipeline, task, request.role_profile);
		} catch (error) {
			return { ready: false, task, failure: { stage: "dispatch", reasons: [reason(error)] } };
		}
		try {
			this.probes.worker_execute(request.worker);
		} catch (error) {
			return { ready: false, task, failure: { stage: "worker", reasons: [reason(error)] } };
		}
		try {
			this.probes.loop_budget(this.loopBudgetController, task);
		} catch (error) {
			return { ready: false, task, failure: { stage: "budget", reasons: [reason(error)] } };
		}
		try {
			this.probes.state_write(this.pipeline.stateStore);
		} catch (error) {
			return { ready: false, task, failure: { stage: "state", reasons: [reason(error)] } };
		}

		return { ready: true, task };
	}

	async execute(request: IngressGateRequest): Promise<PipelineExecution> {
		const readiness = this.probe(request);
		if (!readiness.ready || !readiness.task || readiness.failure) {
			throw new IngressReadinessError(
				readiness.failure ?? { stage: "validation", reasons: ["compiled task is unavailable"] },
			);
		}
		const { ingress: _ingress, readiness: definitionOfReady, ...pipelineRequest } = request;
		return this.pipeline.execute({
			...pipelineRequest,
			task: readiness.task,
			definition_of_ready: definitionOfReady,
		});
	}
}
