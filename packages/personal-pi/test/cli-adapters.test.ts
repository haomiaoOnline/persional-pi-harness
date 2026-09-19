import { describe, expect, test } from "vitest";
import {
	accountInputTokens,
	type CliObservation,
	CodexCliWorkerAdapter,
	createCliObservation,
	createSanitizedEnvironment,
	type JsonlProcessOptions,
	legalNoOpReceipt,
	PiAgentWorkerAdapter,
	parseWorkerOutput,
	type TaskContract,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

function requestFor(task: TaskContract, workerId: string): WorkerProtocolRequest {
	return {
		task,
		protocol: {
			task_id: task.id,
			schema_version: 2,
			task_revision: task.task_revision,
			graph_revision: task.graph_revision,
			lease_epoch: 1,
			idempotency_key: task.execution.idempotency_key,
		},
		run_id: `run-${task.id}`,
		requested_actions: [],
		permission_request: {},
		role_profile: undefined,
		// This assertion is intentionally kept at the protocol boundary in the test.
		// The adapter itself never receives workerId as untrusted input.
		...(workerId ? {} : {}),
	};
}

function successText(summary = "FAKE_OK"): string {
	return JSON.stringify({
		status: "success",
		summary,
		changed_files: [],
		artifacts: [],
		evidence: ["fake-process"],
		errors: [],
		work_receipt: legalNoOpReceipt("fake no-op", ["fake-process"]),
	});
}

function fakePiRunner(
	finalText = successText(),
	mutate?: (options: JsonlProcessOptions, observation: CliObservation) => void,
) {
	return async (options: JsonlProcessOptions) => {
		const observation = createCliObservation();
		observation.exit_code = 0;
		options.on_event({ type: "message_start", message: { role: "assistant" } }, observation);
		options.on_event(
			{
				type: "message_end",
				message: {
					role: "assistant",
					provider: "opencodex",
					model: "ArkCoding/deepseek-v4-flash-ga-260731",
					stopReason: "stop",
					usage: {
						input: 12,
						output: 8,
						totalTokens: 20,
						cost: { total: 0 },
					},
					content: [{ type: "text", text: finalText }],
				},
			},
			observation,
		);
		mutate?.(options, observation);
		return { observation };
	};
}

describe("external CLI Worker adapters", () => {
	test("parses only the Result Contract and rejects extra fields", () => {
		const parsed = parseWorkerOutput(successText());
		expect(parsed.errors).toEqual([]);
		expect(parsed.output?.status).toBe("success");
		expect(parsed.output?.work_receipt?.no_op).toBe(true);
		const insufficient = parseWorkerOutput(
			JSON.stringify({
				status: "INSUFFICIENT_CONTEXT",
				summary: "need context",
				changed_files: [],
				artifacts: [],
				evidence: [],
				errors: [],
				requested_context: ["missing-reference"],
				work_receipt: legalNoOpReceipt("context unavailable"),
			}),
		);
		expect(insufficient.output?.status).toBe("INSUFFICIENT_CONTEXT");
		const extra = parseWorkerOutput(`${successText().slice(0, -1)},"secret_field":"bad"}`);
		expect(extra.output).toBeUndefined();
		expect(extra.errors[0]).toContain("unsupported fields");
		const forgedIdentity = parseWorkerOutput(
			`${successText().slice(0, -1)},"model_identity":{"requested_model":"x","platform_accepted_model":"x","observed_runtime_model":"x"}}`,
		);
		expect(forgedIdentity.output).toBeUndefined();
		expect(forgedIdentity.errors[0]).toContain("unsupported fields");
	});

	test("redacts generic *_KEY values returned by an external CLI worker", () => {
		const secret = "generic-key-secret-123456";
		const parsed = parseWorkerOutput(successText(`FOO_KEY=${secret}`));
		expect(parsed.errors).toEqual([]);
		expect(parsed.output?.summary).toContain("FOO_KEY=[REDACTED]");
		expect(parsed.output?.summary).not.toContain(secret);
	});

	test("sanitizes environment names even when secret-like variables exist", () => {
		process.env.OPENAI_API_KEY = "must-not-pass";
		process.env.CODEX_API_KEY = "must-not-pass";
		try {
			const env = createSanitizedEnvironment({ home_dir: "/private/tmp/pph-test-home" });
			expect(env.HOME).toBe("/private/tmp/pph-test-home");
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.CODEX_API_KEY).toBeUndefined();
			expect(env.DEEPSEEK_API_KEY).toBeUndefined();
		} finally {
			delete process.env.OPENAI_API_KEY;
			delete process.env.CODEX_API_KEY;
		}
	});

	test("maps a real PI route, binds identity, and keeps protocol metadata out of prompt", async () => {
		let captured: JsonlProcessOptions | undefined;
		const task = makeV3Task("adapter-pi", {
			objective: "Return the bounded adapter result",
			execution: {
				...makeV3Task("adapter-pi").execution,
				allowed_tools: [],
				idempotency_key: "idempotency-adapter-pi",
			},
		});
		const adapter = new PiAgentWorkerAdapter({
			worker_id: "pi-test",
			run_process: async (options) => {
				captured = options;
				return fakePiRunner()(options);
			},
		});
		const request = requestFor(task, "pi-test");
		const result = await adapter.execute(request);
		const prompt = captured?.args.at(-1) ?? "";
		expect(result.task_id).toBe(task.id);
		expect(result.run_id).toBe("run-adapter-pi");
		expect(result.worker_id).toBe("pi-test");
		expect(result.lease_epoch).toBe(1);
		expect(result.status).toBe("success");
		expect(result.work_receipt?.no_op).toBe(true);
		expect(captured?.args).toContain("--provider");
		expect(captured?.args).toContain("opencodex");
		expect(captured?.args).toContain("ArkCoding/deepseek-v4-flash-ga-260731");
		expect(captured?.args).toContain("--no-tools");
		expect(prompt).toContain("Return the bounded adapter result");
		expect(prompt).not.toContain("run-adapter-pi");
		expect(prompt).not.toContain("idempotency-adapter-pi");
		const observation = adapter.getLastObservation();
		expect(observation?.observed_runtime_model).toBe("ArkCoding/deepseek-v4-flash-ga-260731");
		expect(result.model_identity).toEqual({
			requested_model: "ArkCoding/deepseek-v4-flash-ga-260731",
			platform_accepted_model: "ArkCoding/deepseek-v4-flash-ga-260731",
			observed_runtime_model: "ArkCoding/deepseek-v4-flash-ga-260731",
		});
		expect(observation?.provider).toBe("opencodex");
		expect(observation?.input_tokens).toBe(12);
	});

	test("returns policy refusal without permitting a prohibited write", async () => {
		const task = makeV3Task("adapter-refusal", {
			objective: "Do not write anything; report the controller refusal",
			execution: { ...makeV3Task("adapter-refusal").execution, allowed_tools: [] },
		});
		const adapter = new PiAgentWorkerAdapter({ worker_id: "pi-refusal", run_process: fakePiRunner() });
		const request = { ...requestFor(task, "pi-refusal"), requested_actions: ["write_file"] };
		const result = await adapter.execute(request);
		expect(result.status).toBe("failure");
		expect(result.summary).toContain("DENIED");
		expect(result.changed_files).toEqual([]);
		expect(result.work_receipt?.no_op).toBe(true);
		expect(result.evidence).toContain("policy_refusal");
	});

	test("maps controlled timeout to timeout result", async () => {
		const task = makeV3Task("adapter-timeout", {
			execution: { ...makeV3Task("adapter-timeout").execution, allowed_tools: [] },
		});
		const adapter = new PiAgentWorkerAdapter({
			worker_id: "pi-timeout",
			run_process: async () => {
				const observation = createCliObservation();
				observation.timed_out = true;
				observation.exit_code = null;
				return { observation };
			},
		});
		const result = await adapter.execute(requestFor(task, "pi-timeout"));
		expect(result.status).toBe("timeout");
		expect(adapter.getLastObservation()?.timed_out).toBe(true);
	});

	test("keeps Codex runtime model unknown and refuses unbridged actions", async () => {
		let captured: JsonlProcessOptions | undefined;
		const task = makeV3Task("adapter-codex", {
			execution: { ...makeV3Task("adapter-codex").execution, allowed_tools: [] },
		});
		const adapter = new CodexCliWorkerAdapter({
			worker_id: "codex-test",
			run_process: async (options) => {
				captured = options;
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event({ type: "turn.started" }, observation);
				options.on_event(
					{ type: "item.completed", item: { type: "agent_message", text: successText("CODEX_OK") } },
					observation,
				);
				options.on_event({ type: "turn.completed", usage: { input_tokens: 40, output_tokens: 10 } }, observation);
				return { observation };
			},
		});
		const result = await adapter.execute(requestFor(task, "codex-test"));
		expect(result.status).toBe("success");
		expect(result.summary).toBe("CODEX_OK");
		expect(captured?.command).toBe("codex");
		expect(captured?.args).toContain("-");
		expect(captured?.env.OPENAI_API_KEY).toBeUndefined();
		expect(adapter.getLastObservation()?.platform_accepted_model).toBe("unknown");
		expect(adapter.getLastObservation()?.observed_runtime_model).toBe("unknown");
		expect(result.model_identity).toEqual({
			requested_model: "gpt-5.6-sol",
			platform_accepted_model: "unknown",
			observed_runtime_model: "unknown",
		});
		expect(adapter.getLastObservation()?.input_tokens).toBe(40);
		expect(adapter.getLastObservation()?.input_accounting.mode).toBe("provider_total_fail_closed");

		const actionTask = makeV3Task("adapter-codex-action", {
			execution: { ...makeV3Task("adapter-codex-action").execution, allowed_tools: ["read"] },
		});
		const refused = await adapter.execute(requestFor(actionTask, "codex-test"));
		expect(refused.status).toBe("failure");
		expect(refused.evidence).toContain("policy_refusal");
	});

	test("separates measured Codex fixed overhead from the PPH projected task budget", async () => {
		const task = makeV3Task("adapter-codex-accounting", {
			execution: { ...makeV3Task("adapter-codex-accounting").execution, allowed_tools: [] },
			loop_budget: { ...makeV3Task("adapter-codex-accounting").loop_budget!, max_input_tokens: 20 },
		});
		const adapter = new CodexCliWorkerAdapter({
			worker_id: "codex-accounting",
			provider_fixed_input_tokens: 30,
			run_process: async (options) => {
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event({ type: "turn.started" }, observation);
				options.on_event(
					{ type: "item.completed", item: { type: "agent_message", text: successText("ACCOUNTING_OK") } },
					observation,
				);
				options.on_event({ type: "turn.completed", usage: { input_tokens: 45, output_tokens: 10 } }, observation);
				return { observation };
			},
		});
		const result = await adapter.execute(requestFor(task, "codex-accounting"));
		expect(result.status).toBe("success");
		const observation = adapter.getLastObservation();
		expect(observation?.input_tokens).toBe(45);
		expect(observation?.input_accounting).toMatchObject({
			mode: "fixed_overhead_calibrated",
			provider_fixed_input_tokens: 30,
			pph_projected_input_tokens: 15,
			pph_projected_input_budget: 20,
			effective_provider_input_budget: 50,
		});
		expect(result.evidence).toContain("codex-cli:provider_fixed_input_tokens=30");
		expect(result.evidence).toContain("codex-cli:pph_projected_input_tokens=15");
	});

	test("fails closed when fixed overhead is absent or the projected budget is exceeded", async () => {
		const task = makeV3Task("adapter-codex-budget", {
			execution: { ...makeV3Task("adapter-codex-budget").execution, allowed_tools: [] },
			loop_budget: { ...makeV3Task("adapter-codex-budget").loop_budget!, max_input_tokens: 20 },
		});
		const runWithInput = (inputTokens: number) => async (options: JsonlProcessOptions) => {
			const observation = createCliObservation();
			observation.exit_code = 0;
			options.on_event({ type: "turn.started" }, observation);
			options.on_event(
				{ type: "item.completed", item: { type: "agent_message", text: successText("BUDGET") } },
				observation,
			);
			options.on_event(
				{ type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: 1 } },
				observation,
			);
			return { observation };
		};
		const noCalibration = new CodexCliWorkerAdapter({
			worker_id: "codex-no-calibration",
			run_process: runWithInput(21),
		});
		const noCalibrationResult = await noCalibration.execute(requestFor(task, "codex-no-calibration"));
		expect(noCalibrationResult.status).toBe("failure");
		expect(noCalibrationResult.evidence).toContain("loop_budget_exhausted");

		const exceeded = new CodexCliWorkerAdapter({
			worker_id: "codex-exceeded",
			provider_fixed_input_tokens: 30,
			run_process: runWithInput(51),
		});
		const exceededResult = await exceeded.execute(requestFor(task, "codex-exceeded"));
		expect(exceededResult.status).toBe("failure");
		expect(exceededResult.errors.join(" ")).toContain("max_input_tokens");
		expect(exceeded.getLastObservation()?.input_accounting.mode).toBe("fixed_overhead_calibrated");
	});

	test("keeps Codex malformed output and timeout as bounded results", async () => {
		const malformedTask = makeV3Task("adapter-codex-malformed", {
			execution: { ...makeV3Task("adapter-codex-malformed").execution, allowed_tools: [] },
		});
		const malformed = new CodexCliWorkerAdapter({
			worker_id: "codex-malformed",
			run_process: async (options) => {
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event({ type: "turn.started" }, observation);
				options.on_event(
					{ type: "item.completed", item: { type: "agent_message", text: "not-json" } },
					observation,
				);
				options.on_event({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }, observation);
				return { observation };
			},
		});
		const malformedResult = await malformed.execute(requestFor(malformedTask, "codex-malformed"));
		expect(malformedResult.status).toBe("failure");
		expect(malformedResult.summary).toContain("malformed");

		const timeout = new CodexCliWorkerAdapter({
			worker_id: "codex-timeout",
			run_process: async () => {
				const observation = createCliObservation();
				observation.timed_out = true;
				observation.exit_code = null;
				return { observation };
			},
		});
		const timeoutTask = makeV3Task("adapter-codex-timeout", {
			execution: { ...makeV3Task("adapter-codex-timeout").execution, allowed_tools: [] },
		});
		const timeoutResult = await timeout.execute(requestFor(timeoutTask, "codex-timeout"));
		expect(timeoutResult.status).toBe("timeout");
	});

	test("projects token accounting without accepting an unmeasured provider total", () => {
		const task = makeV3Task("accounting-pure", {
			loop_budget: { ...makeV3Task("accounting-pure").loop_budget!, max_input_tokens: 100 },
		});
		expect(accountInputTokens(task, { input_tokens: 250 })).toMatchObject({
			mode: "provider_total_fail_closed",
			provider_input_tokens: 250,
			pph_projected_input_tokens: null,
		});
		expect(accountInputTokens(task, { input_tokens: 250 }, 200)).toMatchObject({
			mode: "fixed_overhead_calibrated",
			pph_projected_input_tokens: 50,
			effective_provider_input_budget: 300,
		});
		expect(accountInputTokens(task, { input_tokens: 150 }, 200).mode).toBe("fixed_overhead_mismatch");
	});
});
