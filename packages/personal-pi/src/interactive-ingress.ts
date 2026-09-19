import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PiAgentWorkerAdapter } from "./adapters/pi-cli.ts";
import { DispatchExecutor } from "./dispatch-executor.ts";
import { TaskGraphStore } from "./graph.ts";
import { BudgetController, DynamicDecomposer } from "./graph-intelligence.ts";
import { DeterministicTaskCompiler, IngressGate, type TaskIngressRequest } from "./ingress.ts";
import { PersistentStateStore } from "./persistence.ts";
import { createPlanApproval, PersonalPiPipeline } from "./pipeline.ts";
import { deriveParallelPlanHint } from "./planning.ts";
import type {
	ExecutionSurfaceAttestation,
	ProviderMode,
	TaskContract,
	WorkerStatus,
	WorkspaceSnapshot,
} from "./types.ts";
import { captureWorkspaceSnapshot } from "./verification.ts";
import { WorkerPool } from "./worker-pool.ts";

const PI_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);

export interface PersonalPiInteractiveSubmission {
	text: string;
	images?: unknown[];
}

export interface PersonalPiInteractiveResult {
	summary?: string;
}

export interface PersonalPiInteractiveWorkerRoute {
	cwd: string;
	command: string;
	command_args_prefix: string[];
	provider?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	active_tools: string[];
	worker_status: WorkerStatus;
}

export interface PersonalPiInteractiveContext {
	getWorkerRoute(): PersonalPiInteractiveWorkerRoute;
	recordExecutionSurface?(metadata: Readonly<Record<string, unknown>>): void;
}

export interface PersonalPiInteractiveIngressOptions {
	state_path?: string;
	task_id_factory?: () => string;
	permission_gate_path?: string | URL;
	provider_mode?: ProviderMode;
	execution_surface?: Pick<ExecutionSurfaceAttestation, "pph_commit" | "bundle_sha256">;
	max_parallel_workers?: number;
}

const PLAN_ASSESSMENT = {
	scalability: "bounded interactive task",
	security: "governed by Personal PI ingress",
	cost: "bounded by loop budget",
	extensibility: "interactive composition boundary",
	testability: "persistent control-plane evidence",
	business_viability: "local personal automation",
	confidence: 1,
	open_risks: [],
	playbook_refs: [],
};

function taskTitle(text: string): string {
	const firstLine = text.trim().split("\n", 1)[0] ?? "Interactive task";
	return firstLine.slice(0, 120) || "Interactive task";
}

function gitSnapshot(cwd: string, artifacts: readonly string[]): WorkspaceSnapshot {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd,
		encoding: "utf8",
	});
	const changedFiles = porcelain
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3))
		.sort();
	return captureWorkspaceSnapshot(commit, changedFiles, artifacts);
}

function createInteractiveWorker(
	route: PersonalPiInteractiveWorkerRoute,
	workerId: string,
	options: PersonalPiInteractiveIngressOptions,
): PiAgentWorkerAdapter {
	return new PiAgentWorkerAdapter({
		worker_id: workerId,
		command: route.command,
		command_args_prefix: route.command_args_prefix,
		permission_gate_path: options.permission_gate_path,
		provider: route.provider,
		model: route.model,
		thinking: route.thinking ?? "medium",
		timeout_ms: 45 * 60 * 1000,
	});
}

