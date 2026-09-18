import { describe, expect, test } from "vitest";
import {
	ContextResolver,
	ContextStore,
	captureWorkspaceSnapshot,
	PersistentStateStore,
	PersonalPiPipeline,
	type ResultContract,
	type TaskContract,
	type WorkerAdapter,
	type WorkerExecutionControls,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, boundedLoopBudget, makeV3Task, planFor, requirementFor } from "./v3-fixtures.ts";

function metrics(tokens: number) {
	return {
		tokens,
		tool_calls: 0,
		raw_log_bytes: 0,
		injected_context_bytes: 0,
		duplicate_ratio: 0,
		state_growth_bytes: 0,
		elapsed_ms: 1,
		retries: 0,
	};
}

function taskFor(id: string, overrides: Partial<TaskContract> = {}): TaskContract {
	const base = makeV3Task(id);
	return makeV3Task(id, {
		execution: { ...base.execution, allowed_tools: [] },
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 100 } },
		loop_budget: boundedLoopBudget({
			max_attempts: 3,
			max_model_calls: 3,
			max_input_tokens: 1000,
			max_output_tokens: 1000,
		}),
		...overrides,
	});
}

function successResult(request: WorkerProtocolRequest, workerId: string): ResultContract {
	return {
		task_id: request.task.id,
		run_id: request.run_id as string,
		worker_id: workerId,
		lease_epoch: request.protocol.lease_epoch,
		status: "success",
		summary: "rebuilt context completed",
		changed_files: [],
		artifacts: [],
		evidence: ["worker_result"],
		errors: [],
		model_identity: {
			requested_model: "fake-model",
			platform_accepted_model: "fake-model",
			observed_runtime_model: "fake-model",
		},
		work_receipt: {
			work_attempted: true,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: true,
			no_op_reason: "context-budget orchestration verification",
			evidence_refs: ["worker_result"],
		},
	};
}

class RebuildingWorker implements WorkerAdapter {
	readonly worker_id = "context-rebuilding-worker";
	readonly requested_model = "fake-model";
	readonly context_limit = 100;
	calls = 0;
	providerLimitTriggered = false;
	readonly seenContexts: string[] = [];

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		this.calls += 1;
		this.seenContexts.push(request.resolved_context?.text ?? "");
		if (this.calls === 1) {
			controls?.observeContextUsage?.({ layer: "run", metrics: metrics(60) });
			controls?.observeContextUsage?.({ layer: "run", metrics: metrics(75) });
			this.providerLimitTriggered = true;
			throw new Error("provider context-limit");
		}
		controls?.observeContextUsage?.({ layer: "run", metrics: metrics(20) });
		return successResult(request, this.worker_id);
	}
}

describe("T6.3-A context budget orchestration", () => {
	test("rebuilds before provider context-limit, starts a fresh Run, and suppresses optional context after WARNING", async () => {
		const contextStore = new ContextStore();
		const required = contextStore.put("REQUIRED_CONTEXT_MARKER");
		const optional = contextStore.put("OPTIONAL_CONTEXT_MARKER");
		const resolver = new ContextResolver(contextStore);
		const task = taskFor("context-rebuild-long-flow", {
			context: {
				required: [required.digest],
				optional: [optional.digest],
				excluded: [],
				budget: { max_input_tokens: 100 },
			},
		});
		const store = new PersistentStateStore();
		const worker = new RebuildingWorker();
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirementFor(),
			task,
			worker,
			worker_status: AVAILABLE_WORKER_STATUS,
			context_resolver: resolver,
			snapshot: captureWorkspaceSnapshot("context-rebuild-baseline", [], []),
			at: "2026-09-19T00:00:00.000Z",
		});

		expect(execution.task.state).toBe("DONE");
		expect(worker.calls).toBe(2);
		expect(worker.providerLimitTriggered).toBe(false);
		expect(worker.seenContexts[0]).toContain("OPTIONAL_CONTEXT_MARKER");
		expect(worker.seenContexts[1]).toContain("REQUIRED_CONTEXT_MARKER");
		expect(worker.seenContexts[1]).not.toContain("OPTIONAL_CONTEXT_MARKER");
		expect(worker.seenContexts[1]).toContain("context rebuild");

		const state = store.read();
		const runs = state.runs.filter((run) => run.task_id === task.id);
		expect(runs).toHaveLength(2);
		expect(runs[0]?.status).toBe("SUCCEEDED");
		expect(runs[0]?.result_id).toBeUndefined();
		expect(runs[0]?.ended_at).toBeDefined();
		expect(runs[1]?.status).toBe("SUCCEEDED");
		expect(state.results.filter((result) => result.task_id === task.id)).toHaveLength(1);
		expect(state.evidence.filter((record) => record.task_id === task.id)).toHaveLength(1);
		expect(state.acceptances.filter((record) => record.task_id === task.id)).toHaveLength(1);
		expect(state.acceptances.find((record) => record.task_id === task.id)?.run_id).toBe(runs[1]?.id);
		expect(state.context_budget[task.id]?.run_id).toBe(runs[1]?.id);
	});

	test("malformed accounting conservatively rebuilds instead of continuing the same Run", async () => {
		const task = taskFor("context-rebuild-malformed");
		const store = new PersistentStateStore();
		let calls = 0;
		let leakedPastMalformedAccounting = false;
		const worker: WorkerAdapter = {
			worker_id: "malformed-accounting-worker",
			requested_model: "fake-model",
			context_limit: 100,
			async execute(request, controls) {
				calls += 1;
				if (calls === 1) {
					controls?.observeContextUsage?.({ layer: "run", metrics: metrics(Number.NaN) });
					leakedPastMalformedAccounting = true;
					throw new Error("malformed accounting was ignored");
				}
				return successResult(request, this.worker_id);
			},
		};

		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirementFor(),
			task,
			worker,
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("malformed-baseline", [], []),
			at: "2026-09-19T00:01:00.000Z",
		});

		expect(execution.task.state).toBe("DONE");
		expect(calls).toBe(2);
		expect(leakedPastMalformedAccounting).toBe(false);
		expect(store.getRuns(task.id)).toHaveLength(2);
		expect(store.getRuns(task.id)[0]?.status).toBe("SUCCEEDED");
		expect(store.getRuns(task.id)[0]?.result_id).toBeUndefined();
	});

	test("HARD watermark reuses the existing LoopBudget BLOCKED path", async () => {
		const task = taskFor("context-hard-blocked");
		const store = new PersistentStateStore();
		const worker: WorkerAdapter = {
			worker_id: "hard-watermark-worker",
			requested_model: "fake-model",
			context_limit: 100,
			async execute(request, controls) {
				controls?.observeContextUsage?.({ layer: "run", metrics: metrics(100) });
				return successResult(request, this.worker_id);
			},
		};

		await expect(
			new PersonalPiPipeline({ state_store: store }).execute({
				...planFor(task),
				requirement: requirementFor(),
				task,
				worker,
				worker_status: AVAILABLE_WORKER_STATUS,
				snapshot: captureWorkspaceSnapshot("hard-baseline", [], []),
				at: "2026-09-19T00:02:00.000Z",
			}),
		).rejects.toThrow("context HARD watermark");

		expect(store.getTask(task.id)?.state).toBe("BLOCKED");
		expect(store.getRuns(task.id)).toHaveLength(1);
		expect(store.getContextBudgetState(task.id)?.layers.run.watermark).toBe("HARD");
		expect(store.read().acceptances.filter((record) => record.task_id === task.id)).toHaveLength(0);
	});
});
