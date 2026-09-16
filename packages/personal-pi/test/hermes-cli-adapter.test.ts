import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	createCliObservation,
	createProtocolEnvelope,
	HermesCliWorkerAdapter,
	type JsonlProcessOptions,
	parseWorkerPluginManifest,
	type TaskContract,
	WorkerRegistry,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

const MODEL = "ArkCoding/deepseek-v4-flash-ga-260731";
const RUN_ID = "pph-hermes-test-run";
const manifestUrl = new URL("../examples/worker-plugins/hermes-cli-custom.plugin_manifest.yaml", import.meta.url);
const bridgeUrl = new URL("../scripts/hermes-worker-bridge.py", import.meta.url);

function syntheticTask(overrides: Partial<TaskContract> = {}): TaskContract {
	const base = makeV3Task("hermes-adapter-task", {
		objective: "PPH_SYNTHETIC_HERMES_PROBE_v1",
		execution: {
			...makeV3Task("hermes-adapter-task").execution,
			worker_type: "cli",
			reasoning_depth: "high",
			allowed_tools: [],
		},
	});
	return {
		...base,
		permissions: { ...base.permissions, network: "deny", credentials: "deny" },
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 4000 } },
		inputs: {},
		...overrides,
	};
}

function resultText(summary = "HERMES_TEST_OK"): string {
	return JSON.stringify({
		status: "success",
		summary,
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors: [],
		work_receipt: {
			work_attempted: true,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: true,
			no_op_reason: "synthetic Hermes adapter test",
			evidence_refs: [],
		},
	});
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function protocolRequest(task: TaskContract = syntheticTask()) {
	return {
		task,
		protocol: createProtocolEnvelope(task, 1, "hermes-test-plan"),
		run_id: RUN_ID,
		requested_actions: [],
		permission_request: {},
	};
}

function fakeRunner(captured: { options?: JsonlProcessOptions }) {
	return async (options: JsonlProcessOptions) => {
		captured.options = options;
		const observation = createCliObservation();
		const text = resultText();
		const identity = {
			pph_run_id: RUN_ID,
			hermes_session_id: "hermes-session-test",
			hermes_task_id: "hermes-task-test",
			api_call_count: 1,
			started_at: "2026-09-16T00:00:00.000Z",
			ended_at: "2026-09-16T00:00:01.000Z",
			api_duration: 1,
			provider: "custom",
			configured_model: MODEL,
			response_model: MODEL,
			api_mode: "chat_completions",
			base_url_host: "127.0.0.1",
			response_id: null,
			request_id: null,
			finish_reason: "stop",
			usage: { input_tokens: 32, output_tokens: 12, total_tokens: 44 },
			cli_path: "/usr/local/bin/hermes",
			cli_version: "Hermes Agent v0.18.2",
			identity_source: "post_api_request.response_model",
			source_event: "post_api_request",
		};
		observation.parsed_events = 2;
		options.on_event({ type: "hermes.identity", identity }, observation);
		options.on_event(
			{ type: "hermes.result", text, result_digest: digest(text), prompt_response_captured: false },
			observation,
		);
		observation.exit_code = 0;
		return { observation };
	};
}

describe("T14.2 Hermes CLI Worker Adapter", () => {
	test("validates the static manifest and fixed synthetic bridge boundary", () => {
		const manifest = parseWorkerPluginManifest(readFileSync(manifestUrl, "utf8"));
		expect(manifest.valid).toBe(true);
		expect(manifest.value?.worker_plugin.models_supported[0]?.model).toBe(MODEL);
		expect(manifest.value?.worker_plugin.auth).toEqual({ type: "none" });
		const entryPath = join(
			dirname(fileURLToPath(manifestUrl)),
			"..",
			"..",
			manifest.value?.worker_plugin.adapter_entry ?? "",
		);
		expect(existsSync(entryPath)).toBe(true);
		const registry = new WorkerRegistry();
		registry.registerManifest({
			worker_id: "hermes-manifest-worker",
			worker_type: "cli",
			adapter: new HermesCliWorkerAdapter({ worker_id: "hermes-manifest-worker" }),
			source: readFileSync(manifestUrl, "utf8"),
		});
		expect(registry.select(syntheticTask()).worker_id).toBe("hermes-manifest-worker");
		const bridge = readFileSync(bridgeUrl, "utf8");
		expect(bridge).toContain("PPH_SYNTHETIC_HERMES_PROBE_v1");
		expect(bridge).not.toContain("sys.stdin.read");
		expect(bridge).toContain("use_config_toolsets=False");
		expect(bridge).toContain('register_hook("post_api_request"');
	});

	test("runs a same-run identity-attested no-op result through the adapter", async () => {
		const captured: { options?: JsonlProcessOptions } = {};
		const adapter = new HermesCliWorkerAdapter({
			worker_id: "hermes-test-worker",
			model: MODEL,
			provider: "custom",
			bridge_script: fileURLToPath(bridgeUrl),
			run_process: fakeRunner(captured),
		});

		const result = await adapter.execute(protocolRequest());
		const observation = adapter.getLastObservation();

		expect(result.status).toBe("success");
		expect(result.run_id).toBe(RUN_ID);
		expect(result.worker_id).toBe("hermes-test-worker");
		expect(result.work_receipt?.no_op).toBe(true);
		expect(captured.options?.stdin).toBe("");
		expect(captured.options?.args).toEqual([
			fileURLToPath(bridgeUrl),
			"--hermes-command",
			"hermes",
			"--provider",
			"custom",
			"--model",
			MODEL,
			"--pph-run-id",
			RUN_ID,
		]);
		expect(observation?.runtime_identity?.hermes_session_id).toBe("hermes-session-test");
		expect(observation?.runtime_identity?.hermes_task_id).toBe("hermes-task-test");
		expect(observation?.runtime_identity?.response_model).toBe(MODEL);
		expect(observation?.observed_runtime_model).toBe(MODEL);
		expect(observation?.platform_accepted_model).toBe(MODEL);
		expect(observation?.provider).toBe("custom");
		expect(observation?.runtime_identity?.identity_source).toBe("post_api_request.response_model");
		expect(observation?.result_digest).toBeTruthy();
		expect(observation?.work_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
		expect(observation?.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
		expect(result.evidence).toContain("hermes-cli:identity_source=post_api_request.response_model");
		expect(result.evidence).toContain("hermes-cli:api_call_count=1");
	});

	test("fails closed when a tool, context, or response-side identity is outside the boundary", async () => {
		let calls = 0;
		const runner = async (options: JsonlProcessOptions) => {
			calls += 1;
			return fakeRunner({ options })(options);
		};
		const adapter = new HermesCliWorkerAdapter({ run_process: runner, bridge_script: fileURLToPath(bridgeUrl) });

		const toolResult = await adapter.execute(
			protocolRequest({
				...syntheticTask(),
				execution: { ...syntheticTask().execution, allowed_tools: ["shell"] },
			}),
		);
		expect(toolResult.status).toBe("failure");
		expect(calls).toBe(0);

		const contextResult = await adapter.execute(
			protocolRequest({
				...syntheticTask(),
				context: { required: ["fixture"], optional: [], excluded: [], budget: { max_input_tokens: 4000 } },
			}),
		);
		expect(contextResult.status).toBe("failure");
		expect(calls).toBe(0);

		const identityRunner = async (options: JsonlProcessOptions) => {
			const observation = createCliObservation();
			const text = resultText();
			options.on_event(
				{
					type: "hermes.identity",
					identity: {
						pph_run_id: RUN_ID,
						hermes_session_id: "session",
						hermes_task_id: "task",
						api_call_count: 1,
						started_at: "2026-09-16T00:00:00.000Z",
						ended_at: "2026-09-16T00:00:01.000Z",
						provider: "custom",
						configured_model: MODEL,
						response_model: "untrusted/other-model",
						base_url_host: "127.0.0.1",
						identity_source: "post_api_request.response_model",
						source_event: "post_api_request",
					},
				},
				observation,
			);
			options.on_event({ type: "hermes.result", text, result_digest: digest(text) }, observation);
			observation.exit_code = 0;
			return { observation };
		};
		const identityAdapter = new HermesCliWorkerAdapter({
			run_process: identityRunner,
			bridge_script: fileURLToPath(bridgeUrl),
		});
		const identityResult = await identityAdapter.execute(protocolRequest());
		expect(identityResult.status).toBe("failure");
		expect(identityResult.errors.join(" ")).toContain("observed_response_model");
	});
});