function interactiveIngressRequest(input: {
	id: string;
	objective: string;
	route: PersonalPiInteractiveWorkerRoute;
	allowed_tools: string[];
	mode?: "single" | "decompose";
	dependencies?: string[];
	constraints?: string[];
	capability_tags?: string[];
}): TaskIngressRequest {
	return {
		id: input.id,
		type: "interactive",
		title: taskTitle(input.objective),
		objective: input.objective,
		requirements: ["execute the submitted interactive work through the governed pipeline"],
		constraints: [
			"worker must run through the bounded non-interactive PPH worker route",
			...(input.constraints ?? []),
		],
		scope: { files: ["."] },
		permissions: {
			filesystem: { read: ["."], write: ["."] },
			shell: { allowed: input.allowed_tools.includes("bash") ? ["*"] : [] },
			network: "deny",
			credentials: "deny",
			git: { allowed: [] },
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth:
				input.route.thinking === "high" || input.route.thinking === "xhigh" || input.route.thinking === "max"
					? "high"
					: "medium",
			capability_tags: ["interactive", "bounded_subprocess", ...(input.capability_tags ?? [])],
			mode: input.mode ?? "single",
			working_directory: input.route.cwd,
			allowed_tools: input.allowed_tools,
		},
		dependencies: input.dependencies ?? [],
		expected_outputs: ["interactive coding-agent result"],
		acceptance_criteria: ["bounded worker returns a valid result and independent verification passes"],
		verification: { strategy: "automated", commands: [], checks: [], evidence_required: [], strength: "weak" },
		loop_budget: {
			max_attempts: 1,
			max_model_calls: 8,
			max_tool_calls: 60,
			max_handoffs: 8,
			max_elapsed_ms: 45 * 60 * 1000,
			max_input_tokens: 200_000,
			max_output_tokens: 32_000,
			max_cost_usd: 20,
			max_state_growth_bytes: 50_000_000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
	};
}

function requirement(delivery: string) {
	return {
		user: "interactive PPH user",
		data_sources: ["interactive terminal submission"],
		permission_location: ["compiled Task Contract"],
		delivery,
		acceptance: ["pipeline reaches independent verification and acceptance"],
		constraints: ["worker is bounded and non-interactive"],
		unknowns: [],
		sustainability: ["persistent replayable state"],
		non_functional: ["bounded execution"],
		commercialization: ["local personal automation"],
	};
}

function executionSurface(
	options: PersonalPiInteractiveIngressOptions,
	schedulerKind: ExecutionSurfaceAttestation["scheduler_kind"],
): ExecutionSurfaceAttestation {
	return {
		entrypoint: "interactive",
		pph_commit: options.execution_surface?.pph_commit ?? "unknown",
		bundle_sha256: options.execution_surface?.bundle_sha256 ?? "unknown",
		ingress_bound: true,
		pipeline_bound: true,
		scheduler_enabled: true,
		scheduler_kind: schedulerKind,
	};
}

function commonPipelineInput(options: PersonalPiInteractiveIngressOptions, snapshot: WorkspaceSnapshot, cwd: string) {
	if (!options.provider_mode) throw new Error("interactive PPH requires an explicit provider_mode (mock|local|real)");
	return {
		provider_mode: options.provider_mode,
		baseline_commit: snapshot.commit_hash,
		plan_assessment: PLAN_ASSESSMENT,
		plan_checklist: {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		},
		plan_approval: createPlanApproval(PLAN_ASSESSMENT, "interactive-ingress"),
		snapshot,
		workspace_snapshot_provider: (artifacts: readonly string[]) => gitSnapshot(cwd, artifacts),
	};
}

export function createPersonalPiInteractiveIngressFactory(options: PersonalPiInteractiveIngressOptions = {}) {
	return (context: PersonalPiInteractiveContext) => {
		return async (submission: PersonalPiInteractiveSubmission): Promise<PersonalPiInteractiveResult> => {
			if (!options.provider_mode)
				throw new Error("interactive PPH requires an explicit provider_mode (mock|local|real)");
			const objective = submission.text.trim();
			if (!objective) throw new Error("interactive ingress requires a non-empty work submission");
			if (submission.images && submission.images.length > 0)
				throw new Error("interactive ingress does not yet support image-bearing governed tasks");

			const route = context.getWorkerRoute();
			if (!route.provider || !route.model)
				throw new Error("interactive ingress requires an active provider and model");
			if (
				route.worker_status.worker_capability === "available" &&
				(!route.command || route.command_args_prefix.length === 0)
			)
				throw new Error("interactive ingress worker route is unavailable");

			const statePath = options.state_path ?? join(route.cwd, ".pph", "personal-pi-state.json");
			const store = new PersistentStateStore(statePath);
			const pipeline = new PersonalPiPipeline({ state_store: store });
			const gate = new IngressGate({ pipeline });
			const compiler = new DeterministicTaskCompiler();
			const taskId = options.task_id_factory?.() ?? `interactive-${randomUUID()}`;
			const allowedTools = [...new Set(route.active_tools.map((tool) => tool.trim().toLowerCase()))].filter((tool) =>
				PI_TOOLS.has(tool),
			);
			const initialSnapshot = gitSnapshot(route.cwd, []);
			const common = commonPipelineInput(options, initialSnapshot, route.cwd);
			const parallelHint = deriveParallelPlanHint(objective);

			if (!parallelHint || parallelHint.independent_units.length < 2) {
				context.recordExecutionSurface?.(executionSurface(options, "direct") as unknown as Record<string, unknown>);
				const worker = createInteractiveWorker(route, `interactive-pi-${taskId}`, options);
				const execution = await gate.execute({
					ingress: interactiveIngressRequest({ id: taskId, objective, route, allowed_tools: allowedTools }),
					readiness: { dependencies_ready: true, artifact_edges: [] },
					requirement: requirement("governed interactive coding-agent turn"),
					...common,
					worker,
					worker_status: route.worker_status,
				});
				return { summary: execution.result.summary };
			}

			context.recordExecutionSurface?.(
				executionSurface(options, "worker_pool") as unknown as Record<string, unknown>,
			);
			const parent = compiler.compile(
				interactiveIngressRequest({ id: taskId, objective, route, allowed_tools: allowedTools, mode: "decompose" }),
			);
			const children: TaskContract[] = parallelHint.independent_units.map((unit, index) =>
				compiler.compile(
					interactiveIngressRequest({
						id: `${taskId}:unit-${index + 1}`,
						objective: unit.objective,
						route,
						allowed_tools: allowedTools,
						capability_tags: ["parallel_leaf", "research"],
						constraints: ["produce an independently verifiable receipt/evidence boundary for fan-in"],
					}),
				),
			);
			const graph = new TaskGraphStore({
				revision: parent.graph_revision,
				nodes: [{ id: `node:${parent.id}`, task_id: parent.id }],
				edges: [],
			});
			const decompositionBudget = new BudgetController(
				{
					max_depth: 2,
					max_children_per_task: children.length,
					max_total_open_tasks: children.length + 2,
					max_replan_count: 1,
				},
				{
					max_active_workers: Math.max(2, Math.min(options.max_parallel_workers ?? 4, children.length)),
					max_handoffs_per_task: 1,
					max_concurrent_roles: Math.max(2, Math.min(options.max_parallel_workers ?? 4, children.length)),
				},
				{},
				{ store, scope: `interactive:${taskId}` },
			);
			new DynamicDecomposer(graph, decompositionBudget, [parent]).decompose(parent, children);
			store.saveGraph(graph.read());

			const pool = new WorkerPool({ instance_store: store });
			const poolSize = Math.max(2, Math.min(options.max_parallel_workers ?? 4, children.length));
			for (let index = 0; index < poolSize; index += 1) {
				const workerId = `interactive-pool-${taskId}-${index + 1}`;
				pool.register({
					worker_id: workerId,
					kind: "cli_ephemeral_worker",
					adapter: createInteractiveWorker(route, workerId, options),
				});
			}
			await pool.warmAllAsync();
			const executor = new DispatchExecutor({ pipeline, worker_pool: pool });
			const wave = await executor.executeParallelWave(
				children.map((task) => ({
					request: {
						...common,
						requirement: requirement(`independent parallel leaf ${task.id}`),
						task,
					},
					worker_status: route.worker_status,
				})),
			);
			if (wave.executions.some((execution) => execution.task.state !== "DONE"))
				throw new Error("parallel interactive leaf execution did not reach DONE");

			const synthesisId = `${taskId}:fan-in`;
			const synthesisWorker = createInteractiveWorker(route, `interactive-pi-${synthesisId}`, options);
			const synthesis = await gate.execute({
				ingress: interactiveIngressRequest({
					id: synthesisId,
					objective: `Synthesize the verified receipt/evidence references for the original request: ${objective}`,
					route,
					allowed_tools: allowedTools,
					dependencies: children.map((task) => task.id),
					capability_tags: ["fan_in", "receipt_only"],
					constraints: [
						"consume only validated handoff receipts and evidence/artifact references from leaf tasks",
					],
				}),
				readiness: { dependencies_ready: true, artifact_edges: [] },
				requirement: requirement("receipt/evidence-only parallel fan-in"),
				...common,
				worker: synthesisWorker,
				worker_status: route.worker_status,
				handoff_task_ids: children.map((task) => task.id),
			});
			return { summary: synthesis.result.summary };
		};
	};
}
