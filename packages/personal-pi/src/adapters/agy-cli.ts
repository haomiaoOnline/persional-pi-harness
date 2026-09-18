import { createHash } from "node:crypto";
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
	accountInputTokens,
	buildExternalPrompt,
	type CliObservation,
	createSanitizedEnvironment,
	type ExternalWorkerObservation,
	externalObservation,
	type JsonlEventDecision,
	type JsonlProcessOptions,
	type JsonlProcessResult,
	legalNoOpReceipt,
	parseWorkerOutput,
	runJsonlProcess,
	safeEvidence,
	trustedModelIdentity,
	withTrustedModelIdentity,
} from "./cli-runtime.ts";

type AgyIdentitySource = "agy-stream-json-response" | "none";

export interface AgyRuntimeMetadata {
	pph_run_id: string | null;
	conversation_id_sha256: string | null;
	request_id_sha256: string | null;
	requested_model: string;
	configured_model: string | null;
	observed_runtime_model: string;
	provider_backend: string | null;
	identity_source: AgyIdentitySource;
	identity_fields_seen: string[];
	started_at: string;
	ended_at: string;
	finish_reason: string | null;
}

export interface AgyCliWorkerAdapterOptions {
	worker_id?: string;
	command?: string;
	model?: string;
	effort?: "low" | "medium" | "high";
	timeout_ms?: number;
	home_dir?: string;
	run_process?: (options: JsonlProcessOptions) => Promise<JsonlProcessResult>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function digestId(value: string | undefined): string | null {
	return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof record[key] === "string" && record[key].length > 0) return record[key] as string;
	}
	return undefined;
}

function firstNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number;
	}
	return undefined;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function recordConversationId(value: unknown, observation: CliObservation, metadata: AgyRuntimeMetadata): void {
	if (typeof value !== "string" || value.length === 0) return;
	const digest = digestId(value);
	if (metadata.conversation_id_sha256 && metadata.conversation_id_sha256 !== digest) {
		observation.protocol_error ??= "Agy emitted inconsistent conversation_id values";
		pushUnique(metadata.identity_fields_seen, "conversation_id_mismatch");
		return;
	}
	metadata.conversation_id_sha256 = digest;
	observation.session_id = value;
}

function recordRequestId(value: unknown, observation: CliObservation, metadata: AgyRuntimeMetadata): void {
	if (typeof value !== "string" || value.length === 0) return;
	const digest = digestId(value);
	if (metadata.request_id_sha256 && metadata.request_id_sha256 !== digest) {
		observation.protocol_error ??= "Agy emitted inconsistent request/prompt id values";
		pushUnique(metadata.identity_fields_seen, "request_id_mismatch");
		return;
	}
	metadata.request_id_sha256 = digest;
}

function captureUsage(value: unknown, observation: CliObservation): void {
	const usage = asRecord(value);
	if (!usage) return;
	const cost = asRecord(usage.cost);
	observation.usage = {
		input_tokens: firstNumber(usage, "input_tokens", "input"),
		output_tokens: firstNumber(usage, "output_tokens", "output"),
		total_tokens: firstNumber(usage, "total_tokens", "totalTokens"),
		cost_usd: firstNumber(cost ?? {}, "total", "total_usd"),
	};
}

function observeResponseIdentity(
	value: unknown,
	prefix: string,
	observation: CliObservation,
	metadata: AgyRuntimeMetadata,
): void {
	const record = asRecord(value);
	if (!record) return;
	const model = stringField(record, "response_model", "runtime_model");
	if (model) {
		pushUnique(
			metadata.identity_fields_seen,
			`${prefix}.${record.response_model ? "response_model" : "runtime_model"}`,
		);
		if (metadata.observed_runtime_model !== "unknown" && metadata.observed_runtime_model !== model) {
			observation.protocol_error ??= "Agy emitted conflicting response-side runtime model values";
		} else {
			metadata.observed_runtime_model = model;
			observation.model = model;
		}
	}
	const provider = stringField(record, "provider", "backend");
	if (provider) {
		pushUnique(metadata.identity_fields_seen, `${prefix}.${record.provider ? "provider" : "backend"}`);
		if (metadata.provider_backend && metadata.provider_backend !== provider) {
			observation.protocol_error ??= "Agy emitted conflicting provider/backend values";
		} else {
			metadata.provider_backend = provider;
			observation.provider = provider;
		}
	}
	const requestId = stringField(record, "request_id", "prompt_id");
	if (requestId) {
		pushUnique(metadata.identity_fields_seen, `${prefix}.${record.request_id ? "request_id" : "prompt_id"}`);
		recordRequestId(requestId, observation, metadata);
	}
	const finishReason = stringField(record, "finish_reason", "finishReason");
	if (finishReason) {
		metadata.finish_reason = finishReason;
		pushUnique(metadata.identity_fields_seen, `${prefix}.${record.finish_reason ? "finish_reason" : "finishReason"}`);
		observation.stop_reason = finishReason;
	}
}

