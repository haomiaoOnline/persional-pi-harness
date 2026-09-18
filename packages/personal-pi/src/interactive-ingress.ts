import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PiAgentWorkerAdapter } from "./adapters/pi-cli.ts";
import { IngressGate } from "./ingress.ts";
import { PersistentStateStore } from "./persistence.ts";
import { createPlanApproval, PersonalPiPipeline } from "./pipeline.ts";
import type { WorkerStatus, WorkspaceSnapshot } from "./types.ts";
import { captureWorkspaceSnapshot } from "./verification.ts";

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
}

export interface PersonalPiInteractiveIngressOptions {
	state_path?: string;
	task_id_factory?: () => string;
	permission_gate_path?: string | URL;
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

export function createPersonalPiInteractiveIngressFactory(options: PersonalPiInteractiveIngressOptions = {}) {
	return (context: PersonalPiInteractiveContext) => {
		return async (submission: PersonalPiInteractiveSubmission): Promise<PersonalPiInteractiveResult> => {
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
			const taskId = options.task_id_factory?.() ?? `interactive-${randomUUID()}`;
			const allowedTools = [...new Set(route.active_tools.map((tool) => tool.trim().toLowerCase()))].filter((tool) =>
				PI_TOOLS.has(tool),
			);
			const worker = new PiAgentWorkerAdapter({
				worker_id: `interactive-pi-${taskId}`,
				command: route.command,
				command_args_prefix: route.command_args_prefix,
				permission_gate_path: options.permission_gate_path,
				provider: route.provider,
				model: route.model,
				thinking: route.thinking ?? "medium",
				timeout_ms: 45 * 60 * 1000,
			});
			const initialSnapshot = gitSnapshot(route.cwd, []);
			const execution = await gate.execute({
				ingress: {
					id: taskId,
					type: "interactive",
					title: taskTitle(objective),
					objective,
					requirements: ["execute the submitted interactive work through the governed pipeline"],
					constraints: ["worker must run through the bounded non-interactive PPH worker route"],
					scope: { files: ["."] },
					permissions: {
						filesystem: { read: ["."], write: ["."] },
						shell: { allowed: allowedTools.includes("bash") ? ["*"] : [] },
						network: "deny",
						credentials: "deny",
						git: { allowed: [] },
					},
					execution: {
						worker_type: "pi",
						worker_tier: "standard",
						reasoning_depth:
							route.thinking === "high" || route.thinking === "xhigh" || route.thinking === "max"
								? "high"
								: "medium",
						capability_tags: ["interactive", "bounded_subprocess"],
						mode: "single",
						working_directory: route.cwd,
						allowed_tools: allowedTools,
					},
					expected_outputs: ["interactive coding-agent result"],
					acceptance_criteria: ["bounded worker returns a valid result and independent verification passes"],
					verification: {
						strategy: "automated",
						commands: [],
						checks: [],
						evidence_required: [],
						strength: "weak",
					},
					loop_budget: {
						max_attempts: 1,
						max_model_calls: 8,
						max_tool_calls: 60,
						max_handoffs: 0,
						max_elapsed_ms: 45 * 60 * 1000,
						max_input_tokens: 200_000,
						max_output_tokens: 32_000,
						max_cost_usd: 20,
						max_state_growth_bytes: 50_000_000,
						on_exhaustion: { action: "BLOCKED", escalation: "human" },
					},
				},
				readiness: { dependencies_ready: true, artifact_edges: [] },
				requirement: {
					user: "interactive PPH user",
					data_sources: ["interactive terminal submission"],
					permission_location: ["compiled Task Contract"],
					delivery: "governed interactive coding-agent turn",
					acceptance: ["pipeline reaches independent verification and acceptance"],
					constraints: ["worker is bounded and non-interactive"],
					unknowns: [],
					sustainability: ["persistent replayable state"],
					non_functional: ["bounded execution"],
					commercialization: ["local personal automation"],
				},
				plan_assessment: PLAN_ASSESSMENT,
				plan_checklist: {
					technical_feasibility: true,
					scalability: true,
					commercial_reasonableness: true,
					testability: true,
				},
				plan_approval: createPlanApproval(PLAN_ASSESSMENT, "interactive-ingress"),
				worker,
				worker_status: route.worker_status,
				snapshot: initialSnapshot,
				workspace_snapshot_provider: (artifacts) => gitSnapshot(route.cwd, artifacts),
			});
			return { summary: execution.result.summary };
		};
	};
}
