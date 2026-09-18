import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	auditBoundCoverage,
	BudgetController,
	BudgetExceededError,
	DynamicDecomposer,
	graphNodeForTask,
	LeaseManager,
	LoopBudgetController,
	LoopBudgetExhaustedError,
	LoopBudgetMissingError,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	RecoveryManager,
	TaskGraphStore,
	TaskStateMachine,
	V3_FEEDBACK_PATHS,
} from "../src/index.ts";
import {
	AVAILABLE_WORKER_STATUS,
	boundedLoopBudget,
	makeV3Task,
	planFor,
	requirementFor,
	UNKNOWN_MODEL_IDENTITY,
} from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T1.1-B loop budget runtime integration", () => {
	test("bounds Worker -> Verifier FAIL -> Repair -> Worker across Runs", async () => {
		const store = new PersistentStateStore();
		const task = makeV3Task("repair-loop", {
			verification: {
				strategy: "automated",
				commands: ["deterministic-check"],
				checks: ["command exits zero"],
				evidence_required: ["worker_result"],
				strength: "strong",
			},
			loop_budget: boundedLoopBudget({ max_attempts: 2, max_tool_calls: 2 }),
		});
		const first = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirementFor(),
			task,
			worker: new PiWorker("repair-worker-1", () => ({
				status: "success",
				summary: "misleading green explanation",
				evidence: ["worker_result"],
				changed_files: ["tmp/repair-loop.txt"],
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: () => ({
				command: "deterministic-check",
				exit_code: 1,
				stdout: "",
				stderr: "deterministic assertion failed",
			}),
			snapshot: { commit_hash: "repair-1", diff_digest: "d1", artifact_digest: "a1" },
		});
		expect(first.task.state).toBe("FAILED");
		expect(store.getLoopUsage(task.id)).toMatchObject({ attempts: 1, model_calls: 1, tool_calls: 1 });

		const leases = new LeaseManager(store);
		const recovery = new RecoveryManager(store, leases).recover({
			task_id: task.id,
			run_id: first.run.id,
			fault: "wrong_result",
			reason: "Verifier rejected the first Worker result",
		});
		expect(recovery.action).toBe("RETRY");
		const retry = new RecoveryManager(store, leases).startRetry(task.id, "repair-worker-2", {
			worker_status: AVAILABLE_WORKER_STATUS,
		});
		new LoopBudgetController(store).beforeModelCall(task);
		new LoopBudgetController(store).beforeToolCall(task);
		store.saveResult({
			task_id: task.id,
			run_id: retry.run.id,
			worker_id: retry.lease.worker_id,
			lease_epoch: retry.lease.lease_epoch,
			status: "failure",
			summary: "repair attempt failed",
			changed_files: [],
			artifacts: [],
			evidence: [],
			errors: ["injected repair failure"],
			model_identity: UNKNOWN_MODEL_IDENTITY,
		});
		const blocked = new RecoveryManager(store, leases).recover({
			task_id: task.id,
			run_id: retry.run.id,
			fault: "crash",
			reason: "repair Worker crashed",
		});

		expect(blocked.action).toBe("BLOCK");
		expect(blocked.task.state).toBe("BLOCKED");
		expect(store.getLoopUsage(task.id).attempts).toBe(2);
		expect(store.getTask(task.id)?.audit_log.at(-1)?.reason).toContain("repair Worker crashed");
		expect(new LeaseManager(store).currentLease(task.id)).toBeUndefined();
		expect(() => new LoopBudgetController(store).beforeRun(task)).toThrow(LoopBudgetExhaustedError);
	});

	test("rejects model, tool, and handoff calls at their actual admission boundary", () => {
		const store = new PersistentStateStore();
		const task = makeV3Task("call-limits", {
			loop_budget: boundedLoopBudget({ max_model_calls: 1, max_tool_calls: 1, max_handoffs: 0 }),
		});
		store.createTask(task);
		const controller = new LoopBudgetController(store);
		controller.beforeModelCall(task);
		controller.beforeToolCall(task);
		expect(() => controller.beforeModelCall(task)).toThrow(LoopBudgetExhaustedError);
		expect(() => controller.beforeToolCall(task)).toThrow(LoopBudgetExhaustedError);
		expect(() => controller.beforeHandoff(task)).toThrow(LoopBudgetExhaustedError);
		expect(store.getLoopUsage(task.id)).toMatchObject({ model_calls: 1, tool_calls: 1, handoffs: 0 });
	});

	test("enforces and persists a reassign handoff bound through RecoveryManager", () => {
		const store = new PersistentStateStore();
		const task = makeV3Task("handoff-reassign", {
			loop_budget: boundedLoopBudget({ max_handoffs: 0 }),
		});
		let record = store.createTask(task);
		const machine = new TaskStateMachine();
		record = store.updateTask(machine.transition(record, "READY", "ready"));
		record = store.updateTask(machine.transition(record, "RUNNING", "running"));
		const leases = new LeaseManager(store);
		const firstLease = leases.acquire(task.id, "worker-a");
		const firstRun = store.createRun(task.id, firstLease.worker_id, firstLease.lease_epoch, {
			worker_status: AVAILABLE_WORKER_STATUS,
			model_identity: UNKNOWN_MODEL_IDENTITY,
		});
		new LoopBudgetController(store).beforeRun(task);
		const manager = new RecoveryManager(store, leases);

		const blocked = manager.recover({
			task_id: task.id,
			run_id: firstRun.id,
			fault: "crash",
			candidate_worker_id: "worker-b",
		});
		expect(blocked.action).toBe("BLOCK");
		expect(blocked.decision.reason).toContain("max_handoffs");
		expect(blocked.task.state).toBe("BLOCKED");
		expect(store.getLoopUsage(task.id).handoffs).toBe(0);
		expect(new LeaseManager(store).currentLease(task.id)).toBeUndefined();
	});

	test("does not allow an executable task to silently become unbounded", () => {
		const store = new PersistentStateStore();
		const task = makeV3Task("missing-budget", { loop_budget: undefined });
		store.createTask(task);
		expect(() => new LoopBudgetController(store).beforeRun(task)).toThrow(LoopBudgetMissingError);
	});

	test("persists decomposition replan usage across controller instances", () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-replan-budget-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "state.json");
		const store = new PersistentStateStore(path);
		const parent = makeV3Task("replan-parent");
		const childOne = makeV3Task("replan-child-one");
		const childTwo = makeV3Task("replan-child-two");
		const childThree = makeV3Task("replan-child-three");
		const limits = { max_depth: 3, max_children_per_task: 2, max_total_open_tasks: 5, max_replan_count: 1 };
		const graph = new TaskGraphStore({ revision: 0, nodes: [graphNodeForTask(parent.id)], edges: [] });
		const firstBudget = new BudgetController(limits, undefined, {}, { store, scope: "replan-graph" });
		const firstDecomposer = new DynamicDecomposer(graph, firstBudget, [parent]);
		firstDecomposer.decompose(parent, [childOne]);
		firstDecomposer.replan(parent, [childTwo]);
		expect(store.read().budget_usage["replan-graph"]?.replan_count).toBe(1);

		const restarted = new PersistentStateStore(path);
		const restartedBudget = new BudgetController(
			limits,
			undefined,
			{},
			{
				store: restarted,
				scope: "replan-graph",
			},
		);
		const restartedDecomposer = new DynamicDecomposer(graph, restartedBudget, [parent, childOne, childTwo]);
		expect(() => restartedDecomposer.replan(parent, [childThree])).toThrow(BudgetExceededError);
		expect(restartedBudget.read().usage.replan_count).toBe(1);
		expect(restarted.read().budget_decisions["replan-graph"]?.some((decision) => decision.action === "DENY")).toBe(
			true,
		);
	});

	test("runs the machine-readable T1.6 bound coverage audit", () => {
		const audit = auditBoundCoverage(V3_FEEDBACK_PATHS);
		expect(audit.passed).toBe(true);
		expect(audit.uncovered_paths).toEqual([]);
	});

	test("preserves independent leases when managers share one persistent store", () => {
		const store = new PersistentStateStore();
		const firstManager = new LeaseManager(store);
		const secondManager = new LeaseManager(store);
		const firstLease = firstManager.acquire("lease-task-a", "worker-a");
		const secondLease = secondManager.acquire("lease-task-b", "worker-b");

		expect(new LeaseManager(store).currentLease("lease-task-a")).toEqual(firstLease);
		expect(new LeaseManager(store).currentLease("lease-task-b")).toEqual(secondLease);

		const replacement = secondManager.acquire("lease-task-a", "worker-c");
		expect(firstManager.acceptResult(firstLease)).toEqual({ accepted: false, reason: "stale_result" });
		expect(firstManager.release(firstLease)).toBe(false);
		expect(secondManager.currentLease("lease-task-a")).toEqual(replacement);
		expect(store.read().lease_epochs["lease-task-a"]).toBe(2);
	});
});
