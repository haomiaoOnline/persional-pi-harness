import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	createProtocolEnvelope,
	DEFAULT_ROLE_PROFILES,
	NoWorkerAvailableError,
	PiWorker,
	parseWorkerPluginManifest,
	type TaskContract,
	validateResultContract,
	WorkerRegistry,
} from "../src/index.ts";

const codexManifestUrl = new URL("../examples/worker-plugins/codex-cli.plugin_manifest.yaml", import.meta.url);
const claudeManifestUrl = new URL("../examples/worker-plugins/claude-cli.plugin_manifest.yaml", import.meta.url);

function makeTask(id = "registry-task", capabilityTags = ["coding", "shell"]): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "backend",
		title: "Registry task",
		objective: "Route one contract to a capable Worker",
		requirements: ["use a registered Worker"],
		constraints: [],
		scope: { files: ["src/service/api.ts"] },
		inputs: {},
		data_sources: ["local repository"],
		data_references: [],
		permissions: {
			filesystem: { read: ["src/**"], write: ["src/service/**"] },
			shell: { allowed: ["test"] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "cli",
			worker_tier: "standard",
			reasoning_depth: "high",
			capability_tags: capabilityTags,
			mode: "single",
			working_directory: ".",
			allowed_tools: ["repo", "shell"],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["verified result"],
		acceptance_criteria: ["result is independently verifiable"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 1000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
	};
}

function legalNoOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "registry contract validation does not create a file",
		evidence_refs: ["worker_result"],
	};
}

function manifest(url: URL) {
	const parsed = parseWorkerPluginManifest(readFileSync(url, "utf8"));
	if (!parsed.valid || !parsed.value) throw new Error(parsed.errors.join("; "));
	return parsed.value;
}

function registerTwoWorkers(registry: WorkerRegistry): void {
	registry.register({
		worker_id: "codex-worker",
		worker_type: "cli",
		manifest: manifest(codexManifestUrl),
		adapter: new PiWorker("codex-worker", () => ({
			status: "success",
			summary: "codex adapter result",
			evidence: ["worker_result"],
			work_receipt: legalNoOpReceipt(),
		})),
		capabilities: { languages: ["typescript"], latency_ms: 120 },
	});
	registry.register({
		worker_id: "claude-worker",
		worker_type: "cli",
		manifest: manifest(claudeManifestUrl),
		adapter: new PiWorker("claude-worker", () => ({
			status: "success",
			summary: "claude adapter result",
			evidence: ["worker_result"],
			work_receipt: legalNoOpReceipt(),
		})),
		capabilities: { languages: ["typescript", "javascript"], latency_ms: 180 },
	});
}

describe("T12.1-T12.3 Worker Registry and Selection", () => {
	test("routes one Task Contract to two Worker types and validates both Results", async () => {
		const registry = new WorkerRegistry();
		registerTwoWorkers(registry);
		const task = makeTask();
		const candidates = registry.selectCandidates(task);

		expect(candidates.map((candidate) => candidate.worker_id)).toEqual(["codex-worker", "claude-worker"]);
		for (const candidate of candidates) {
			const result = await candidate.registration.adapter.execute({
				task,
				protocol: createProtocolEnvelope(task, 1, "registry-plan"),
				run_id: `${candidate.worker_id}-run`,
			});
			expect(validateResultContract(result).valid).toBe(true);
			expect(result.worker_id).toBe(candidate.worker_id);
		}
	});

	test("matches capability tags, reasoning depth, context limit, cost tier, and availability", () => {
		const registry = new WorkerRegistry();
		registerTwoWorkers(registry);

		expect(registry.select(makeTask()).worker_id).toBe("codex-worker");
		registry.setAvailability("codex-worker", false);
		expect(registry.select(makeTask()).worker_id).toBe("claude-worker");
		registry.setAvailability("claude-worker", false);
		expect(() => registry.select(makeTask())).toThrow(NoWorkerAvailableError);

		const browserTask = makeTask("browser-task", ["browser"]);
		registry.setAvailability("claude-worker", true);
		expect(registry.select(browserTask).worker_id).toBe("claude-worker");
	});

	test("enforces Role Profile boundaries before selection", () => {
		const registry = new WorkerRegistry();
		registerTwoWorkers(registry);
		const forbiddenTask = { ...makeTask("deploy-task"), type: "production_deploy" };

		expect(() => registry.select(forbiddenTask, DEFAULT_ROLE_PROFILES[0])).toThrow(NoWorkerAvailableError);
	});

	test("rejects duplicate IDs and adapter identity mismatches", () => {
		const registry = new WorkerRegistry();
		const plugin = manifest(codexManifestUrl);
		const adapter = new PiWorker("other-id", () => ({ status: "success", summary: "unused" }));

		expect(() =>
			registry.register({ worker_id: "codex-worker", worker_type: "cli", manifest: plugin, adapter }),
		).toThrow("adapter worker_id must match worker_id");
		registry.register({
			worker_id: "codex-worker",
			worker_type: "cli",
			manifest: plugin,
			adapter: new PiWorker("codex-worker", () => ({ status: "success", summary: "registered" })),
		});
		expect(() =>
			registry.register({
				worker_id: "codex-worker",
				worker_type: "cli",
				manifest: plugin,
				adapter: new PiWorker("codex-worker", () => ({ status: "success", summary: "duplicate" })),
			}),
		).toThrow("worker already registered");
	});
});
