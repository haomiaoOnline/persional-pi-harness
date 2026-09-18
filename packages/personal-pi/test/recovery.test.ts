import { describe, expect, test } from "vitest";
import {
	LeaseManager,
	LoopBudgetController,
	PersistentStateStore,
	RecoveryManager,
	type TaskContract,
	TaskStateMachine,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, UNAVAILABLE_WORKER_STATUS, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

function makeTask(id: string): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Recoverable task",
		objective: "Complete work after an injected fault",
		requirements: ["preserve valid progress"],
		constraints: [],
		scope: { files: ["src/recoverable.ts"] },
		inputs: {},
		data_sources: ["repository"],
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
		expected_outputs: ["verified result"],
		acceptance_criteria: ["verification passes"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P1",
		timeout: 10,
		retry_policy: { max_attempts: 3, backoff: 0 },
		loop_budget: {
			max_attempts: 2,
			max_model_calls: 2,
			max_tool_calls: 2,
			max_handoffs: 1,
			max_elapsed_ms: 60000,
			max_input_tokens: 2000,
			max_output_tokens: 2000,
			max_cost_usd: 1,
			max_state_growth_bytes: 10000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

function startRunning(
	store: PersistentStateStore,
	leases: LeaseManager,
	task: TaskContract,
	workerId: string,
	at: string,
) {
	let record = store.createTask(task);
	const machine = new TaskStateMachine();
	record = machine.transition(record, "READY", "test ready", at);
	record = machine.transition(record, "RUNNING", "test running", at);
	store.updateTask(record);
	new LoopBudgetController(store).beforeRun(task);
	const lease = leases.acquire(task.id, workerId, at);
	const run = store.createRun(task.id, workerId, lease.lease_epoch, {
		worker_status: AVAILABLE_WORKER_STATUS,
		model_identity: UNKNOWN_MODEL_IDENTITY,
		started_at: at,
	});
	return { lease, run };
}

function validResult(taskId: string, runId: string, workerId: string, epoch: number) {
	return {
		task_id: taskId,
		run_id: runId,
		worker_id: workerId,
		lease_epoch: epoch,
		status: "success" as const,
		summary: "valid result",
		changed_files: [],
		artifacts: [],
		evidence: ["worker_result"],
		errors: [],
		model_identity: UNKNOWN_MODEL_IDENTITY,
	};
}

describe("T9.1 timeout and retry", () => {
	test("marks an expired RUNNING Run TIMEOUT and returns it to READY for retry", () => {
		const store = new PersistentStateStore();
		const leases = new LeaseManager();
		const started = startRunning(store, leases, makeTask("timeout"), "worker-a", "2026-09-13T00:00:00.000Z");
		const plan = new RecoveryManager(store, leases).findTimedOut(new Date("2026-09-13T00:00:01.000Z"))[0];

		expect(plan?.action).toBe("RETRY");
		expect(store.getRuns("timeout")[0].status).toBe("TIMEOUT");
		expect(store.getTask("timeout")?.state).toBe("READY");
		expect(plan?.decision.decision_type).toBe("recovery");
		expect(started.run.id).toBe(plan?.previous_run_id);
	});
});

describe("T9.2 resume and reassign", () => {
	test("chooses RESUME for safe partial progress and REASSIGN for a crashed worker", () => {
		const store = new PersistentStateStore();
		const leases = new LeaseManager();
		const manager = new RecoveryManager(store, leases);
		const task = makeTask("resume");
		const started = startRunning(store, leases, task, "worker-a", "2026-09-13T00:00:00.000Z");
		const resume = manager.recover({
			task_id: task.id,
			run_id: started.run.id,
			fault: "timeout",
			worker_id: "worker-a",
			changed_files: ["src/recoverable.ts"],
			resume_safe: true,
			at: "2026-09-13T00:00:01.000Z",
		});
		expect(resume.action).toBe("RESUME");

		const reassignTask = makeTask("reassign");
		const reassignRun = startRunning(store, leases, reassignTask, "worker-a", "2026-09-13T00:00:02.000Z");
		const reassign = manager.recover({
			task_id: reassignTask.id,
			run_id: reassignRun.run.id,
			fault: "crash",
			worker_id: "worker-a",
			candidate_worker_id: "worker-b",
			at: "2026-09-13T00:00:03.000Z",
		});

		expect(reassign.action).toBe("REASSIGN");
		expect(reassign.next_worker_id).toBe("worker-b");
		expect(leases.acceptResult(reassignRun.lease)).toEqual({ accepted: false, reason: "unknown_lease" });
	});
});

describe("T9.3 malformed and wrong Result recovery", () => {
	test("recovers malformed output and rejects a validly shaped result for the wrong task", () => {
		const malformedStore = new PersistentStateStore();
		const malformedLeases = new LeaseManager();
		const malformedManager = new RecoveryManager(malformedStore, malformedLeases);
		const malformedTask = makeTask("malformed");
		const malformedRun = startRunning(
			malformedStore,
			malformedLeases,
			malformedTask,
			"worker-a",
			"2026-09-13T00:00:00.000Z",
		);
		const malformed = malformedManager.admitResult(
			malformedRun.lease,
			{ status: "success" },
			"2026-09-13T00:00:01.000Z",
		);
		expect(malformed.accepted).toBe(false);
		expect(malformed.reason).toBe("malformed_result");
		expect(malformed.recovery?.action).toBe("RETRY");

		const wrongStore = new PersistentStateStore();
		const wrongLeases = new LeaseManager();
		const wrongManager = new RecoveryManager(wrongStore, wrongLeases);
		const wrongTask = makeTask("wrong");
		const wrongRun = startRunning(wrongStore, wrongLeases, wrongTask, "worker-a", "2026-09-13T00:00:00.000Z");
		const wrong = validResult("other-task", wrongRun.run.id, "worker-a", wrongRun.lease.lease_epoch);
		const admission = wrongManager.admitResult(wrongRun.lease, wrong, "2026-09-13T00:00:01.000Z");

		expect(admission.accepted).toBe(false);
		expect(admission.reason).toBe("wrong_result");
		expect(admission.recovery?.decision.reason).toContain("fault injected: wrong_result");
	});
});

describe("T9.4 bounded automatic recovery", () => {
	test("blocks after two recovered failures and does not start a third retry", () => {
		const store = new PersistentStateStore();
		const leases = new LeaseManager();
		const manager = new RecoveryManager(store, leases);
		const task = makeTask("blocked-after-two");
		const first = startRunning(store, leases, task, "worker-a", "2026-09-13T00:00:00.000Z");
		const firstPlan = manager.recover({
			task_id: task.id,
			run_id: first.run.id,
			fault: "timeout",
			at: "2026-09-13T00:00:01.000Z",
		});
		const second = manager.startRetry(task.id, firstPlan.next_worker_id ?? "worker-a", {
			worker_status: AVAILABLE_WORKER_STATUS,
			at: "2026-09-13T00:00:02.000Z",
		});
		const secondPlan = manager.recover({
			task_id: task.id,
			run_id: second.run.id,
			fault: "crash",
			at: "2026-09-13T00:00:03.000Z",
		});

		expect(secondPlan.action).toBe("BLOCK");
		expect(store.getTask(task.id)?.state).toBe("BLOCKED");
		expect(() =>
			manager.startRetry(task.id, "worker-c", {
				worker_status: AVAILABLE_WORKER_STATUS,
				at: "2026-09-13T00:00:04.000Z",
			}),
		).toThrow("not READY");
		expect(store.read().decisions.filter((decision) => decision.decision_type === "recovery")).toHaveLength(2);
	});

	test("honors a contract retry_policy with max_attempts=1", () => {
		const store = new PersistentStateStore();
		const leases = new LeaseManager();
		const manager = new RecoveryManager(store, leases);
		const task = makeTask("single-attempt");
		task.retry_policy = { max_attempts: 1, backoff: 0 };
		const run = startRunning(store, leases, task, "worker-a", "2026-09-13T00:00:00.000Z");

		const plan = manager.recover({ task_id: task.id, run_id: run.run.id, fault: "timeout" });

		expect(plan.action).toBe("BLOCK");
		expect(store.getTask(task.id)?.state).toBe("BLOCKED");
	});

	test("rejects a stale result before it can be interpreted as current work", () => {
		const store = new PersistentStateStore();
		const leases = new LeaseManager();
		const manager = new RecoveryManager(store, leases);
		const task = makeTask("stale");
		const first = startRunning(store, leases, task, "worker-a", "2026-09-13T00:00:00.000Z");
		manager.recover({ task_id: task.id, run_id: first.run.id, fault: "crash", candidate_worker_id: "worker-b" });
		const second = manager.startRetry(task.id, "worker-b", {
			worker_status: AVAILABLE_WORKER_STATUS,
			at: "2026-09-13T00:00:01.000Z",
		});
		const admission = manager.admitResult(
			first.lease,
			validResult(task.id, first.run.id, "worker-a", first.lease.lease_epoch),
		);

		expect(admission).toMatchObject({ accepted: false, reason: "stale_result" });
		expect(leases.acceptResult(second.lease).accepted).toBe(true);
	});

	test("does not create a recovery Lease or Run when the replacement Worker is unavailable", () => {
		const store = new PersistentStateStore();
		const leases = new LeaseManager(store);
		const manager = new RecoveryManager(store, leases);
		const task = makeTask("unavailable-retry");
		const first = startRunning(store, leases, task, "worker-a", "2026-09-13T00:00:00.000Z");
		manager.recover({ task_id: task.id, run_id: first.run.id, fault: "timeout" });
		const runsBefore = store.getRuns(task.id).length;

		expect(() =>
			manager.startRetry(task.id, "worker-b", {
				worker_status: UNAVAILABLE_WORKER_STATUS,
				at: "2026-09-13T00:00:01.000Z",
			}),
		).toThrow("recovery Worker is unavailable");
		expect(store.getRuns(task.id)).toHaveLength(runsBefore);
		expect(leases.currentLease(task.id)).toBeUndefined();
	});
});
