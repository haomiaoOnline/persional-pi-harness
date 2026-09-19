import { describe, expect, test } from "vitest";
import {
	AgyCliWorkerAdapter,
	buildPromptViewAudit,
	CodexCliWorkerAdapter,
	createCliObservation,
	type JsonlProcessOptions,
	type LoopUsage,
	legalNoOpReceipt,
	PiAgentWorkerAdapter,
	PiWorker,
	type PromptViewAudit,
	type ResolvedContext,
	type TaskContract,
	type ToolResultEnvelope,
	TraceRecorder,
	type WorkerExecutionControls,
	WorkerPool,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

function usage(): LoopUsage {
	return {
		attempts: 1,
		model_calls: 1,
		tool_calls: 0,
		handoffs: 0,
		elapsed_ms: 0,
		input_tokens: 0,
		output_tokens: 0,
		cost_usd: 0,
		state_growth_bytes: 0,
	};
}

function controls(audits: PromptViewAudit[], options: { throwAudit?: boolean } = {}): WorkerExecutionControls {
	return {
		beforeModelCall: usage,
		beforeToolCall: usage,
		observePromptViewAudit: (audit) => {
			if (options.throwAudit) throw new Error("observability sink unavailable");
			audits.push(audit);
		},
	};
}

function requestFor(task: TaskContract, leaseEpoch = 1): WorkerProtocolRequest {
	return {
		task,
		protocol: {
			task_id: task.id,
			schema_version: 2,
			task_revision: task.task_revision,
			graph_revision: task.graph_revision,
			lease_epoch: leaseEpoch,
			idempotency_key: task.execution.idempotency_key,
		},
		run_id: `run-${task.id}`,
		requested_actions: [],
		permission_request: {},
	};
}

function successText(summary = "AUDIT_OK"): string {
	return JSON.stringify({
		status: "success",
		summary,
		changed_files: [],
		artifacts: [],
		evidence: ["prompt-view-audit"],
		errors: [],
		work_receipt: legalNoOpReceipt("prompt-view-audit no-op", ["prompt-view-audit"]),
	});
}

function resolvedContext(): ResolvedContext {
	return {
		items: [
			{ digest: "ctx-stale", content: "stale error context", token_estimate: 5 },
			{ digest: "ctx-compact", content: "safe\n…[compacted]…\nend", token_estimate: 5 },
		],
		text: "stale error context\nsafe\n…[compacted]…\nend",
		total_tokens: 10,
		cache_hit: false,
		omitted_optional: ["ctx-omitted"],
		manifest_digest: "manifest-audit",
	};
}

function failedTool(): ToolResultEnvelope {
	return {
		exit_code: 1,
		status: "failure",
		duration: 5,
		stdout_summary: "bounded stdout",
		stderr_summary: "bounded error",
		error_fingerprint: "fp-audit",
		relevant_stack_frames: [],
		artifact_id: "artifact-audit",
		truncated: true,
		next_cursor: "cursor-audit",
	};
}

describe("T11.4-B Prompt View Audit", () => {
	test("builds exact metadata from bounded prompt-view sources without persisting raw text", () => {
		const context = resolvedContext();
		const tool = failedTool();
		const promptText = `SECRET_PROMPT_BODY\n${context.text}`;
		const audit = buildPromptViewAudit({
			turn_id: "run-audit:1",
			prompt_text: promptText,
			resolved_context: context,
			tool_results: [tool],
		});

		expect(Object.keys(audit).sort()).toEqual(
			["contamination_ratio", "sources", "total_size", "truncated_items", "turn_id"].sort(),
		);
		expect(audit.total_size).toBe(
			Buffer.byteLength(promptText, "utf8") + Buffer.byteLength(JSON.stringify(tool), "utf8"),
		);
		expect(audit.sources).toEqual(["task_prompt", "context:ctx-stale", "context:ctx-compact", "tool:artifact-audit"]);
		expect(audit.truncated_items).toEqual(["context:ctx-omitted", "context:ctx-compact", "tool:artifact-audit"]);
		const expectedContaminatedBytes =
			Buffer.byteLength("stale error context", "utf8") + Buffer.byteLength(JSON.stringify(tool), "utf8");
		expect(audit.contamination_ratio).toBe(Math.min(1, expectedContaminatedBytes / audit.total_size));
		expect(JSON.stringify(audit)).not.toContain("SECRET_PROMPT_BODY");
		expect(JSON.stringify(audit)).not.toContain("stale error context");

		const recorder = new TraceRecorder("audit-task", "audit-trace");
		recorder.addPromptViewAudit({ ...audit, raw_prompt: "must-not-persist" } as PromptViewAudit);
		const persisted = recorder.snapshot().prompt_view_audits?.[0];
		expect(Object.keys(persisted ?? {}).sort()).toEqual(
			["contamination_ratio", "sources", "total_size", "truncated_items", "turn_id"].sort(),
		);
		expect(JSON.stringify(persisted)).not.toContain("must-not-persist");
	});

	test("records an initial Worker turn and treats audit sink failure as observability-only", async () => {
		const task = makeV3Task("prompt-worker", {
			execution: { ...makeV3Task("prompt-worker").execution, allowed_tools: [] },
		});
		const request = { ...requestFor(task), resolved_context: resolvedContext() };
		const audits: PromptViewAudit[] = [];
		const worker = new PiWorker("prompt-worker-id", () => ({ status: "success", summary: "ok" }));

		const result = await worker.execute(request, controls(audits));
		expect(result.status).toBe("success");
		expect(audits).toHaveLength(1);
		expect(audits[0]?.turn_id).toBe("run-prompt-worker:1");
		expect(audits[0]?.sources).toContain("context:ctx-stale");
		expect(JSON.stringify(audits[0])).not.toContain(task.objective);

		const ungated = await worker.execute(request, controls([], { throwAudit: true }));
		expect(ungated.status).toBe("success");
	});

	test("adds a second-turn audit for Pi and keeps a failing audit sink non-blocking", async () => {
		const task = makeV3Task("prompt-pi", {
			execution: { ...makeV3Task("prompt-pi").execution, allowed_tools: [] },
		});
		const audits: PromptViewAudit[] = [];
		let renderedPrompt = "";
		const adapter = new PiAgentWorkerAdapter({
			worker_id: "prompt-pi-worker",
			run_process: async (options) => {
				renderedPrompt = options.args.at(-1) ?? "";
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event({ type: "message_start", message: { role: "assistant" } }, observation);
				options.on_event({ type: "message_start", message: { role: "assistant" } }, observation);
				options.on_event(
					{
						type: "message_end",
						message: {
							role: "assistant",
							provider: "opencodex",
							model: "ArkCoding/deepseek-v4-flash-ga-260731",
							stopReason: "stop",
							usage: { input: 12, output: 8, totalTokens: 20, cost: { total: 0 } },
							content: [{ type: "text", text: successText("PI_AUDIT_OK") }],
						},
					},
					observation,
				);
				return { observation };
			},
		});
		const request = { ...requestFor(task), resolved_context: resolvedContext() };
		const result = await adapter.execute(request, controls(audits));
		expect(result.status).toBe("success");
		expect(audits.map((audit) => audit.turn_id)).toEqual(["run-prompt-pi:1", "run-prompt-pi:2"]);
		expect(audits[0]?.total_size).toBe(Buffer.byteLength(renderedPrompt, "utf8"));

		const ungated = await adapter.execute(request, controls([], { throwAudit: true }));
		expect(ungated.status).toBe("success");
	});

	test("records subsequent Codex and Agy provider turns", async () => {
		const codexTask = makeV3Task("prompt-codex", {
			execution: { ...makeV3Task("prompt-codex").execution, allowed_tools: [] },
		});
		const codexAudits: PromptViewAudit[] = [];
		const codex = new CodexCliWorkerAdapter({
			worker_id: "prompt-codex-worker",
			run_process: async (options: JsonlProcessOptions) => {
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event({ type: "turn.started" }, observation);
				options.on_event({ type: "turn_start" }, observation);
				options.on_event({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }, observation);
				options.on_event({ type: "turn.started" }, observation);
				options.on_event(
					{ type: "item.completed", item: { type: "agent_message", text: successText("CODEX_AUDIT_OK") } },
					observation,
				);
				options.on_event({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5 } }, observation);
				return { observation };
			},
		});
		const codexResult = await codex.execute(requestFor(codexTask), controls(codexAudits));
		expect(codexResult.status).toBe("success");
		expect(codexAudits.map((audit) => audit.turn_id)).toEqual(["run-prompt-codex:1", "run-prompt-codex:2"]);

		const agyTask = makeV3Task("prompt-agy", {
			execution: { ...makeV3Task("prompt-agy").execution, allowed_tools: [] },
		});
		const agyAudits: PromptViewAudit[] = [];
		const agy = new AgyCliWorkerAdapter({
			worker_id: "prompt-agy-worker",
			run_process: async (options: JsonlProcessOptions) => {
				const observation = createCliObservation();
				for (const stepIndex of [1, 1, 2])
					options.on_event(
						{
							event: "step_update",
							step_update: {
								step_index: stepIndex,
								state: "ACTIVE",
								step_type: "agent_response",
							},
						},
						observation,
					);
				options.on_event(
					{
						event: "result",
						result: {
							conversation_id: "prompt-agy-conversation",
							response_model: "gemini-3.8-flash-low",
							provider: "google-antigravity",
							status: "SUCCESS",
							response: successText("AGY_AUDIT_OK"),
							usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
						},
					},
					observation,
				);
				observation.exit_code = 0;
				return { observation };
			},
		});
		const agyResult = await agy.execute(requestFor(agyTask), controls(agyAudits));
		expect(agyResult.status).toBe("success");
		expect(agyAudits.map((audit) => audit.turn_id)).toEqual(["run-prompt-agy:1", "run-prompt-agy:2"]);
	});

	test("WorkerPool forwards Prompt View Audit callbacks without changing business execution", async () => {
		const task = makeV3Task("prompt-pool", {
			execution: { ...makeV3Task("prompt-pool").execution, allowed_tools: [] },
		});
		const audits: PromptViewAudit[] = [];
		const worker = new PiWorker("prompt-pool-worker", () => ({ status: "success", summary: "pool ok" }));
		const pool = new WorkerPool();
		pool.register({ worker_id: worker.worker_id, kind: "local_process_worker", adapter: worker });
		const lease = pool.acquire(task.id);
		const result = await pool.execute(lease, requestFor(task, lease.lease.lease_epoch), controls(audits));
		expect(result.status).toBe("success");
		expect(audits).toHaveLength(1);
		expect(pool.release(lease)).toBe(true);
	});
});
