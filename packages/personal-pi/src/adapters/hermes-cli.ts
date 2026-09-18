import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
import {
	accountInputTokens,
	type CliObservation,
	createCliObservation,
	createSanitizedEnvironment,
	type ExternalUsage,
	type ExternalWorkerObservation,
	type InputTokenAccounting,
	type JsonlProcessOptions,
	type JsonlProcessResult,
	legalNoOpReceipt,
	parseWorkerOutput,
	runJsonlProcess,
	safeEvidence,
	trustedModelIdentity,
	withTrustedModelIdentity,
} from "./cli-runtime.ts";

const HERMES_BACKEND = "hermes-cli";
const DEFAULT_HERMES_MODEL = "ArkCoding/deepseek-v4-flash-ga-260731";
const DEFAULT_HERMES_PROVIDER = "custom";
const SYNTHETIC_PROBE_OBJECTIVE = "PPH_SYNTHETIC_HERMES_PROBE_v1";

export interface HermesRuntimeIdentity {
	pph_run_id: string | null;
	hermes_session_id: string | null;
	hermes_task_id: string | null;
	api_call_count: number;
	started_at: string | null;
	ended_at: string | null;
	api_duration: number | null;
	provider: string | null;
	configured_model: string | null;
	response_model: string | null;
	api_mode: string | null;
	base_url_host: string | null;
	response_id: string | null;
	request_id: string | null;
	finish_reason: string | null;
	usage: ExternalUsage | null;
	cli_path: string | null;
	cli_version: string | null;
	identity_source: string;
	source_event: string;
}

export interface HermesWorkerObservation extends ExternalWorkerObservation {
	runtime_identity: HermesRuntimeIdentity | null;
	result_digest: string | null;
	work_receipt_digest: string | null;
	evidence_digest: string | null;
}

export interface HermesCliWorkerAdapterOptions {
	worker_id?: string;
	/** Installed Hermes executable or a command resolvable through PATH. */
	command?: string;
	/** Python interpreter hosting the installed Hermes package. */
	python_command?: string;
	model?: string;
	provider?: string;
	timeout_ms?: number;
	home_dir?: string;
	bridge_script?: string;
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
		return "Hermes CLI adapter has no Task Contract tool bridge; allowed_tools must be empty";
	if ((request.requested_actions ?? []).length > 0)
		return "Hermes CLI adapter has no Task Contract action bridge; requested_actions must be empty";
	return undefined;
}

function syntheticBoundaryDenial(request: WorkerProtocolRequest): string | undefined {
	const task = request.task;
	if (task.objective !== SYNTHETIC_PROBE_OBJECTIVE)
		return "Hermes CLI adapter is limited to the explicit synthetic identity probe";
	if (Object.keys(task.inputs).length > 0) return "Hermes synthetic probe requires empty task inputs";
	if (task.context.required.length > 0 || task.context.optional.length > 0 || task.context.excluded.length > 0)
		return "Hermes synthetic probe requires an empty context manifest";
	if (request.resolved_context?.items.length) return "Hermes synthetic probe forbids resolved context";
	if (task.permissions.network !== "deny") return "Hermes synthetic probe requires network deny in the Task Contract";
	if (task.permissions.credentials !== "deny")
		return "Hermes synthetic probe requires credentials deny in the Task Contract";
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
		work_receipt: legalNoOpReceipt("No Hermes Task Contract effect bridge was enabled", evidence),
	};
}

function digestJson(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value) ?? "null")
		.digest("hex");
}

function digestText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sessionDigest(sessionId: string | null | undefined): string | null {
	return sessionId ? createHash("sha256").update(sessionId).digest("hex").slice(0, 16) : null;
}

