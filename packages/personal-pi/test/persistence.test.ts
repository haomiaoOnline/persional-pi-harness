import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PersistentStateStore, type TaskContract, type TaskRecord, TaskStateMachine } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function makeTask(id = "persistent-task"): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Persistent task",
		objective: "Survive a controller restart",
		requirements: ["Preserve task identity"],
		constraints: [],
		scope: { files: ["src/index.ts"] },
		inputs: {},
		data_sources: [],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "medium",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["state"],
		acceptance_criteria: ["state can be reloaded"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["state"],
			evidence_required: ["stdout"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P0",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
	};
}

function temporaryStatePath(): string {
	const root = mkdtempSync(join(tmpdir(), "personal-pi-state-"));
	temporaryDirectories.push(root);
	return join(root, "state.json");
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T5.1 persistent task store", () => {
	test("reloads the core object graph from an atomic JSON state file", () => {
		const path = temporaryStatePath();
		const first = new PersistentStateStore(path);
		first.createTask(makeTask());
		first.addDecision({
			id: "decision-1",
			decision_type: "test",
			decision: "keep",
			reason: "test",
			inputs: [],
			at: "2026-09-13T00:00:00.000Z",
		});
		const second = new PersistentStateStore(path);
		expect(second.getTask("persistent-task")?.title).toBe("Persistent task");
		expect(second.read().decisions).toHaveLength(1);
	});
});

describe("T5.2 Run/Attempt persistence", () => {
	test("creates a new Run for retry without changing Task ID", () => {
		const store = new PersistentStateStore();
		const task = store.createTask(makeTask());
		const run1 = store.createRun(task.id, "worker-1", 1);
		store.saveResult({
			task_id: task.id,
			run_id: run1.id,
			worker_id: "worker-1",
			lease_epoch: 1,
			status: "failure",
			summary: "failed",
			changed_files: [],
			artifacts: [],
			evidence: [],
			errors: ["test"],
		});
		const run2 = store.createRun(task.id, "worker-1", 2);
		expect(run2.attempt).toBe(2);
		expect(run2.id).not.toBe(run1.id);
		expect(store.getRuns(task.id).map((run) => run.attempt)).toEqual([1, 2]);
		expect(store.getTask(task.id)?.id).toBe(task.id);
	});
});

describe("T5.3 crash recovery", () => {
	test("blocks a task whose RUNNING Worker disappeared after restart", () => {
		const path = temporaryStatePath();
		const store = new PersistentStateStore(path);
		let task = store.createTask(makeTask());
		const machine = new TaskStateMachine();
		task = store.updateTask(machine.transition(task, "READY"));
		task = store.updateTask(machine.transition(task, "RUNNING"));
		const run = store.createRun(task.id, "worker-gone", 1);
		const restarted = new PersistentStateStore(path);
		const decisions = restarted.recoverUnclosedRuns(() => false, "2026-09-13T01:00:00.000Z");
		expect(decisions).toEqual([
			{ run_id: run.id, task_id: task.id, action: "BLOCK", reason: "worker missing after controller restart" },
		]);
		expect(restarted.getTask(task.id)?.state).toBe("BLOCKED");
		expect(restarted.getRuns(task.id)[0].status).toBe("CRASHED");
	});
});

describe("T5.4 snapshot and restore drill", () => {
	test("restores the pre-change state and verifies that the snapshot can be read", () => {
		const store = new PersistentStateStore();
		store.createTask(makeTask());
		const drill = store.restoreDrill((state) => {
			state.tasks[0].title = "corrupted during drill";
			state.decisions.push({
				id: "temporary",
				decision_type: "drill",
				decision: "mutate",
				reason: "test",
				inputs: [],
				at: "2026-09-13T00:00:00.000Z",
			});
		});
		expect(drill.restored).toBe(true);
		expect(store.getTask("persistent-task")?.title).toBe("Persistent task");
		expect(store.read().decisions).toHaveLength(0);
	});

	test("rejects a tampered snapshot digest", () => {
		const store = new PersistentStateStore();
		store.createTask(makeTask());
		const snapshot = store.createSnapshot();
		expect(() => store.restoreSnapshot({ ...snapshot, digest: "tampered" })).toThrow("digest mismatch");
	});
});

describe("T5.5 control-plane reconstruction", () => {
	test("rebuilds ready, running, blocked, and decision indexes in a new store instance", () => {
		const path = temporaryStatePath();
		const store = new PersistentStateStore(path);
		let ready = store.createTask(makeTask("ready"));
		ready = store.updateTask(new TaskStateMachine().transition(ready, "READY"));
		const running = store.createTask(makeTask("running"));
		const machine = new TaskStateMachine();
		let runningRecord: TaskRecord = machine.transition(running, "READY");
		runningRecord = machine.transition(runningRecord, "RUNNING");
		store.updateTask(runningRecord);
		store.createRun("running", "worker-1", 1);
		const blocked = store.createTask(makeTask("blocked"));
		store.updateTask(machine.transition(blocked, "BLOCKED", "dependency missing"));
		store.addDecision({
			id: "decision-1",
			decision_type: "recovery",
			decision: "block",
			reason: "missing",
			inputs: ["running"],
			at: "2026-09-13T00:00:00.000Z",
		});
		const reconstructed = new PersistentStateStore(path).reconstructControlPlane();
		expect(reconstructed.next_ready_task_ids).toEqual(["ready"]);
		expect(reconstructed.running_run_ids).toHaveLength(1);
		expect(reconstructed.blocked_task_ids).toEqual(["blocked"]);
		expect(reconstructed.decision_ids).toEqual(["decision-1"]);
	});
});
