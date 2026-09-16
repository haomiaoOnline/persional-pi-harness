import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	AgyCliWorkerAdapter,
	createCliObservation,
	createProtocolEnvelope,
	type JsonlProcessOptions,
	type JsonlProcessResult,
	parseWorkerPluginManifest,
	WorkerRegistry,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

const manifestUrl = new URL(
	"../examples/worker-plugins/agy-cli-existing-session.plugin_manifest.yaml",
	import.meta.url,
);

function candidateTask(id: string) {
	return makeV3Task(id, {
		type: "cli",
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "cli",
			worker_tier: "standard",
			reasoning_depth: "low",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
	});
}

function responseText(evidence = "agy-candidate-test"): string {
	return JSON.stringify({
		status: "success",
		summary: "bounded Agy candidate result",
		changed_files: [],
		artifacts: [],
		evidence: [evidence],
		errors: [],
		work_receipt: {
			work_attempted: true,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: true,
			no_op_reason: "read-only candidate verification",
			evidence_refs: [evidence],
		},
	});
}

function fakeRunner(
	events: unknown[],
	seen: JsonlProcessOptions[],
): (options: JsonlProcessOptions) => Promise<JsonlProcessResult> {
	return async (options) => {
		seen.push(options);
		const observation = createCliObservation();
		for (const event of events) {
			const decision = options.on_event(event, observation);
			if (decision?.terminate) {
				observation.protocol_error ??= decision.reason;
				observation.policy_terminated = true;
				break;
			}
		}
		observation.exit_code = 0;
		return { observation };
	};
}

function eventStream(options: { responseModel?: string; provider?: string; requestId?: string } = {}): unknown[] {
	const response = responseText();
	const responseMetadata = {
		conversation_id: "agy-conversation-test-1",
		...(options.responseModel ? { response_model: options.responseModel } : {}),
		...(options.provider ? { provider: options.provider } : {}),
		...(options.requestId ? { request_id: options.requestId } : {}),
	};
	return [
		{
			event: "init",
			conversation_id: "agy-conversation-test-1",
			init: { model: "gemini-3.8-flash-low" },
		},
		{
			event: "step_update",
			step_update: {
				...responseMetadata,
				step_index: 1,
				state: "ACTIVE",
				step_type: "agent_response",
				text_delta: response,
			},
		},
		{
			event: "step_update",
			step_update: {
				...responseMetadata,
				step_index: 1,
				state: "DONE",
				step_type: "agent_response",
				usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
			},
		},
		{
			event: "result",
			result: {
				...responseMetadata,
				status: "SUCCESS",
				response,
				finish_reason: "stop",
				usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
			},
		},
	];
}

function requestFor(task: ReturnType<typeof candidateTask>) {
	return {
		task,
		protocol: createProtocolEnvelope(task, 1, "agy-candidate-plan"),
		run_id: "agy-candidate-run",
	};
}

describe("Agy CLI candidate adapter boundary", () => {
	test("registers the real Agy manifest and stays heterogeneous with pi-agent", () => {
		const parsed = parseWorkerPluginManifest(readFileSync(manifestUrl, "utf8"));
		expect(parsed.valid).toBe(true);
		if (!parsed.valid || !parsed.value) throw new Error(parsed.errors.join("; "));

		const adapter = new AgyCliWorkerAdapter({
			worker_id: "agy-cli-existing-session",
			run_process: fakeRunner([], []),
		});
		const registry = new WorkerRegistry();
		const registered = registry.register({
			worker_id: adapter.worker_id,
			worker_type: "cli",
			manifest: parsed.value,
			adapter,
		});

		expect(registered.manifest.worker_plugin.adapter_entry).toBe("adapters/agy-cli.ts");
		expect(registered.manifest.worker_plugin.models_supported[0]?.model).toBe("gemini-3.8-flash-low");
		expect(adapter.backend).toBe("agy-cli");
		expect(adapter.backend).not.toBe("pi-agent");
		expect(registry.select(candidateTask("agy-registry-task")).worker_id).toBe(adapter.worker_id);
	});

	test("fails closed when only configured model and conversation identity are present", async () => {
		const seen: JsonlProcessOptions[] = [];
		const adapter = new AgyCliWorkerAdapter({ run_process: fakeRunner(eventStream(), seen) });
		const result = await adapter.execute(requestFor(candidateTask("agy-no-attestation")));

		expect(result.status).toBe("failure");
		expect(result.summary).toContain("runtime identity was not attested");
		expect(result.errors).toEqual(
			expect.arrayContaining(["runtime_identity_unavailable", "missing_response_model", "missing_provider_backend"]),
		);
		expect(result.work_receipt?.no_op).toBe(true);
		expect(adapter.getLastAgyRun()).toMatchObject({
			conversation_id_sha256: createHash("sha256").update("agy-conversation-test-1").digest("hex").slice(0, 16),
			configured_model: "gemini-3.8-flash-low",
			observed_runtime_model: null,
			provider_backend: null,
			identity_source: "none",
		});
		expect(adapter.getLastObservation()).toMatchObject({
			backend: "agy-cli",
			platform_accepted_model: null,
			observed_runtime_model: null,
			provider: null,
		});
		expect(seen[0]?.args).toEqual(
			expect.arrayContaining(["--output-format", "stream-json", "--model", "gemini-3.8-flash-low"]),
		);
		expect(seen[0]?.args.join(" ")).not.toContain("agy-candidate-run");
	});

	test("accepts response-side model/provider and preserves request correlation as digests", async () => {
		const seen: JsonlProcessOptions[] = [];
		const adapter = new AgyCliWorkerAdapter({
			run_process: fakeRunner(
				eventStream({
					responseModel: "gemini-3.8-flash-low-observed",
					provider: "google-antigravity",
					requestId: "agy-request-test-1",
				}),
				seen,
			),
		});
		const result = await adapter.execute(requestFor(candidateTask("agy-attested")));

		expect(result.status).toBe("success");
		expect(result.errors).toEqual([]);
		expect(adapter.getLastAgyRun()).toMatchObject({
			observed_runtime_model: "gemini-3.8-flash-low-observed",
			provider_backend: "google-antigravity",
			request_id_sha256: createHash("sha256").update("agy-request-test-1").digest("hex").slice(0, 16),
			identity_source: "agy-stream-json-response",
			finish_reason: "stop",
		});
		expect(adapter.getLastObservation()).toMatchObject({
			observed_runtime_model: "gemini-3.8-flash-low-observed",
			provider: "google-antigravity",
		});
	});
});
