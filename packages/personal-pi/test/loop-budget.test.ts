import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	LeaseManager,
	LoopBudgetController,
	LoopBudgetExhaustedError,
	PersistentStateStore,
	RecoveryManager,
	type TaskContract,
	TaskStateMachine,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

function makeTask(id: string): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Loop budget task",
		objective: "exercise a bounded retry path",
		requirements: ["stop after the global budget"],
		constraints: [],
		scope: { files: ["packages/personal-pi/src/index.ts"] },
		inputs: {},
		data_sources: ["local repository"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "cheap",
			reasoning_depth: "low",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["bounded outcome"],
		acceptance_criteria: ["budget is enforced"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 100 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: {
			max_attempts: 1,
			max_model_calls: 2,
			max_tool_calls: 3,
			max_handoffs: 0,
			max_elapsed_ms: 60000,
			max_input_tokens: 100,
			max_output_tokens: 100,
			max_cost_usd: 1,
			max_state_growth_bytes: 1000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T1.1-B Loop Budget", () => {
	test("persists cumulative usage and blocks after controller restart", () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-loop-budget-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const task = makeTask("loop-persist");
		const store = new PersistentStateStore(statePath);
		store.createTask(task);
		const controller = new LoopBudgetController(store);

		expect(controller.beforeRun(task).attempts).toBe(1);
		expect(
			controller.record(task, {
				model_calls: 1,
				tool_calls: 2,
				input_tokens: 10,
				output_tokens: 5,
				cost_usd: 0.1,
				state_growth_bytes: 4,
			}).attempts,
		).toBe(1);

		const restarted = new PersistentStateStore(statePath);
		expect(restarted.getLoopUsage(task.id)).toEqual({
			attempts: 1,
			model_calls: 1,
			tool_calls: 2,
			handoffs: 0,
			elapsed_ms: 0,
			input_tokens: 10,
			output_tokens: 5,
			cost_usd: 0.1,
			state_growth_bytes: 4,
		});
		expect(() => new LoopBudgetController(restarted).beforeRun(task)).toThrow(LoopBudgetExhaustedError);
	});

	test("checks model, tool, and handoff budgets before each call", () => {
		const store = new PersistentStateStore();
		store.createTask(makeTask("loop-call-limits"));
		const controller = new LoopBudgetController(store);
		const task = makeTask("loop-call-limits");

		expect(controller.beforeModelCall(task).model_calls).toBe(1);
		expect(controller.beforeToolCall(task).tool_calls).toBe(1);
		expect(() => controller.beforeHandoff(task)).toThrow(LoopBudgetExhaustedError);
	});

	test("blocks a repeated failure across Runs even when retry_policy allows another attempt", () => {
		const store = new PersistentStateStore();
		const leaseManager = new LeaseManager();
		const task = makeTask("loop-recovery");
		let record = store.createTask(task);
		const machine = new TaskStateMachine();
		record = store.updateTask(machine.transition(record, "READY", "ready"));
		record = store.updateTask(machine.transition(record, "RUNNING", "started"));
		const lease = leaseManager.acquire(task.id, "worker-a");
		const run = store.createRun(task.id, "worker-a", lease.lease_epoch);
		new LoopBudgetController(store).beforeRun(task);

		const recovery = new RecoveryManager(store, leaseManager).recover({
			task_id: task.id,
			run_id: run.id,
			fault: "crash",
			worker_id: "worker-a",
			candidate_worker_id: "worker-b",
		});

		expect(recovery.action).toBe("BLOCK");
		expect(recovery.task.state).toBe("BLOCKED");
		expect(recovery.decision.reason).toContain("failed_attempts=1");
		expect(store.getLoopUsage(task.id).attempts).toBe(1);
	});
});
