import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
	ResultContract,
	TaskContract,
	WorkerExecutionControls,
	WorkerExecutionInput,
	WorkerExecutionOutput,
	WorkerProtocolRequest,
} from "../types.ts";
import { PiWorker, type WorkerAdapter } from "../worker.ts";
import {
	buildExternalPrompt,
	type CliObservation,
	createSanitizedEnvironment,
	type ExternalWorkerObservation,
	externalObservation,
	type JsonlProcessOptions,
	type JsonlProcessResult,
	legalNoOpReceipt,
	parseWorkerOutput,
	runJsonlProcess,
	safeEvidence,
} from "./cli-runtime.ts";

export interface CodexCliWorkerAdapterOptions {
	worker_id?: string;
	command?: string;
	model?: string;
	timeout_ms?: number;
	home_dir?: string;
	codex_home?: string;
	run_process?: (options: JsonlProcessOptions) => Promise<JsonlProcessResult>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function cwdFor(task: TaskContract): string {
	return isAbsolute(task.execution.working_directory)
		? resolve(task.execution.working_directory)
		: resolve(process.cwd(), task.execution.working_directory);
}

function noToolBridgeDenial(request: WorkerProtocolRequest): string | undefined {
	if (request.task.execution.allowed_tools.length > 0)
		return "Codex CLI adapter has no Task Contract tool bridge; allowed_tools must be empty";
	if ((request.requested_actions ?? []).length > 0)
		return "Codex CLI adapter has no Task Contract action bridge; requested_actions must be empty";
	return undefined;
}

function failureOutput(summary: string, errors: string[], evidence: string[]): WorkerExecutionOutput {
	return {
		status: "failure",
		summary,
		changed_files: [],
		artifacts: [],
		evidence,
		errors,
		work_receipt: legalNoOpReceipt("No Codex Task Contract effect bridge was enabled", evidence),
	};
}

function captureAgentMessage(item: Record<string, unknown>, observation: CliObservation): void {
	if (item.type !== "agent_message" || typeof item.text !== "string") return;
	observation.final_text = item.text;
}

function captureUsage(event: Record<string, unknown>, observation: CliObservation): void {
	const usage = asRecord(event.usage);
	if (!usage) return;
	const cost = asRecord(usage.cost);
	observation.usage = {
		input_tokens:
			typeof usage.input_tokens === "number"
				? usage.input_tokens
				: typeof usage.input === "number"
					? usage.input
					: undefined,
		output_tokens:
			typeof usage.output_tokens === "number"
				? usage.output_tokens
				: typeof usage.output === "number"
					? usage.output
					: undefined,
		total_tokens:
			typeof usage.total_tokens === "number"
				? usage.total_tokens
				: typeof usage.totalTokens === "number"
					? usage.totalTokens
					: undefined,
		cost_usd: typeof cost?.total === "number" ? cost.total : undefined,
	};
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

function outputWithReceipt(output: WorkerExecutionOutput, evidence: string[]): WorkerExecutionOutput {
	const mergedEvidence = [...new Set([...(output.evidence ?? []), ...evidence])];
	if (output.work_receipt)
		return {
			...output,
			evidence: mergedEvidence,
			work_receipt: {
				...output.work_receipt,
				evidence_refs: [...new Set([...output.work_receipt.evidence_refs, ...mergedEvidence])],
			},
		};
	return {
		...output,
		evidence: mergedEvidence,
		work_receipt: legalNoOpReceipt("Codex returned no observed workspace effect", mergedEvidence),
	};
}

export class CodexCliWorkerAdapter implements WorkerAdapter {
	readonly worker_id: string;
	readonly backend = "codex-cli";
	readonly requested_model: string;
	private readonly command: string;
	private readonly timeout_ms: number;
	private readonly home_dir: string;
	private readonly codex_home: string;
	private readonly run_process: (options: JsonlProcessOptions) => Promise<JsonlProcessResult>;
	private last_observation?: ExternalWorkerObservation;

	constructor(options: CodexCliWorkerAdapterOptions = {}) {
		this.worker_id = options.worker_id ?? "codex-cli-existing-session";
		this.command = options.command ?? "codex";
		this.requested_model = options.model ?? "gpt-5.6-sol";
		this.timeout_ms = options.timeout_ms ?? 90_000;
		this.home_dir = options.home_dir ?? homedir();
		this.codex_home = options.codex_home ?? resolve(this.home_dir, ".codex");
		this.run_process = options.run_process ?? runJsonlProcess;
	}

	getLastObservation(): ExternalWorkerObservation | undefined {
		return this.last_observation ? structuredClone(this.last_observation) : undefined;
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		const denial = noToolBridgeDenial(request);
		const delegate = new PiWorker(this.worker_id, (input) => this.invoke(request, input, controls, denial));
		return delegate.execute(request, controls);
	}

	private async invoke(
		request: WorkerProtocolRequest,
		input: WorkerExecutionInput,
		controls: WorkerExecutionControls | undefined,
		denial: string | undefined,
	): Promise<WorkerExecutionOutput> {
		const cwd = cwdFor(request.task);
		const prompt = buildExternalPrompt(input, request.task, this.backend, [], denial);
		const timeout = Math.max(
			1,
			Math.min(this.timeout_ms, request.task.timeout, request.task.loop_budget?.max_elapsed_ms ?? this.timeout_ms),
		);
		const args = [
			"exec",
			"--ephemeral",
			"--json",
			"--color",
			"never",
			"--ignore-rules",
			"--model",
			this.requested_model,
			"--cd",
			cwd,
			"--sandbox",
			"read-only",
			"--skip-git-repo-check",
			"-",
		];
		const environment = createSanitizedEnvironment({
			home_dir: this.home_dir,
			codex_home: this.codex_home,
		});
		const started = Date.now();
		let turns = 0;
		const processResult = await this.run_process({
			command: this.command,
			args,
			cwd,
			env: environment,
			stdin: prompt,
			timeout_ms: timeout,
			controls,
			on_event: (event, observation) => {
				const record = asRecord(event);
				if (!record) return;
				if (record.type === "turn.started" || record.type === "turn_start") {
					turns += 1;
					observation.model_calls += 1;
					if (turns > 1) controls?.beforeModelCall();
				}
				if (record.type === "item.completed" || record.type === "item.started") {
					const item = asRecord(record.item);
					if (!item) return;
					if (item.type === "agent_message") captureAgentMessage(item, observation);
					if (
						["command_execution", "file_change", "mcp_tool_call", "web_search", "computer_call"].includes(
							String(item.type),
						)
					)
						return { terminate: true, reason: "Codex emitted a tool/action item without a Task Contract bridge" };
				}
				if (record.type === "turn.completed") {
					captureUsage(record, observation);
					const budgetViolation = checkObservedBudget(request.task, observation);
					if (budgetViolation) {
						observation.budget_violation = budgetViolation;
						return { terminate: true, reason: budgetViolation };
					}
				}
				if (record.type === "turn.failed" || record.type === "error")
					observation.protocol_error = "Codex CLI reported a failed turn";
				return undefined;
			},
		});
		const observation = processResult.observation;
		const elapsed = Date.now() - started;
		const evidence = safeEvidence(this.backend, observation);
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
		if (denial)
			output = failureOutput("DENIED by Codex Worker tool/action policy", [denial], [...evidence, "policy_refusal"]);
		else if (observation.timed_out)
			output = {
				status: "timeout",
				summary: "Codex Worker process timed out",
				changed_files: [],
				artifacts: [],
				evidence: [...evidence, "controlled_timeout"],
				errors: ["controlled timeout"],
				work_receipt: legalNoOpReceipt("Process timed out before a permitted effect was observed", evidence),
			};
		else if (observation.budget_violation)
			output = failureOutput(
				"Codex Worker exceeded its observed loop budget",
				[observation.budget_violation],
				[...evidence, "loop_budget_exhausted"],
			);
		else if (observation.spawn_error)
			output = failureOutput(
				"Codex Worker process could not start",
				[`process_start:${observation.spawn_error.code ?? "unknown"}`],
				evidence,
			);
		else if (observation.protocol_error || observation.exit_code !== 0)
			output = failureOutput(
				"Codex Worker process failed before returning a Result Contract",
				[observation.protocol_error ?? `process_exit:${observation.exit_code ?? "signal"}`],
				evidence,
			);
		else if (!observation.final_text)
			output = failureOutput("Codex Worker returned no agent result", ["missing_final_text"], evidence);
		else {
			const parsed = parseWorkerOutput(observation.final_text);
			if (!parsed.output)
				output = failureOutput("Codex Worker returned a malformed Result Contract", parsed.errors, evidence);
			else if (
				(parsed.output.changed_files ?? []).length > 0 ||
				(parsed.output.artifacts ?? []).length > 0 ||
				(parsed.output.work_receipt?.effects_count ?? 0) > 0 ||
				parsed.output.work_receipt?.state_changed === true ||
				(parsed.output.work_receipt?.artifacts_created.length ?? 0) > 0
			)
				output = failureOutput(
					"Codex Worker claimed a workspace effect without a Task Contract bridge",
					["unsubstantiated_workspace_mutation"],
					evidence,
				);
			else output = outputWithReceipt(parsed.output, evidence);
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