function actionEvent(record: Record<string, unknown>): boolean {
	const event = stringField(record, "event", "type");
	return (
		event !== undefined &&
		[
			"tool_call",
			"tool_use",
			"tool_result",
			"command_execution",
			"file_change",
			"mcp_tool_call",
			"browser_action",
			"computer_call",
			"shell_command",
			"action",
		].includes(event)
	);
}

function actionStep(stepType: unknown): boolean {
	return (
		typeof stepType === "string" &&
		/tool|command|file_change|mcp|browser|computer|shell|write|edit|action/i.test(stepType)
	);
}

function observeAgyEvent(
	record: Record<string, unknown>,
	observation: CliObservation,
	metadata: AgyRuntimeMetadata,
	appendResponse: (text: string) => void,
): JsonlEventDecision | undefined {
	const event = stringField(record, "event", "type");
	if (event === "init") {
		recordConversationId(record.conversation_id, observation, metadata);
		const init = asRecord(record.init);
		if (init) metadata.configured_model = stringField(init, "model") ?? metadata.configured_model;
		return undefined;
	}
	if (actionEvent(record))
		return { terminate: true, reason: "Agy emitted a tool/action event without a Task Contract bridge" };
	if (event === "step_update") {
		const update = asRecord(record.step_update);
		if (!update) return undefined;
		if (actionStep(update.step_type))
			return { terminate: true, reason: "Agy emitted a tool/action step without a Task Contract bridge" };
		recordConversationId(update.conversation_id, observation, metadata);
		observeResponseIdentity(update, "step_update", observation, metadata);
		if (update.step_type === "agent_response" && typeof update.text_delta === "string")
			appendResponse(update.text_delta);
		return undefined;
	}
	if (event === "result") {
		const result = asRecord(record.result);
		if (!result) return undefined;
		recordConversationId(result.conversation_id, observation, metadata);
		observeResponseIdentity(result, "result", observation, metadata);
		captureUsage(result.usage, observation);
		if (typeof result.response === "string") observation.final_text = result.response;
		if (typeof result.status === "string" && result.status !== "SUCCESS") observation.stop_reason = result.status;
		return undefined;
	}
	if (event === "error") observation.protocol_error = "Agy CLI reported a failed run";
	return undefined;
}

function cwdFor(task: TaskContract): string {
	return isAbsolute(task.execution.working_directory)
		? resolve(task.execution.working_directory)
		: resolve(process.cwd(), task.execution.working_directory);
}

function noToolBridgeDenial(request: WorkerProtocolRequest): string | undefined {
	if (request.task.execution.allowed_tools.length > 0)
		return "Agy CLI adapter has no Task Contract tool bridge; allowed_tools must be empty";
	if ((request.requested_actions ?? []).length > 0)
		return "Agy CLI adapter has no Task Contract action bridge; requested_actions must be empty";
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
		work_receipt: legalNoOpReceipt("No permitted Agy workspace effect was observed", evidence),
	};
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
		work_receipt: legalNoOpReceipt("Agy returned no observed workspace effect", mergedEvidence),
	};
}

function checkObservedBudget(task: TaskContract, observation: CliObservation): string | undefined {
	const budget = task.loop_budget;
	const usage = observation.usage;
	if (!budget || !usage) return undefined;
	const accounting = accountInputTokens(task, usage);
	if (accounting.provider_input_tokens !== null && accounting.provider_input_tokens > budget.max_input_tokens)
		return `loop budget exhausted: max_input_tokens (${accounting.provider_input_tokens} > ${budget.max_input_tokens})`;
	if (usage.output_tokens !== undefined && usage.output_tokens > budget.max_output_tokens)
		return `loop budget exhausted: max_output_tokens (${usage.output_tokens} > ${budget.max_output_tokens})`;
	if (usage.cost_usd !== undefined && usage.cost_usd > budget.max_cost_usd)
		return `loop budget exhausted: max_cost_usd (${usage.cost_usd} > ${budget.max_cost_usd})`;
	return undefined;
}

