import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	CONTEXT_BUDGET_LAYERS,
	CONTEXT_BUDGET_WATERMARKS,
	ContextBudgetController,
	type ContextBudgetMetrics,
	createContextBudgetState,
	evaluateContextBudgetWatermark,
	normalizePersistentState,
	type PersistentState,
	PersistentStateStore,
	taskContextMetricsFromLoopUsage,
	updateContextBudgetLayer,
	zeroContextBudgetMetrics,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

function metrics(tokens: number): ContextBudgetMetrics {
	return {
		tokens,
		tool_calls: 2,
		raw_log_bytes: 300,
		injected_context_bytes: 400,
		duplicate_ratio: 0.25,
		state_growth_bytes: 500,
		elapsed_ms: 600,
		retries: 1,
	};
}

function storeWithRun(statePath?: string) {
	const store = new PersistentStateStore(statePath);
	const task = store.createTask(makeV3Task("context-budget-task"));
	const run = store.createRun(task.id, "worker-context", 1, {
		worker_status: AVAILABLE_WORKER_STATUS,
		model_identity: UNKNOWN_MODEL_IDENTITY,
	});
	return { store, task, run };
}

describe("T6.3-A context budget domain/state", () => {
	test("defines exactly four layers and four watermarks", () => {
		expect(CONTEXT_BUDGET_LAYERS).toEqual(["tool_output", "prompt", "run", "task"]);
		expect(CONTEXT_BUDGET_WATERMARKS).toEqual(["LOW", "WARNING", "REBUILD", "HARD"]);

		const state = createContextBudgetState({
			task_id: "task",
			run_id: "run",
			context_limit: 100,
			layer_token_limits: { tool_output: 10, prompt: 20, run: 50, task: 100 },
			updated_at: "2026-09-18T12:00:00.000Z",
		});
		expect(Object.keys(state.layers).sort()).toEqual([...CONTEXT_BUDGET_LAYERS].sort());
		expect(Object.keys(state.layers.tool_output.metrics).sort()).toEqual(
			[
				"tokens",
				"tool_calls",
				"raw_log_bytes",
				"injected_context_bytes",
				"duplicate_ratio",
				"state_growth_bytes",
				"elapsed_ms",
				"retries",
			].sort(),
		);
	});

	test("uses exact fixed token ratios for LOW/WARNING/REBUILD/HARD", () => {
		expect(evaluateContextBudgetWatermark(metrics(59), 100)).toBe("LOW");
		expect(evaluateContextBudgetWatermark(metrics(60), 100)).toBe("WARNING");
		expect(evaluateContextBudgetWatermark(metrics(75), 100)).toBe("REBUILD");
		expect(evaluateContextBudgetWatermark(metrics(100), 100)).toBe("HARD");
		expect(evaluateContextBudgetWatermark(metrics(101), 100)).toBe("HARD");
	});

	test("malformed accounting conservatively evaluates to REBUILD", () => {
		for (const malformed of [
			{ ...metrics(10), tokens: Number.NaN },
			{ ...metrics(10), tool_calls: -1 },
			{ ...metrics(10), raw_log_bytes: Number.POSITIVE_INFINITY },
			{ ...metrics(10), injected_context_bytes: -1 },
			{ ...metrics(10), duplicate_ratio: 1.01 },
			{ ...metrics(10), duplicate_ratio: -0.01 },
			{ ...metrics(10), state_growth_bytes: -1 },
			{ ...metrics(10), elapsed_ms: -1 },
			{ ...metrics(10), retries: -1 },
		])
			expect(evaluateContextBudgetWatermark(malformed, 100)).toBe("REBUILD");
		expect(evaluateContextBudgetWatermark(metrics(10), 0)).toBe("REBUILD");
		expect(evaluateContextBudgetWatermark(metrics(10), Number.NaN)).toBe("REBUILD");
	});

	test("persists every required metric, per-layer watermark, run id and context limit across restart", () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-context-budget-"));
		temporaryDirectories.push(root);
		const statePath = join(root, "state.json");
		const { store, task, run } = storeWithRun(statePath);
		const controller = new ContextBudgetController();
		let state = controller.create({
			task_id: task.id,
			run_id: run.id,
			context_limit: 1_000,
			layer_token_limits: { tool_output: 100, prompt: 100, run: 100, task: 100 },
			updated_at: "2026-09-18T12:00:00.000Z",
		});
		state = controller.updateLayer(state, "tool_output", metrics(59), "2026-09-18T12:01:00.000Z");
		state = controller.updateLayer(state, "prompt", metrics(60), "2026-09-18T12:02:00.000Z");
		state = controller.updateLayer(state, "run", metrics(75), "2026-09-18T12:03:00.000Z");
		state = controller.updateLayer(state, "task", metrics(100), "2026-09-18T12:04:00.000Z");
		store.saveContextBudgetState(state);

		const restarted = new PersistentStateStore(statePath);
		const persisted = restarted.getContextBudgetState(task.id);
		expect(persisted).toEqual(state);
		expect(persisted?.run_id).toBe(run.id);
		expect(persisted?.context_limit).toBe(1_000);
		expect(persisted?.layers.tool_output).toEqual({ token_limit: 100, metrics: metrics(59), watermark: "LOW" });
		expect(persisted?.layers.prompt).toEqual({ token_limit: 100, metrics: metrics(60), watermark: "WARNING" });
		expect(persisted?.layers.run).toEqual({ token_limit: 100, metrics: metrics(75), watermark: "REBUILD" });
		expect(persisted?.layers.task).toEqual({ token_limit: 100, metrics: metrics(100), watermark: "HARD" });

		const updated = restarted.updateContextBudgetState(task.id, (current) =>
			updateContextBudgetLayer(current, "prompt", metrics(74), "2026-09-18T12:05:00.000Z"),
		);
		expect(updated.layers.prompt.watermark).toBe("WARNING");
		expect(new PersistentStateStore(statePath).getContextBudgetState(task.id)).toEqual(updated);
	});

	test("evaluates each layer against its own positive token limit", () => {
		let state = createContextBudgetState({
			task_id: "task",
			run_id: "run",
			context_limit: 1_000,
			layer_token_limits: { tool_output: 10, prompt: 100, run: 200, task: 400 },
			updated_at: "2026-09-18T12:00:00.000Z",
		});
		state = updateContextBudgetLayer(state, "tool_output", metrics(6));
		state = updateContextBudgetLayer(state, "prompt", metrics(59));
		state = updateContextBudgetLayer(state, "run", metrics(150));
		state = updateContextBudgetLayer(state, "task", metrics(400));
		expect(state.layers.tool_output.watermark).toBe("WARNING");
		expect(state.layers.prompt.watermark).toBe("LOW");
		expect(state.layers.run.watermark).toBe("REBUILD");
		expect(state.layers.task.watermark).toBe("HARD");
	});

	test("maps existing loop usage into task-layer accounting without changing unrelated metrics", () => {
		const current = metrics(1);
		const mapped = taskContextMetricsFromLoopUsage(
			{
				attempts: 3,
				model_calls: 7,
				tool_calls: 9,
				handoffs: 2,
				elapsed_ms: 1234,
				input_tokens: 40,
				output_tokens: 15,
				cost_usd: 0.1,
				state_growth_bytes: 456,
			},
			current,
		);
		expect(mapped).toEqual({
			tokens: 55,
			tool_calls: 9,
			raw_log_bytes: current.raw_log_bytes,
			injected_context_bytes: current.injected_context_bytes,
			duplicate_ratio: current.duplicate_ratio,
			state_growth_bytes: 456,
			elapsed_ms: 1234,
			retries: 2,
		});
	});

	test("legacy version-2 state normalizes context budget to empty", () => {
		const normalized = normalizePersistentState({ version: 2 } as Partial<PersistentState>);
		expect(normalized.version).toBe(2);
		expect(normalized.context_budget).toEqual({});
		expect(zeroContextBudgetMetrics()).toEqual({
			tokens: 0,
			tool_calls: 0,
			raw_log_bytes: 0,
			injected_context_bytes: 0,
			duplicate_ratio: 0,
			state_growth_bytes: 0,
			elapsed_ms: 0,
			retries: 0,
		});
	});
});
