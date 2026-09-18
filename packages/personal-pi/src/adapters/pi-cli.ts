import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ResultContract,
	TaskContract,
	WorkerExecutionControls,
	WorkerExecutionInput,
	WorkerExecutionOutput,
	WorkerProtocolRequest,
} from "../types.ts";
import { PiWorker, type WorkerAdapter } from "../worker.ts";
import type { CliObservation, ExternalWorkerObservation, JsonlProcessResult, ToolObservation } from "./cli-runtime.ts";
import {
	buildExternalPrompt,
	createCliObservation,
	createSanitizedEnvironment,
	externalObservation,
	legalNoOpReceipt,
	parseWorkerOutput,
	runJsonlProcess,
	safeEvidence,
} from "./cli-runtime.ts";

const PI_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export interface PiAgentWorkerAdapterOptions {
	worker_id?: string;
	command?: string;
	command_args_prefix?: string[];
	permission_gate_path?: string | URL;
	provider?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeout_ms?: number;
	home_dir?: string;
	pi_config_dir?: string;
	run_process?: (options: {
		command: string;
		args: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		stdin: string;
		timeout_ms: number;
		controls?: WorkerExecutionControls;
		on_event: (event: unknown, observation: CliObservation) => { terminate?: boolean; reason?: string } | undefined;
	}) => Promise<JsonlProcessResult>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeToolName(value: string): string {
	return value.trim().toLowerCase() === "shell" ? "bash" : value.trim().toLowerCase();
}

function effectiveTools(task: TaskContract): string[] {
	return [...new Set(task.execution.allowed_tools.map(normalizeToolName))].filter((tool) => PI_TOOLS.has(tool));
}

function actionRequiresWrite(action: string): boolean {
	return /(?:write|edit|modify|create|delete|remove|rename|commit|push|overwrite|mutat)/i.test(action);
}

function actionRequiresShell(action: string): boolean {
	return /\b(run|execute|shell|command|compile|test|build)\b/i.test(action);
}

function policyDenial(request: WorkerProtocolRequest, tools: readonly string[]): string | undefined {
	const task = request.task;
	const requestedActions = request.requested_actions ?? [];
	const unknown = task.execution.allowed_tools.filter((tool) => !PI_TOOLS.has(normalizeToolName(tool)));
	if (unknown.length > 0) return `unsupported Pi tool(s): ${unknown.join(", ")}`;
	if (tools.some((tool) => WRITE_TOOLS.has(tool)) && task.permissions.filesystem.write.length === 0)
		return "write/edit tools require a non-empty filesystem.write scope";
	if (tools.includes("bash") && task.permissions.shell.allowed.length === 0)
		return "bash tool requires a non-empty shell.allowed scope";
	if (
		task.permissions.network === "deny" &&
		tools.includes("bash") &&
		requestedActions.some((action) => /network|http|fetch/i.test(action))
	)
		return "network action is denied by the Task Contract";
	const writeAction = requestedActions.find(actionRequiresWrite);
	if (writeAction && (!tools.some((tool) => WRITE_TOOLS.has(tool)) || task.permissions.filesystem.write.length === 0))
		return `requested write action is not permitted: ${writeAction}`;
	const shellAction = requestedActions.find(actionRequiresShell);
	if (shellAction && !tools.includes("bash")) return `requested shell action is not permitted: ${shellAction}`;
	return undefined;
}

function absoluteWorkingDirectory(task: TaskContract): string {
	return isAbsolute(task.execution.working_directory)
		? resolve(task.execution.working_directory)
		: resolve(process.cwd(), task.execution.working_directory);
}

function extensionPath(explicitPath?: string | URL): string | undefined {
	if (explicitPath !== undefined) {
		const injected = explicitPath instanceof URL ? fileURLToPath(explicitPath) : explicitPath;
		return existsSync(injected) ? injected : undefined;
	}
	const compiled = fileURLToPath(new URL("./pi-permission-gate.js", import.meta.url));
	if (existsSync(compiled)) return compiled;
	const source = fileURLToPath(new URL("./pi-permission-gate.ts", import.meta.url));
	return existsSync(source) ? source : undefined;
}

function usageFromObservation(observation: CliObservation): string[] {
	return safeEvidence("pi-agent", observation, observation.provider, observation.model);
}

function outputWithReceipt(output: WorkerExecutionOutput, observation: CliObservation): WorkerExecutionOutput {
	const evidence = [...new Set([...(output.evidence ?? []), ...usageFromObservation(observation)])];
	if (output.work_receipt)
		return {
			...output,
			evidence,
			work_receipt: {
				...output.work_receipt,
				evidence_refs: [...new Set([...output.work_receipt.evidence_refs, ...evidence])],
			},
		};
	return { ...output, evidence, work_receipt: legalNoOpReceipt("Pi returned no observed workspace effect", evidence) };
}

function pathWithinWriteScope(task: TaskContract, path: string): boolean {
	const cwd = absoluteWorkingDirectory(task);
	const candidate = resolve(cwd, path);
	return task.permissions.filesystem.write.some((scope) => {
		const root = resolve(cwd, scope);
		const relative = requireRelative(root, candidate);
		return relative === "" || (!relative.startsWith("../") && relative !== ".." && !isAbsolute(relative));
	});
}

function requireRelative(root: string, candidate: string): string {
	if (candidate === root) return "";
	if (candidate.startsWith(`${root}/`)) return candidate.slice(root.length + 1);
	return candidate;
}

function failureOutput(
	summary: string,
	errors: string[],
	evidence: string[],
	_observation: CliObservation,
): WorkerExecutionOutput {
	return {
		status: "failure",
		summary,
		changed_files: [],
		artifacts: [],
		evidence,
		errors,
		work_receipt: legalNoOpReceipt("No permitted workspace effect was observed", evidence),
	};
}

function captureAssistantMessage(
	event: Record<string, unknown>,
	observation: CliObservation,
	countCall: () => void,
): void {
	const message = asRecord(event.message);
	if (!message || message.role !== "assistant") return;
	countCall();
	if (typeof message.provider === "string") observation.provider = message.provider;
	if (typeof message.model === "string") observation.model = message.model;
	if (typeof message.stopReason === "string") observation.stop_reason = message.stopReason;
	const usage = asRecord(message.usage);
	const cost = asRecord(usage?.cost);
	if (usage) {
		observation.usage = {
			input_tokens: typeof usage.input === "number" ? usage.input : undefined,
			output_tokens: typeof usage.output === "number" ? usage.output : undefined,
			total_tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
			cost_usd: typeof cost?.total === "number" ? cost.total : undefined,
		};
	}
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.map((item) => {
			const block = asRecord(item);
			return block?.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
	if (text) observation.final_text = text;
}

function checkObservedBudget(task: TaskContract, observation: CliObservation): string | undefined {
	const budget = task.loop_budget;
	const usage = observation.usage;
	if (!budget || !usage) return undefined;
	if (usage.input_tokens !== undefined && usage.input_tokens > budget.max_input_tokens)
		return `loop budget exhausted: max_input_tokens (${usage.input_tokens} > ${budget.max_input_tokens})`;
	if (usage.output_tokens !== undefined && usage.output_tokens > budget.max_output_tokens)
		return `loop budget exhausted: max_output_tokens (${usage.output_tokens} > ${budget.max_output_tokens})`;
	if (usage.cost_usd !== undefined && usage.cost_usd > budget.max_cost_usd)
		return `loop budget exhausted: max_cost_usd (${usage.cost_usd} > ${budget.max_cost_usd})`;
	return undefined;
}

function observeTool(
	event: Record<string, unknown>,
	observation: CliObservation,
	controls?: WorkerExecutionControls,
): void {
	if (event.type === "tool_execution_start") {
		controls?.beforeToolCall();
		const args = asRecord(event.args);
		const tool: ToolObservation = {
			tool_call_id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
			name: typeof event.toolName === "string" ? event.toolName : "unknown",
			path: typeof args?.path === "string" ? args.path : undefined,
		};
		observation.tools.push(tool);
		observation.tool_calls += 1;
		if (tool.path && (tool.name === "write" || tool.name === "edit") && tool.tool_call_id)
			observation.pending_mutations.set(tool.tool_call_id, tool.path);
	}
	if (event.type === "tool_execution_end") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		const succeeded = event.isError === false;
		const path = id ? observation.pending_mutations.get(id) : undefined;
		if (id) observation.pending_mutations.delete(id);
		const tool = observation.tools.find((candidate) => candidate.tool_call_id === id);
		if (tool) tool.succeeded = succeeded;
		if (succeeded && path && (event.toolName === "write" || event.toolName === "edit"))
			observation.mutated_paths.push(path);
	}
}

export class PiAgentWorkerAdapter implements WorkerAdapter {
	readonly worker_id: string;
	readonly backend = "pi-agent";
	readonly requested_model: string;
	private readonly command: string;
	private readonly command_args_prefix: string[];
	private readonly permission_gate_path?: string | URL;
	private readonly provider: string;
	private readonly thinking: NonNullable<PiAgentWorkerAdapterOptions["thinking"]>;
	private readonly timeout_ms: number;
	private readonly home_dir: string;
	private readonly pi_config_dir: string;
	private readonly run_process: NonNullable<PiAgentWorkerAdapterOptions["run_process"]>;
	private last_observation?: ExternalWorkerObservation;

	constructor(options: PiAgentWorkerAdapterOptions = {}) {
		this.worker_id = options.worker_id ?? "pi-agent-deepseek-v4-flash";
		this.command = options.command ?? "pi";
		this.command_args_prefix = [...(options.command_args_prefix ?? [])];
		this.permission_gate_path = options.permission_gate_path;
		this.provider = options.provider ?? "opencodex";
		this.requested_model = options.model ?? "ArkCoding/deepseek-v4-flash-ga-260731";
		this.thinking = options.thinking ?? "high";
		this.timeout_ms = options.timeout_ms ?? 60_000;
		this.home_dir = options.home_dir ?? homedir();
		this.pi_config_dir = options.pi_config_dir ?? resolve(this.home_dir, ".pi", "agent");
		this.run_process = options.run_process ?? runJsonlProcess;
	}

	getLastObservation(): ExternalWorkerObservation | undefined {
		return this.last_observation ? structuredClone(this.last_observation) : undefined;
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		const tools = effectiveTools(request.task);
		const denial = policyDenial(request, tools);
		const delegate = new PiWorker(this.worker_id, (input) => this.invoke(request, input, controls, tools, denial));
		return delegate.execute(request, controls);
	}

	private async invoke(
		request: WorkerProtocolRequest,
		input: WorkerExecutionInput,
		controls: WorkerExecutionControls | undefined,
		tools: readonly string[],
		denial: string | undefined,
	): Promise<WorkerExecutionOutput> {
		const cwd = absoluteWorkingDirectory(request.task);
		const prompt = buildExternalPrompt(input, request.task, this.backend, tools, denial);
		const maxElapsed = request.task.loop_budget?.max_elapsed_ms ?? this.timeout_ms;
		const timeout = Math.max(1, Math.min(this.timeout_ms, request.task.timeout, maxElapsed));
		const extension = tools.length > 0 ? extensionPath(this.permission_gate_path) : undefined;
		if (tools.length > 0 && !extension) {
			const observation = createCliObservation();
			observation.protocol_error = "permission gate unavailable";
			this.last_observation = externalObservation(this.backend, this.requested_model, observation, "failure", 0);
			return failureOutput(
				"Pi Worker permission gate is unavailable",
				["permission_gate_missing"],
				safeEvidence(this.backend, observation),
				observation,
			);
		}
		const args = [
			...this.command_args_prefix,
			"-p",
			"--mode",
			"json",
			"--no-session",
			"--no-skills",
			"--no-context-files",
			"--no-extensions",
			"--no-approve",
			"--provider",
			this.provider,
			"--model",
			this.requested_model,
			"--thinking",
			this.thinking,
		];
		if (tools.length === 0) args.push("--no-tools");
		else args.push("--tools", tools.join(","));
		if (extension) args.push("--extension", extension);
		args.push(prompt);
		const environment = createSanitizedEnvironment({
			home_dir: this.home_dir,
			pi_config_dir: this.pi_config_dir,
			policy: {
				working_directory: cwd,
				allowed_tools: [...tools],
				read_scopes: [...request.task.permissions.filesystem.read],
				write_scopes: [...request.task.permissions.filesystem.write],
				shell_allowed: [...request.task.permissions.shell.allowed],
				network: request.task.permissions.network === "allow",
			},
		});
		const started = Date.now();
		let assistantMessages = 0;
		const processResult = await this.run_process({
			command: this.command,
			args,
			cwd,
			env: environment,
			stdin: "",
			timeout_ms: timeout,
			controls,
			on_event: (event, observation) => {
				const record = asRecord(event);
				if (!record) return;
				if (record.type === "message_start") {
					const message = asRecord(record.message);
					if (message?.role === "assistant") {
						assistantMessages += 1;
						observation.model_calls += 1;
						if (assistantMessages > 1) controls?.beforeModelCall();
					}
				}
				if (record.type === "message_end" || record.type === "turn_end")
					captureAssistantMessage(record, observation, () => undefined);
				const budgetViolation = checkObservedBudget(request.task, observation);
				if (budgetViolation) {
					observation.budget_violation = budgetViolation;
					return { terminate: true, reason: budgetViolation };
				}
				if (record.type === "tool_execution_start" || record.type === "tool_execution_end")
					observeTool(record, observation, controls);
				return undefined;
			},
		});
		const observation = processResult.observation;
		const elapsed = Date.now() - started;
		const evidence = usageFromObservation(observation);
		let output: WorkerExecutionOutput;
		if (processResult.budget_error) {
			this.last_observation = externalObservation(
				this.backend,
				this.requested_model,
				observation,
				"BLOCKED",
				elapsed,
			);
			throw processResult.budget_error;
		}
		if (tools.length > 0 && !extension) {
			output = failureOutput(
				"Pi Worker permission gate is unavailable",
				["permission_gate_missing"],
				evidence,
				observation,
			);
		} else if (denial) {
			output = failureOutput(
				"DENIED by Worker tool/permission policy",
				[denial],
				[...evidence, "policy_refusal"],
				observation,
			);
		} else if (observation.timed_out) {
			output = {
				status: "timeout",
				summary: "Pi Worker process timed out",
				changed_files: [],
				artifacts: [],
				evidence: [...evidence, "controlled_timeout"],
				errors: ["controlled timeout"],
				work_receipt: legalNoOpReceipt("Process timed out before a permitted effect was observed", evidence),
			};
		} else if (observation.budget_violation) {
			output = failureOutput(
				"Pi Worker exceeded its observed loop budget",
				[observation.budget_violation],
				[...evidence, "loop_budget_exhausted"],
				observation,
			);
		} else if (observation.spawn_error) {
			const code = observation.spawn_error.code ?? "unknown";
			output = failureOutput("Pi Worker process could not start", [`process_start:${code}`], evidence, observation);
		} else if (observation.protocol_error || observation.exit_code !== 0) {
			output = failureOutput(
				"Pi Worker process failed before returning a Result Contract",
				[observation.protocol_error ?? `process_exit:${observation.exit_code ?? "signal"}`],
				evidence,
				observation,
			);
		} else if (observation.provider !== this.provider || observation.model !== this.requested_model) {
			output = failureOutput(
				"Pi Worker runtime provider/model identity did not match the requested route",
				[
					`observed_provider:${observation.provider ?? "unknown"}`,
					`observed_model:${observation.model ?? "unknown"}`,
				],
				[...evidence, "runtime_identity_mismatch"],
				observation,
			);
		} else if (!observation.final_text) {
			output = failureOutput(
				"Pi Worker returned no assistant result",
				["missing_final_text"],
				evidence,
				observation,
			);
		} else {
			const parsed = parseWorkerOutput(observation.final_text);
			if (!parsed.output)
				output = failureOutput(
					"Pi Worker returned a malformed Result Contract",
					parsed.errors,
					evidence,
					observation,
				);
			else if (
				((parsed.output.changed_files ?? []).length > 0 ||
					(parsed.output.artifacts ?? []).length > 0 ||
					(parsed.output.work_receipt?.effects_count ?? 0) > 0 ||
					parsed.output.work_receipt?.state_changed === true ||
					(parsed.output.work_receipt?.artifacts_created.length ?? 0) > 0) &&
				observation.mutated_paths.length === 0
			)
				output = failureOutput(
					"Pi Worker claimed a workspace effect without an observed tool mutation",
					["unsubstantiated_workspace_mutation"],
					evidence,
					observation,
				);
			else if (observation.mutated_paths.some((path) => !pathWithinWriteScope(request.task, path)))
				output = failureOutput(
					"Pi Worker mutated a path outside the Task Contract write scope",
					["mutation_outside_write_scope"],
					evidence,
					observation,
				);
			else {
				const parsedOutput = outputWithReceipt(parsed.output, observation);
				output =
					observation.mutated_paths.length > 0
						? {
								...parsedOutput,
								changed_files: [...new Set(observation.mutated_paths)],
								work_receipt: {
									work_attempted: true,
									effects_count: new Set(observation.mutated_paths).size,
									artifacts_created: parsedOutput.artifacts ?? [],
									state_changed: true,
									no_op: false,
									evidence_refs: [...evidence],
								},
							}
						: parsedOutput;
			}
		}
		this.last_observation = externalObservation(
			this.backend,
			this.requested_model,
			observation,
			output.status,
			elapsed,
		);
		return output;
	}
}