function identityErrors(metadata: AgyRuntimeMetadata): string[] {
	const errors: string[] = [];
	if (!metadata.conversation_id_sha256) errors.push("missing_conversation_id");
	if (metadata.observed_runtime_model === "unknown") errors.push("missing_response_model");
	if (!metadata.provider_backend) errors.push("missing_provider_backend");
	return errors;
}

export class AgyCliWorkerAdapter implements WorkerAdapter {
	readonly worker_id: string;
	readonly backend = "agy-cli";
	readonly requested_model: string;
	private readonly command: string;
	private readonly effort: NonNullable<AgyCliWorkerAdapterOptions["effort"]>;
	private readonly timeout_ms: number;
	private readonly home_dir: string;
	private readonly run_process: (options: JsonlProcessOptions) => Promise<JsonlProcessResult>;
	private last_observation?: ExternalWorkerObservation;
	private last_agy_run?: AgyRuntimeMetadata;

	constructor(options: AgyCliWorkerAdapterOptions = {}) {
		this.worker_id = options.worker_id ?? "agy-cli-existing-session";
		this.command = options.command ?? "agy";
		this.requested_model = options.model ?? "gemini-3.8-flash-low";
		this.effort = options.effort ?? "low";
		this.timeout_ms = options.timeout_ms ?? 90_000;
		this.home_dir = options.home_dir ?? homedir();
		this.run_process = options.run_process ?? runJsonlProcess;
	}

	getLastObservation(): ExternalWorkerObservation | undefined {
		return this.last_observation ? structuredClone(this.last_observation) : undefined;
	}

	getModelIdentity() {
		return trustedModelIdentity(this.last_observation, this.requested_model);
	}

