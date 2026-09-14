import { writeFileSync } from "node:fs";
import {
	EffectJournal,
	LeaseManager,
	LoopBudgetController,
	PersistentStateStore,
	TaskStateMachine,
} from "../src/index.ts";

const [mode, statePath, markerPath] = process.argv.slice(2);
const taskId = "controller-restart-task";

function taskContract() {
	return {
		id: taskId,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Controller restart drill",
		objective: "Persist control state across a process restart",
		requirements: ["preserve state"],
		constraints: ["local only"],
		scope: { files: ["tmp/controller-restart.txt"] },
		inputs: {},
		data_sources: ["local drill"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: ["tmp"] },
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
			idempotency_key: "controller-restart-effect",
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["persisted control state"],
		acceptance_criteria: ["state survives process death"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["state"],
			evidence_required: [],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 1000 } },
		risk: "low",
		priority: "P0",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: {
			max_attempts: 2,
			max_model_calls: 2,
			max_tool_calls: 1,
			max_handoffs: 1,
			max_elapsed_ms: 60000,
			max_input_tokens: 1000,
			max_output_tokens: 1000,
			max_cost_usd: 1,
			max_state_growth_bytes: 10000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

function transitionToRunning(store, task) {
	const machine = new TaskStateMachine();
	let next = task;
	if (next.state === "DRAFT") next = machine.transition(next, "READY", "restart drill ready");
	if (next.state === "READY") next = machine.transition(next, "RUNNING", "restart drill running");
	return store.updateTask(next);
}

if (mode === "start") {
	const store = new PersistentStateStore(statePath);
	const task = store.getTask(taskId) ?? store.createTask(taskContract());
	const runningTask = transitionToRunning(store, task);
	const budget = new LoopBudgetController(store);
	budget.beforeRun(runningTask);
	const leases = new LeaseManager(store);
	const lease = leases.acquire(taskId, "controller-worker");
	const run = store.createRun(taskId, lease.worker_id, lease.lease_epoch);
	const effects = new EffectJournal(store);
	const effect = await effects.run(
		"controller-restart-effect",
		"local-file",
		() => undefined,
		{ action_digest: "controller-restart-action" },
	);
	const snapshot = store.createSnapshot();
	writeFileSync(
		markerPath,
		JSON.stringify({ pid: process.pid, task_id: taskId, run_id: run.id, lease, effect, snapshot_id: snapshot.id }),
	);
	setInterval(() => undefined, 1000);
} else if (mode === "inspect") {
	const store = new PersistentStateStore(statePath);
	const before = store.read();
	const oldLease = new LeaseManager(store).currentLease(taskId);
	const effect = new EffectJournal(store).get("controller-restart-effect");
	const snapshotId = before.snapshots[0]?.id;
	const snapshot = snapshotId ? store.getSnapshot(snapshotId) : undefined;
	const restored = snapshotId ? store.restoreSnapshotFromStore(snapshotId) : undefined;
	const staleBefore = oldLease ? new LeaseManager(store).acceptResult(oldLease) : undefined;
	const decisions = store.recoverUnclosedRuns(() => false, new Date().toISOString());
	const after = store.read();
	const staleAfter = oldLease ? new LeaseManager(store).acceptResult(oldLease) : undefined;
	const reconstruction = new PersistentStateStore(statePath).reconstructControlPlane();
	writeFileSync(
		markerPath,
		JSON.stringify({
			before,
			after,
			oldLease,
			staleBefore,
			staleAfter,
			effect,
			snapshot: snapshot ? { id: snapshot.id, digest: snapshot.digest } : undefined,
			restored_task_state: restored?.tasks.find((task) => task.id === taskId)?.state,
			decisions,
			reconstruction,
		}),
	);
} else {
	console.error(`unknown controller mode: ${mode}`);
	process.exit(2);
}