function resolveCommandPath(command: string): string | undefined {
	if (isAbsolute(command)) return existsSync(command) ? command : undefined;
	for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
		const candidate = resolve(directory, command);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function interpreterFromShebang(command: string): string | undefined {
	const path = resolveCommandPath(command);
	if (!path) return undefined;
	try {
		const firstLine = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
		if (!firstLine.startsWith("#!")) return undefined;
		const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
		if (parts[0]?.endsWith("/env")) {
			const executable = parts.find((part) => part !== "-S" && !part.startsWith("-"));
			return executable;
		}
		return parts[0];
	} catch {
		return undefined;
	}
}

function defaultBridgeScript(): string {
	return fileURLToPath(new URL("../../scripts/hermes-worker-bridge.py", import.meta.url));
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function usageFromRecord(value: unknown): ExternalUsage | null {
	const usage = asRecord(value);
	if (!usage) return null;
	const result: ExternalUsage = {
		input_tokens: numberOrNull(usage.input_tokens) ?? undefined,
		output_tokens: numberOrNull(usage.output_tokens) ?? undefined,
		total_tokens: numberOrNull(usage.total_tokens) ?? undefined,
		cost_usd: numberOrNull(usage.cost_usd) ?? undefined,
	};
	return Object.values(result).some((item) => item !== undefined) ? result : null;
}

function identityFromRecord(record: Record<string, unknown>): HermesRuntimeIdentity | undefined {
	const value = asRecord(record.identity);
	if (!value) return undefined;
	const apiCallCount = numberOrNull(value.api_call_count);
	return {
		pph_run_id: stringOrNull(value.pph_run_id),
		hermes_session_id: stringOrNull(value.hermes_session_id),
		hermes_task_id: stringOrNull(value.hermes_task_id),
		api_call_count: apiCallCount !== null ? Math.max(0, Math.trunc(apiCallCount)) : 0,
		started_at: stringOrNull(value.started_at),
		ended_at: stringOrNull(value.ended_at),
		api_duration: numberOrNull(value.api_duration),
		provider: stringOrNull(value.provider),
		configured_model: stringOrNull(value.configured_model),
		response_model: stringOrNull(value.response_model),
		api_mode: stringOrNull(value.api_mode),
		base_url_host: stringOrNull(value.base_url_host),
		response_id: stringOrNull(value.response_id),
		request_id: stringOrNull(value.request_id),
		finish_reason: stringOrNull(value.finish_reason),
		usage: usageFromRecord(value.usage),
		cli_path: stringOrNull(value.cli_path),
		cli_version: stringOrNull(value.cli_version),
		identity_source: stringOrNull(value.identity_source) ?? "",
		source_event: stringOrNull(value.source_event) ?? "",
	};
}

function sameIdentity(left: HermesRuntimeIdentity, right: HermesRuntimeIdentity): boolean {
	return (
		left.pph_run_id === right.pph_run_id &&
		left.hermes_session_id === right.hermes_session_id &&
		left.hermes_task_id === right.hermes_task_id &&
		left.provider === right.provider &&
		left.response_model === right.response_model
	);
}

function identityErrors(
	identities: readonly HermesRuntimeIdentity[],
	pphRunId: string,
	requestedModel: string,
	requestedProvider: string,
): string[] {
	if (identities.length === 0) return ["missing_post_api_request_identity"];
	const errors: string[] = [];
	const first = identities[0];
	if (!first) return ["missing_post_api_request_identity"];
	if (first.pph_run_id !== pphRunId) errors.push("pph_run_id_mismatch");
	if (!first.hermes_session_id) errors.push("missing_hermes_session_id");
	if (!first.hermes_task_id) errors.push("missing_hermes_task_id");
	if (first.api_call_count < 1) errors.push("missing_api_call_count");
	if (!first.started_at || !first.ended_at) errors.push("missing_api_timestamps");
	if (!first.provider) errors.push("missing_provider");
	if (!first.base_url_host) errors.push("missing_base_url_host");
	if (!first.configured_model) errors.push("missing_configured_model");
	if (!first.response_model) errors.push("missing_response_model");
	if (first.identity_source !== "post_api_request.response_model") errors.push("untrusted_identity_source");
	if (first.source_event !== "post_api_request") errors.push("untrusted_source_event");
	if (first.provider !== requestedProvider) errors.push(`observed_provider:${first.provider ?? "unknown"}`);
	if (first.configured_model !== requestedModel)
		errors.push(`configured_model:${first.configured_model ?? "unknown"}`);
	if (first.response_model !== requestedModel)
		errors.push(`observed_response_model:${first.response_model ?? "unknown"}`);
	if (identities.some((identity) => !sameIdentity(first, identity))) errors.push("identity_changed_within_run");
	return [...new Set(errors)];
}

function checkObservedBudget(task: TaskContract, usage: ExternalUsage | null): string | undefined {
	const budget = task.loop_budget;
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
		work_receipt: legalNoOpReceipt("Hermes returned no observed workspace effect", mergedEvidence),
	};
}

function evidenceFor(
	observation: CliObservation,
	identity: HermesRuntimeIdentity | null,
	inputAccounting: InputTokenAccounting,
	resultDigest: string | null,
): string[] {
	const evidence = safeEvidence(
		HERMES_BACKEND,
		observation,
		identity?.provider ?? undefined,
		identity?.response_model ?? undefined,
		inputAccounting,
	);
	if (identity) {
		evidence.push(`${HERMES_BACKEND}:identity_source=${identity.identity_source}`);
		evidence.push(`${HERMES_BACKEND}:source_event=${identity.source_event}`);
		evidence.push(`${HERMES_BACKEND}:hermes_session_id_sha256=${sessionDigest(identity.hermes_session_id)}`);
		evidence.push(`${HERMES_BACKEND}:hermes_task_id_present=${identity.hermes_task_id ? "true" : "false"}`);
		evidence.push(`${HERMES_BACKEND}:api_call_count=${identity.api_call_count}`);
		if (identity.finish_reason) evidence.push(`${HERMES_BACKEND}:finish_reason=${identity.finish_reason}`);
		if (identity.cli_version) evidence.push(`${HERMES_BACKEND}:cli_version=${identity.cli_version}`);
	}
	if (resultDigest) evidence.push(`${HERMES_BACKEND}:result_digest=${resultDigest}`);
	return [...new Set(evidence)];
}

function observationFor(
	observation: CliObservation,
	identity: HermesRuntimeIdentity | null,
	requestedModel: string,
	status: string,
	elapsedMs: number,
	inputAccounting: InputTokenAccounting,
	resultDigest: string | null,
	workReceiptDigest: string | null = null,
	evidenceDigest: string | null = null,
): HermesWorkerObservation {
	return {
		backend: HERMES_BACKEND,
		requested_model: requestedModel,
		platform_accepted_model: identity?.configured_model ?? "unknown",
		observed_runtime_model: identity?.response_model ?? "unknown",
		provider: identity?.provider ?? null,
		session_id_sha256: sessionDigest(identity?.hermes_session_id),
		process_pid: observation.process_pid ?? null,
		status,
		elapsed_ms: elapsedMs,
		input_tokens: identity?.usage?.input_tokens ?? null,
		input_accounting: inputAccounting,
		output_tokens: identity?.usage?.output_tokens ?? null,
		cost_usd: identity?.usage?.cost_usd ?? null,
		model_calls: identity?.api_call_count ?? observation.model_calls,
		tool_calls: observation.tool_calls,
		timed_out: observation.timed_out,
		protocol_error: observation.protocol_error,
		runtime_identity: identity,
		result_digest: resultDigest,
		work_receipt_digest: workReceiptDigest,
		evidence_digest: evidenceDigest,
	};
}

export class HermesCliWorkerAdapter implements WorkerAdapter {
	readonly worker_id: string;
	readonly backend = HERMES_BACKEND;
	readonly requested_model: string;
	readonly provider: string;
	private readonly command: string;
	private readonly python_command: string;
	private readonly timeout_ms: number;
	private readonly home_dir: string;
	private readonly bridge_script: string;
	private readonly run_process: (options: JsonlProcessOptions) => Promise<JsonlProcessResult>;
	private last_observation?: HermesWorkerObservation;

	constructor(options: HermesCliWorkerAdapterOptions = {}) {
		this.worker_id = options.worker_id ?? "hermes-cli-deepseek-v4-flash";
		this.command = options.command ?? "hermes";
		this.python_command = options.python_command ?? interpreterFromShebang(this.command) ?? "python3";
		this.requested_model = options.model ?? DEFAULT_HERMES_MODEL;
		this.provider = options.provider ?? DEFAULT_HERMES_PROVIDER;
		this.timeout_ms = options.timeout_ms ?? 90_000;
		this.home_dir = options.home_dir ?? homedir();
		this.bridge_script = options.bridge_script ?? defaultBridgeScript();
		this.run_process = options.run_process ?? runJsonlProcess;
	}

	getLastObservation(): HermesWorkerObservation | undefined {
		return this.last_observation ? structuredClone(this.last_observation) : undefined;
	}

	getModelIdentity() {
		return trustedModelIdentity(this.last_observation, this.requested_model);
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		this.last_observation = undefined;
		const boundRequest = request.run_id ? request : { ...request, run_id: randomUUID() };
		const delegate = new PiWorker(
			this.worker_id,
			(input) => this.invoke(boundRequest, input, controls),
			this.requested_model,
		);
		const result = await delegate.execute(boundRequest, controls);
		const observation = this.last_observation as unknown as Record<string, unknown> | undefined;
		if (observation !== undefined) {
			observation.work_receipt_digest = result.work_receipt ? digestJson(result.work_receipt) : null;
			observation.evidence_digest = digestJson(result.evidence);
			this.last_observation = observation as unknown as HermesWorkerObservation;
		}
		return this.last_observation ? withTrustedModelIdentity(result, this.last_observation) : result;
	}

	private async invoke(
		request: WorkerProtocolRequest,
		input: WorkerExecutionInput,
		controls?: WorkerExecutionControls,
	): Promise<WorkerExecutionOutput> {
		const denial = noToolBridgeDenial(request);
		const observation = createCliObservation();
		const started = Date.now();
		const boundaryDenial = syntheticBoundaryDenial(request);
		if (denial || boundaryDenial) {
			const reason = denial ?? boundaryDenial ?? "Hermes synthetic probe boundary denied";
			observation.protocol_error = reason;
			this.last_observation = observationFor(
				observation,
				null,
				this.requested_model,
				"failure",
				0,
				accountInputTokens(request.task, undefined),
				null,
			);
			return failureOutput(
				boundaryDenial
					? "DENIED by Hermes Worker synthetic boundary"
					: "DENIED by Hermes Worker tool/action policy",
				[reason],
				["policy_refusal"],
			);
		}
		if (!existsSync(this.bridge_script)) {
			observation.protocol_error = "Hermes worker bridge is unavailable";
			this.last_observation = observationFor(
				observation,
				null,
				this.requested_model,
				"failure",
				0,
				accountInputTokens(request.task, undefined),
				null,
			);
			return failureOutput("Hermes Worker bridge is unavailable", ["bridge_script_missing"], []);
		}

		const cwd = cwdFor(request.task);
		void input;
		const timeout = Math.max(
			1,
			Math.min(this.timeout_ms, request.task.timeout, request.task.loop_budget?.max_elapsed_ms ?? this.timeout_ms),
		);
		const args = [
			this.bridge_script,
			"--hermes-command",
			this.command,
			"--provider",
			this.provider,
			"--model",
			this.requested_model,
			"--pph-run-id",
			request.run_id ?? "",
		];
		const environment = createSanitizedEnvironment({ home_dir: this.home_dir });
		const identities: HermesRuntimeIdentity[] = [];
		let resultDigest: string | null = null;
		const processResult = await this.run_process({
			command: this.python_command,
			args,
			cwd,
			env: environment,
			// The bridge is fixed synthetic-probe mode and intentionally ignores
			// stdin; no Task Contract content crosses the unverified route.
			stdin: "",
			timeout_ms: timeout,
			controls,
			on_event: (event, childObservation) => {
				const record = asRecord(event);
				if (!record) return;
				if (record.type === "hermes.identity") {
					const identity = identityFromRecord(record);
					if (identity) {
						identities.push(identity);
						childObservation.provider = identity.provider ?? undefined;
						childObservation.model = identity.response_model ?? undefined;
						childObservation.session_id = identity.hermes_session_id ?? undefined;
						childObservation.model_calls = Math.max(childObservation.model_calls, identity.api_call_count);
						childObservation.stop_reason = identity.finish_reason ?? undefined;
						childObservation.usage = identity.usage ?? undefined;
					} else childObservation.protocol_error = "Hermes identity event was malformed";
				}
				if (record.type === "hermes.result") {
					if (typeof record.text === "string") childObservation.final_text = record.text;
					const eventDigest = stringOrNull(record.result_digest);
					if (typeof childObservation.final_text === "string") {
						const calculated = digestText(childObservation.final_text);
						resultDigest = calculated;
						if (eventDigest && eventDigest !== calculated)
							childObservation.protocol_error = "Hermes result digest mismatch";
					}
				}
				if (record.type === "hermes.error")
					childObservation.protocol_error = `Hermes bridge error: ${stringOrNull(record.error_type) ?? "unknown"}`;
				return undefined;
			},
		});
		const finalObservation = processResult.observation;
		const elapsed = Date.now() - started;
		const identity = identities.at(-1) ?? null;
		const usage = identity?.usage ?? finalObservation.usage;
		const inputAccounting = accountInputTokens(request.task, usage);
		const evidence = evidenceFor(finalObservation, identity, inputAccounting, resultDigest);
		let output: WorkerExecutionOutput;
		if (processResult.budget_error) throw processResult.budget_error;
		const identityValidation = identityErrors(identities, request.run_id ?? "", this.requested_model, this.provider);
		const budgetViolation = checkObservedBudget(request.task, usage ?? null);
		if (finalObservation.timed_out)
			output = {
				status: "timeout",
				summary: "Hermes Worker process timed out",
				changed_files: [],
				artifacts: [],
				evidence: [...evidence, "controlled_timeout"],
				errors: ["controlled timeout"],
				work_receipt: legalNoOpReceipt("Process timed out before a permitted effect was observed", evidence),
			};
		else if (budgetViolation)
			output = failureOutput(
				"Hermes Worker exceeded its observed loop budget",
				[budgetViolation],
				[...evidence, "loop_budget_exhausted"],
			);
		else if (finalObservation.spawn_error)
			output = failureOutput(
				"Hermes Worker process could not start",
				[`process_start:${finalObservation.spawn_error.code ?? "unknown"}`],
				evidence,
			);
		else if (finalObservation.protocol_error || finalObservation.exit_code !== 0)
			output = failureOutput(
				"Hermes Worker process failed before returning a Result Contract",
				[finalObservation.protocol_error ?? `process_exit:${finalObservation.exit_code ?? "signal"}`],
				evidence,
			);
		else if (identityValidation.length > 0)
			output = failureOutput(
				"Hermes Worker runtime identity attestation is incomplete or mismatched",
				identityValidation,
				[...evidence, "runtime_identity_unverified"],
			);
		else if (!finalObservation.final_text)
			output = failureOutput("Hermes Worker returned no Result Contract", ["missing_final_text"], evidence);
		else {
			const parsed = parseWorkerOutput(finalObservation.final_text);
			if (!parsed.output)
				output = failureOutput("Hermes Worker returned a malformed Result Contract", parsed.errors, evidence);
			else if (
				(parsed.output.changed_files ?? []).length > 0 ||
				(parsed.output.artifacts ?? []).length > 0 ||
				(parsed.output.work_receipt?.effects_count ?? 0) > 0 ||
				parsed.output.work_receipt?.state_changed === true ||
				(parsed.output.work_receipt?.artifacts_created.length ?? 0) > 0
			)
				output = failureOutput(
					"Hermes Worker claimed a workspace effect without a Task Contract bridge",
					["unsubstantiated_workspace_mutation"],
					evidence,
				);
			else output = outputWithReceipt(parsed.output, evidence);
		}
		this.last_observation = observationFor(
			finalObservation,
			identity,
			this.requested_model,
			output.status,
			elapsed,
			inputAccounting,
			resultDigest,
		);
		return output;
	}
}