	getLastAgyRun(): AgyRuntimeMetadata | undefined {
		return this.last_agy_run ? structuredClone(this.last_agy_run) : undefined;
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		this.last_observation = undefined;
		this.last_agy_run = undefined;
		const denial = noToolBridgeDenial(request);
		const delegate = new PiWorker(
			this.worker_id,
			(input) => this.invoke(request, input, controls, denial),
			this.requested_model,
		);
		const result = await delegate.execute(request, controls);
		return this.last_observation ? withTrustedModelIdentity(result, this.last_observation) : result;
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
			`--print=${prompt}`,
			"--input-format",
			"text",
			"--output-format",
			"stream-json",
			"--model",
			this.requested_model,
			"--effort",
			this.effort,
			"--mode",
			"plan",
			"--sandbox",
			"--disable-slash-commands",
			"--log-file",
			"/dev/null",
			"--print-timeout",
			`${Math.max(1, Math.ceil(timeout / 1000))}s`,
		];
		const environment = createSanitizedEnvironment({ home_dir: this.home_dir });
		const started = new Date();
		const metadata: AgyRuntimeMetadata = {
			pph_run_id: request.run_id ?? null,
			conversation_id_sha256: null,
			request_id_sha256: null,
			requested_model: this.requested_model,
			configured_model: null,
			observed_runtime_model: "unknown",
			provider_backend: null,
			identity_source: "none",
			identity_fields_seen: [],
			started_at: started.toISOString(),
			ended_at: started.toISOString(),
			finish_reason: null,
		};
		const observationState = { agent_response_steps: 0 };
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
				if (!record) return undefined;
				const eventName = stringField(record, "event", "type");
				if (eventName === "step_update") {
					const update = asRecord(record.step_update);
					if (update?.step_type === "agent_response" && update.state === "ACTIVE") {
						observationState.agent_response_steps += 1;
						observation.model_calls += 1;
						if (observationState.agent_response_steps > 1) controls?.beforeModelCall();
					}
				}
				const decision = observeAgyEvent(record, observation, metadata, (text) => {
					observation.final_text = `${observation.final_text ?? ""}${text}`;
				});
				if (decision) return decision;
				const budgetViolation = checkObservedBudget(request.task, observation);
				if (budgetViolation) {
					observation.budget_violation = budgetViolation;
					return { terminate: true, reason: budgetViolation };
				}
				return undefined;
			},
		});
		const observation = processResult.observation;
		metadata.ended_at = new Date().toISOString();
		metadata.identity_source =
			metadata.observed_runtime_model !== "unknown" && metadata.provider_backend
				? "agy-stream-json-response"
				: "none";
		this.last_agy_run = structuredClone(metadata);
		const elapsed = Date.parse(metadata.ended_at) - Date.parse(metadata.started_at);
		const evidence = safeEvidence(
			this.backend,
			observation,
			observation.provider,
			observation.model,
			accountInputTokens(request.task, observation.usage),
		);
		evidence.push(`agy-cli:identity_fields=${metadata.identity_fields_seen.join(",") || "none"}`);
		if (metadata.conversation_id_sha256)
			evidence.push(`agy-cli:conversation_id_sha256=${metadata.conversation_id_sha256}`);
		if (metadata.request_id_sha256) evidence.push(`agy-cli:request_id_sha256=${metadata.request_id_sha256}`);
		if (metadata.identity_source === "none") evidence.push("agy-cli:runtime_identity_unavailable");
		let output: WorkerExecutionOutput;
		if (processResult.budget_error) {
			this.last_observation = externalObservation(
				this.backend,
				this.requested_model,
				observation,
				"BLOCKED",
				elapsed,
				undefined,
				{
					observed_runtime_model:
						metadata.identity_source === "agy-stream-json-response" ? metadata.observed_runtime_model : undefined,
				},
			);
			throw processResult.budget_error;
		}
		if (denial)
			output = failureOutput("DENIED by Agy Worker tool/action policy", [denial], [...evidence, "policy_refusal"]);
		else if (observation.timed_out)
			output = {
				status: "timeout",
				summary: "Agy Worker process timed out",
				changed_files: [],
				artifacts: [],
				evidence: [...evidence, "controlled_timeout"],
				errors: ["controlled timeout"],
				work_receipt: legalNoOpReceipt("Process timed out before a permitted effect was observed", evidence),
			};
		else if (observation.budget_violation)
			output = failureOutput(
				"Agy Worker exceeded its observed loop budget",
				[observation.budget_violation],
				[...evidence, "loop_budget_exhausted"],
			);
		else if (observation.spawn_error)
			output = failureOutput(
				"Agy Worker process could not start",
				[`process_start:${observation.spawn_error.code ?? "unknown"}`],
				evidence,
			);
		else if (observation.protocol_error || observation.exit_code !== 0)
			output = failureOutput(
				"Agy Worker process failed before returning a Result Contract",
				[observation.protocol_error ?? `process_exit:${observation.exit_code ?? "signal"}`],
				evidence,
			);
		else if (!observation.final_text)
			output = failureOutput("Agy Worker returned no agent result", ["missing_final_text"], evidence);
		else {
			const parsed = parseWorkerOutput(observation.final_text);
			if (!parsed.output)
				output = failureOutput("Agy Worker returned a malformed Result Contract", parsed.errors, evidence);
			else {
				const missingIdentity = identityErrors(metadata);
				if (missingIdentity.length > 0)
					output = failureOutput(
						"Agy Worker runtime identity was not attested by response-side telemetry",
						["runtime_identity_unavailable", ...missingIdentity],
						[...evidence, "runtime_identity_unavailable"],
					);
				else if (
					(parsed.output.changed_files ?? []).length > 0 ||
					(parsed.output.artifacts ?? []).length > 0 ||
					(parsed.output.work_receipt?.effects_count ?? 0) > 0 ||
					parsed.output.work_receipt?.state_changed === true ||
					(parsed.output.work_receipt?.artifacts_created.length ?? 0) > 0
				)
					output = failureOutput(
						"Agy Worker claimed a workspace effect without a Task Contract bridge",
						["unsubstantiated_workspace_mutation"],
						evidence,
					);
				else output = outputWithReceipt(parsed.output, evidence);
			}
		}
		this.last_observation = externalObservation(
			this.backend,
			this.requested_model,
			observation,
			output.status,
			elapsed,
			accountInputTokens(request.task, observation.usage),
			{
				observed_runtime_model:
					metadata.identity_source === "agy-stream-json-response" ? metadata.observed_runtime_model : undefined,
			},
		);
		return output;
	}
}
