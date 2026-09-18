import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PiAgentWorkerAdapter } from "./adapters/pi-cli.ts";
import { validateProviderMode } from "./evidence.ts";
import { DeterministicTaskCompiler, IngressGate, type TaskIngressRequest } from "./ingress.ts";
import { PersistentStateStore } from "./persistence.ts";
import { createPlanApproval, PersonalPiPipeline } from "./pipeline.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { DEFAULT_ROLE_PROFILES } from "./roles.ts";
import { inspectStableCliTask, readStableCliGateStatus } from "./stable-cli-readonly.ts";
import type {
	ArchitectureCommercialAssessment,
	PersistentState,
	ProviderMode,
	RoleProfile,
	TaskContract,
	TaskLedgerBinding,
	TaskRecord,
	WorkerStatus,
	WorkspaceSnapshot,
} from "./types.ts";
import { captureWorkspaceSnapshot, sanitizeResultForVerification, VerificationEngine } from "./verification.ts";
import type { WorkerAdapter } from "./worker.ts";

export interface StableCliResult {
	handled: boolean;
	exit_code: number;
	stdout: string;
	stderr: string;
}

export interface StableCliWorkerRequest {
	task: TaskRecord;
	provider: string;
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface PersonalPiStableCliOptions {
	cwd?: string;
	state_path?: string;
	permission_gate_path?: string | URL;
	task_id_factory?: () => string;
	worker_factory?: (request: StableCliWorkerRequest) => WorkerAdapter;
	worker_status_factory?: (request: StableCliWorkerRequest) => WorkerStatus;
}

interface ParsedFlags {
	values: Map<string, string[]>;
	booleans: Set<string>;
}

const MANAGEMENT_ROOTS = new Set(["project", "task", "gate"]);
const PLAN_ASSESSMENT: ArchitectureCommercialAssessment = {
	scalability: "bounded stable CLI task",
	security: "governed by Personal PI ingress",
	cost: "bounded by Task Contract loop budget",
	extensibility: "stable project delivery command",
	testability: "persistent deterministic evidence",
	business_viability: "reusable project delivery host",
	confidence: 1,
	open_risks: [],
	playbook_refs: [],
};

function success(payload: unknown): StableCliResult {
	return { handled: true, exit_code: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: "" };
}

function failure(message: string): StableCliResult {
	return { handled: true, exit_code: 2, stdout: "", stderr: `${message}\n` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseFlags(args: readonly string[]): ParsedFlags {
	const values = new Map<string, string[]>();
	const booleans = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!token?.startsWith("--")) throw new Error(`unexpected positional argument: ${token ?? ""}`);
		const name = token.slice(2);
		if (!name) throw new Error("empty flag name");
		const next = args[index + 1];
		if (next === undefined || next.startsWith("--")) {
			booleans.add(name);
			continue;
		}
		const existing = values.get(name) ?? [];
		existing.push(next);
		values.set(name, existing);
		index += 1;
	}
	return { values, booleans };
}

function assertKnownFlags(
	flags: ParsedFlags,
	allowedValues: readonly string[],
	allowedBooleans: readonly string[] = [],
): void {
	const valueNames = new Set(allowedValues);
	const booleanNames = new Set(allowedBooleans);
	for (const name of flags.values.keys()) if (!valueNames.has(name)) throw new Error(`unknown flag: --${name}`);
	for (const name of flags.booleans) if (!booleanNames.has(name)) throw new Error(`unknown flag: --${name}`);
}

function requiredFlag(flags: ParsedFlags, name: string): string {
	const values = flags.values.get(name);
	if (!values || values.length !== 1 || !values[0]?.trim()) throw new Error(`--${name} is required exactly once`);
	return values[0].trim();
}

function optionalFlag(flags: ParsedFlags, name: string): string | undefined {
	const values = flags.values.get(name);
	if (!values) return undefined;
	if (values.length !== 1 || !values[0]?.trim()) throw new Error(`--${name} must be supplied at most once`);
	return values[0].trim();
}

function statePath(flags: ParsedFlags, options: PersonalPiStableCliOptions, cwd: string): string {
	return resolve(optionalFlag(flags, "state") ?? options.state_path ?? join(cwd, ".pph", "personal-pi-state.json"));
}

function jsonFile(path: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`JSON document must contain an object: ${path}`);
	return parsed;
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

function contractFromRecord(task: TaskRecord): TaskContract {
	const { state: _state, audit_log: _auditLog, ...contract } = task;
	return structuredClone(contract);
}

function ingressFromTask(task: TaskRecord): TaskIngressRequest {
	const contract = contractFromRecord(task);
	return {
		id: contract.id,
		title: contract.title,
		objective: contract.objective,
		type: contract.type,
		task_revision: contract.task_revision,
		graph_revision: contract.graph_revision,
		requirements: [...contract.requirements],
		constraints: [...contract.constraints],
		scope: structuredClone(contract.scope),
		role_profile_ref: contract.role_profile_ref,
		inputs: structuredClone(contract.inputs),
		data_sources: [...contract.data_sources],
		data_references: [...contract.data_references],
		permissions: structuredClone(contract.permissions),
		execution: structuredClone(contract.execution),
		dependencies: [...contract.dependencies],
		artifact_dependencies: [...contract.artifact_dependencies],
		expected_outputs: [...contract.expected_outputs],
		acceptance_criteria: [...contract.acceptance_criteria],
		verification: structuredClone(contract.verification),
		context: structuredClone(contract.context),
		risk: contract.risk,
		priority: contract.priority,
		timeout: contract.timeout,
		retry_policy: structuredClone(contract.retry_policy),
		loop_budget: contract.loop_budget ? structuredClone(contract.loop_budget) : undefined,
		approval: structuredClone(contract.approval),
	};
}

function projectBinding(state: PersistentState, taskId: string): TaskLedgerBinding {
	const binding = state.task_ledger.find((candidate) => candidate.pph_task_id === taskId);
	if (!binding) throw new Error(`task is not bound to a registered project: ${taskId}`);
	return binding;
}

function roleProfile(state: PersistentState, task: TaskRecord): RoleProfile | undefined {
	if (!task.role_profile_ref) return undefined;
	const role =
		state.role_profiles.find((candidate) => candidate.id === task.role_profile_ref) ??
		DEFAULT_ROLE_PROFILES.find((candidate) => candidate.id === task.role_profile_ref);
	if (!role) throw new Error(`task role profile is not registered: ${task.role_profile_ref}`);
	return structuredClone(role);
}

export function probeLocalStableCliWorkerStatus(command: string, cliEntry: string | undefined): WorkerStatus {
	try {
		if (!command || !cliEntry) throw new Error("worker route is incomplete");
		accessSync(command, constants.X_OK);
		accessSync(cliEntry, constants.R_OK);
		return { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" };
	} catch {
		return { worker_capability: "unavailable", execution_mode: "root_only", delivery_status: "degraded" };
	}
}

function createDefaultWorker(request: StableCliWorkerRequest, options: PersonalPiStableCliOptions): WorkerAdapter {
	if (request.task.execution.worker_type !== "pi")
		throw new Error(`stable task run currently requires worker_type=pi, got ${request.task.execution.worker_type}`);
	const cliEntry = process.argv[1];
	if (!cliEntry) throw new Error("stable task run cannot resolve the current pph CLI entry");
	return new PiAgentWorkerAdapter({
		worker_id: `stable-cli-${request.task.id}`,
		command: process.execPath,
		command_args_prefix: [cliEntry],
		permission_gate_path: options.permission_gate_path,
		provider: request.provider,
		model: request.model,
		thinking: request.thinking,
		timeout_ms: Math.min(request.task.timeout, 45 * 60 * 1000),
	});
}

function createTaskSpec(spec: Record<string, unknown>, taskId: string, workingDirectory: string): TaskIngressRequest {
	if ("id" in spec) throw new Error("task spec must not define id; pph assigns the internal task id");
	const role = spec.role_profile_ref;
	if (typeof role !== "string" || !role.trim()) throw new Error("task spec role_profile_ref is required");
	const execution = isRecord(spec.execution) ? spec.execution : {};
	return {
		...(spec as Omit<TaskIngressRequest, "id" | "execution">),
		id: taskId,
		role_profile_ref: role.trim(),
		execution: { ...(execution as TaskIngressRequest["execution"]), working_directory: workingDirectory },
	};
}

async function projectRegister(
	flags: ParsedFlags,
	options: PersonalPiStableCliOptions,
	cwd: string,
): Promise<StableCliResult> {
	assertKnownFlags(flags, ["state", "repo", "baseline", "architecture", "ledger"]);
	const store = new PersistentStateStore(statePath(flags, options, cwd));
	const record = new ProjectRegistry(store).register({
		repo_path: resolve(cwd, requiredFlag(flags, "repo")),
		baseline_commit: requiredFlag(flags, "baseline"),
		architecture_doc_ref: requiredFlag(flags, "architecture"),
		task_ledger_ref: requiredFlag(flags, "ledger"),
	});
	return success(record);
}

async function taskCreate(
	flags: ParsedFlags,
	options: PersonalPiStableCliOptions,
	cwd: string,
): Promise<StableCliResult> {
	assertKnownFlags(flags, ["state", "project", "project-task", "phase", "spec", "unknown"]);
	const store = new PersistentStateStore(statePath(flags, options, cwd));
	const project = new ProjectRegistry(store).resolve(requiredFlag(flags, "project"));
	const specPath = resolve(cwd, requiredFlag(flags, "spec"));
	const taskId = options.task_id_factory?.() ?? `task-${randomUUID()}`;
	const ingress = createTaskSpec(jsonFile(specPath), taskId, project.repo_path);
	const task = new DeterministicTaskCompiler().compile(ingress);
	const role =
		store.read().role_profiles.find((candidate) => candidate.id === task.role_profile_ref) ??
		DEFAULT_ROLE_PROFILES.find((candidate) => candidate.id === task.role_profile_ref);
	if (!role) throw new Error(`task role profile is not registered: ${task.role_profile_ref}`);
	const binding: TaskLedgerBinding = {
		project_id: project.project_id,
		project_task_id: requiredFlag(flags, "project-task"),
		pph_task_id: task.id,
		phase: requiredFlag(flags, "phase"),
		unknowns: [...(flags.values.get("unknown") ?? [])].map((value) => value.trim()).filter(Boolean),
	};
	const record = store.createTaskWithLedgerBinding(task, binding);
	return success({ task: record, binding });
}

async function taskRun(flags: ParsedFlags, options: PersonalPiStableCliOptions, cwd: string): Promise<StableCliResult> {
	assertKnownFlags(flags, ["state", "task", "provider", "model", "thinking", "provider-mode"]);
	const store = new PersistentStateStore(statePath(flags, options, cwd));
	const taskId = requiredFlag(flags, "task");
	const task = store.getTask(taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);
	if (task.state !== "DRAFT") throw new Error(`task run requires DRAFT state, got ${task.state}`);
	const state = store.read();
	const binding = projectBinding(state, task.id);
	const project = new ProjectRegistry(store).resolve(binding.project_id);
	if (task.execution.working_directory !== project.repo_path)
		throw new Error("task working_directory no longer matches its registered project");
	const provider = requiredFlag(flags, "provider");
	const model = requiredFlag(flags, "model");
	const providerModeValue = requiredFlag(flags, "provider-mode");
	if (!validateProviderMode(providerModeValue)) throw new Error(`invalid --provider-mode value: ${providerModeValue}`);
	const providerMode: ProviderMode = providerModeValue;
	const thinking = (optionalFlag(flags, "thinking") ?? "medium") as StableCliWorkerRequest["thinking"];
	if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(thinking))
		throw new Error(`invalid --thinking value: ${thinking}`);
	const workerRequest = { task, provider, model, thinking };
	const injectedWorker = options.worker_factory?.(workerRequest);
	const worker = injectedWorker ?? createDefaultWorker(workerRequest, options);
	const workerStatus =
		options.worker_status_factory?.(workerRequest) ??
		(injectedWorker
			? { worker_capability: "unavailable", execution_mode: "root_only", delivery_status: "degraded" }
			: probeLocalStableCliWorkerStatus(process.execPath, process.argv[1]));
	const snapshot = gitSnapshot(project.repo_path, []);
	const pipeline = new PersonalPiPipeline({ state_store: store });
	const gate = new IngressGate({ pipeline });
	const execution = await gate.execute({
		ingress: ingressFromTask(task),
		readiness: {
			dependencies_ready: task.dependencies.every((dependency) => store.getTask(dependency)?.state === "DONE"),
			artifact_edges: [],
		},
		requirement: {
			user: "stable pph CLI task",
			data_sources: [...task.data_sources],
			permission_location: ["persisted Task Contract"],
			delivery: task.expected_outputs.join(", ") || task.objective,
			acceptance: [...task.acceptance_criteria],
			constraints: [...task.constraints],
			unknowns: [],
			sustainability: ["persistent project delivery state"],
			non_functional: ["bounded governed execution"],
			commercialization: ["reusable project delivery"],
		},
		provider_mode: providerMode,
		baseline_commit: project.baseline_commit,
		plan_assessment: PLAN_ASSESSMENT,
		plan_checklist: {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		},
		plan_approval: createPlanApproval(PLAN_ASSESSMENT, "stable-cli"),
		worker,
		worker_status: workerStatus,
		role_profile: roleProfile(state, task),
		snapshot,
		workspace_snapshot_provider: (artifacts) => gitSnapshot(project.repo_path, artifacts),
		existing_task: task,
	});
	return success({ task: execution.task, run: execution.run, verification: execution.verification });
}

async function taskInspect(
	flags: ParsedFlags,
	options: PersonalPiStableCliOptions,
	cwd: string,
): Promise<StableCliResult> {
	assertKnownFlags(flags, ["state", "task"]);
	const taskId = requiredFlag(flags, "task");
	return success(inspectStableCliTask(statePath(flags, options, cwd), taskId));
}

async function taskVerify(
	flags: ParsedFlags,
	options: PersonalPiStableCliOptions,
	cwd: string,
): Promise<StableCliResult> {
	assertKnownFlags(flags, ["state", "task"], ["accept"]);
	const store = new PersistentStateStore(statePath(flags, options, cwd));
	const taskId = requiredFlag(flags, "task");
	const task = store.getTask(taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);
	const state = store.read();
	const binding = projectBinding(state, taskId);
	const project = new ProjectRegistry(store).resolve(binding.project_id);
	const result = state.results.filter((candidate) => candidate.task_id === taskId).at(-1);
	if (!result) throw new Error(`task has no persisted Result: ${taskId}`);
	const evidence = state.evidence
		.filter((candidate) => candidate.task_id === taskId && candidate.run_id === result.run_id)
		.at(-1);
	if (!evidence) throw new Error(`task has no persisted Evidence for run: ${result.run_id}`);
	const snapshot = gitSnapshot(project.repo_path, result.artifacts);
	const verification = await new VerificationEngine().verify({
		task,
		evidence,
		snapshot,
		currentSnapshot: snapshot,
		workerStatus: result.status,
		result: sanitizeResultForVerification(result),
	});
	store.saveVerification(verification);
	if (!flags.booleans.has("accept")) return success({ verification, task: store.getTask(taskId) });
	const accepted = store.acceptTask(taskId, verification.id, result.run_id, snapshot);
	return success({ verification, task: accepted.task, acceptance: accepted.acceptance });
}

async function gateStatus(
	flags: ParsedFlags,
	options: PersonalPiStableCliOptions,
	cwd: string,
): Promise<StableCliResult> {
	assertKnownFlags(flags, ["state", "task"]);
	const taskId = requiredFlag(flags, "task");
	return success(readStableCliGateStatus(statePath(flags, options, cwd), taskId));
}

export async function runPersonalPiStableCli(
	argv: readonly string[],
	options: PersonalPiStableCliOptions = {},
): Promise<StableCliResult> {
	const root = argv[0];
	if (!root || !MANAGEMENT_ROOTS.has(root)) return { handled: false, exit_code: 0, stdout: "", stderr: "" };
	const action = argv[1];
	try {
		if (!action) throw new Error(`missing ${root} subcommand`);
		const flags = parseFlags(argv.slice(2));
		const cwd = resolve(options.cwd ?? process.cwd());
		if (root === "project" && action === "register") return await projectRegister(flags, options, cwd);
		if (root === "task" && action === "create") return await taskCreate(flags, options, cwd);
		if (root === "task" && action === "run") return await taskRun(flags, options, cwd);
		if (root === "task" && action === "inspect") return await taskInspect(flags, options, cwd);
		if (root === "task" && action === "verify") return await taskVerify(flags, options, cwd);
		if (root === "gate" && action === "status") return await gateStatus(flags, options, cwd);
		throw new Error(`unknown pph management command: ${root} ${action}`);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}
