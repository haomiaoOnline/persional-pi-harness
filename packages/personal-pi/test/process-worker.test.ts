import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	BudgetController,
	createProtocolEnvelope,
	LeaseManager,
	PersistentStateStore,
	ProcessWorkerAdapter,
	ProviderResilienceController,
	ProviderResilientWorkerAdapter,
	WorkerPool,
	WorkerPoolLeaseConflictError,
	WorkerPoolStaleResultError,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(taskId: string, epoch: number, action: Record<string, string | number>): WorkerProtocolRequest {
	const task = makeV3Task(taskId, {
		inputs: { level_b_action: action },
	});
	return {
		task,
		protocol: createProtocolEnvelope(task, epoch),
		run_id: `run-${taskId}-${epoch}`,
	};
}

function budget(store: PersistentStateStore): BudgetController {
	return new BudgetController(
		{ max_depth: 5, max_children_per_task: 8, max_total_open_tasks: 32, max_replan_count: 8 },
		{ max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
		{},
		{ store, scope: "level-b-process-test" },
	);
}

function processWorker(root: string, workerId: string): ProcessWorkerAdapter {
	return new ProcessWorkerAdapter({
		worker_id: workerId,
		worker_instance_id: `pi-instance-${workerId}`,
		adapter_id: "pi-same-adapter",
		workspace_path: join(root, workerId),
		timeout_ms: 2_000,
	});
}

describe("Level B process-backed Worker Instances", () => {
	test("runs two same-adapter processes with independent identity, workspace, context and budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-level-b-"));
		roots.push(root);
		const workspaceA = join(root, "instance-a");
		const workspaceB = join(root, "instance-b");
		const adapterA = processWorker(root, "instance-a");
		const adapterB = processWorker(root, "instance-b");
		const state = new PersistentStateStore(join(root, "state.json"));
		const leaseManager = new LeaseManager(state);
		const coordination = budget(state);
		const pool = new WorkerPool({
			lease_manager: leaseManager,
			instance_store: state,
			coordination_budget: { max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
			budget_controller: coordination,
		});
		pool.register({ worker_id: "instance-a", kind: "local_process_worker", adapter: adapterA, idle_timeout_ms: 1 });
		pool.register({ worker_id: "instance-b", kind: "local_process_worker", adapter: adapterB, idle_timeout_ms: 1 });

		const warmed = await pool.warmAllAsync();
		expect(warmed[0]?.pid).toBeGreaterThan(0);
		expect(warmed[1]?.pid).toBeGreaterThan(0);
		expect(warmed[0]?.pid).not.toBe(warmed[1]?.pid);
		expect(warmed[0]?.adapter_id).toBe("pi-same-adapter");
		expect(warmed[1]?.adapter_id).toBe("pi-same-adapter");
		expect(warmed[0]?.worker_instance_id).not.toBe(warmed[1]?.worker_instance_id);
		expect(warmed[0]?.session_id).not.toBe(warmed[1]?.session_id);
		expect(warmed[0]?.workspace_path).toBe(workspaceA);
		expect(warmed[1]?.workspace_path).toBe(workspaceB);

		const [leaseA, leaseB] = await Promise.all([
			pool.acquireAsync("task-a", ["instance-a"]),
			pool.acquireAsync("task-b", ["instance-b"]),
		]);
		pool.setSessionContext("instance-a", { private_marker: "must-clear" });
		const taskA = request("task-a", leaseA.lease.lease_epoch, {
			kind: "write",
			target: "tmp/a.txt",
			content: "worker-a",
			delay_ms: 150,
		});
		const taskB = request("task-b", leaseB.lease.lease_epoch, {
			kind: "write",
			target: "tmp/b.txt",
			content: "worker-b",
			delay_ms: 150,
		});
		const [resultA, resultB] = await Promise.all([pool.execute(leaseA, taskA), pool.execute(leaseB, taskB)]);

		expect(resultA.status).toBe("success");
		expect(resultB.status).toBe("success");
		expect(readFileSync(join(workspaceA, "tmp/a.txt"), "utf8")).toBe("worker-a");
		expect(readFileSync(join(workspaceB, "tmp/b.txt"), "utf8")).toBe("worker-b");
		expect(resultA.evidence.some((entry) => entry.includes("process_pid="))).toBe(true);
		expect(resultB.evidence.some((entry) => entry.includes("process_pid="))).toBe(true);

		const finishedA = pool.get("instance-a");
		const finishedB = pool.get("instance-b");
		expect(finishedA?.execution_started_at).toBeDefined();
		expect(finishedA?.execution_ended_at).toBeDefined();
		expect(finishedB?.execution_started_at).toBeDefined();
		expect(finishedB?.execution_ended_at).toBeDefined();
		expect(finishedA?.loop_usage.elapsed_ms).toBeGreaterThan(0);
		expect(finishedB?.loop_usage.elapsed_ms).toBeGreaterThan(0);
		expect(new Date(finishedA!.execution_started_at!).getTime()).toBeLessThan(
			new Date(finishedB!.execution_ended_at!).getTime(),
		);
		expect(new Date(finishedB!.execution_started_at!).getTime()).toBeLessThan(
			new Date(finishedA!.execution_ended_at!).getTime(),
		);
		expect(finishedA?.context_projection_digest).not.toBe(finishedB?.context_projection_digest);

		expect(pool.release(leaseA)).toBe(true);
		expect(pool.release(leaseB)).toBe(true);
		expect(pool.get("instance-a")?.session_context).toEqual({});
		expect(coordination.read().usage.active_workers).toBe(0);
		expect(coordination.read().usage.concurrent_roles).toBe(0);
		expect(state.listWorkerInstances()).toHaveLength(2);
		expect(state.getWorkerInstance("pi-instance-instance-a")?.state).toBe("IDLE");
		expect(state.getWorkerInstance("pi-instance-instance-a")?.lease_epoch).toBe(1);
		await pool.reapIdleAsync(0, Date.now() + 10);
		await adapterA.stop();
		await adapterB.stop();
	});

	test("rejects double dispatch for one task even when two real instances are idle", async () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-level-b-duplicate-"));
		roots.push(root);
		const adapterA = processWorker(root, "instance-a");
		const adapterB = processWorker(root, "instance-b");
		const state = new PersistentStateStore(join(root, "state.json"));
		const pool = new WorkerPool({
			lease_manager: new LeaseManager(state),
			instance_store: state,
			coordination_budget: { max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
		});
		pool.register({ worker_id: "instance-a", kind: "local_process_worker", adapter: adapterA });
		pool.register({ worker_id: "instance-b", kind: "local_process_worker", adapter: adapterB });
		await pool.warmAllAsync();

		const claims = await Promise.allSettled([pool.acquireAsync("same-task"), pool.acquireAsync("same-task")]);
		expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
		const rejected = claims.find((claim) => claim.status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(WorkerPoolLeaseConflictError);
		const lease = claims.find((claim) => claim.status === "fulfilled")?.value;
		if (lease) expect(pool.release(lease)).toBe(true);
		await adapterA.stop();
		await adapterB.stop();
	});

	test("reclaims a crashed process, increments epoch on reassignment, and fences the late result", async () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-level-b-recovery-"));
		roots.push(root);
		const adapterA = processWorker(root, "instance-a");
		const adapterB = processWorker(root, "instance-b");
		const state = new PersistentStateStore(join(root, "state.json"));
		const persistentLeaseManager = new LeaseManager(state);
		const pool = new WorkerPool({
			lease_manager: persistentLeaseManager,
			instance_store: state,
			coordination_budget: { max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
		});
		pool.register({ worker_id: "instance-a", kind: "local_process_worker", adapter: adapterA });
		pool.register({ worker_id: "instance-b", kind: "local_process_worker", adapter: adapterB });
		await pool.warmAllAsync();

		const oldLease = await pool.acquireAsync("recovery-task", ["instance-b"]);
		const oldResultPromise = pool.execute(
			oldLease,
			request("recovery-task", oldLease.lease.lease_epoch, { kind: "sleep", delay_ms: 1_000 }),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const crashPromise = adapterB.crash();
		expect(await pool.reclaim(oldLease, "intentional conformance crash")).toBe(true);
		await crashPromise;

		const newLease = await pool.acquireAsync("recovery-task", ["instance-a"]);
		expect(newLease.worker_instance_id).toBe("pi-instance-instance-a");
		expect(newLease.lease.lease_epoch).toBe(oldLease.lease.lease_epoch + 1);
		expect(persistentLeaseManager.acceptResult(oldLease.lease)).toMatchObject({
			accepted: false,
			reason: "stale_result",
		});
		await expect(oldResultPromise).rejects.toBeInstanceOf(WorkerPoolStaleResultError);
		expect(pool.get("instance-b")?.state).toBe("DEAD");
		expect(pool.release(newLease)).toBe(true);
		await adapterA.stop();
		await adapterB.stop();
	});

	test("routes same-provider instance traffic through one quota controller", async () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-level-b-provider-"));
		roots.push(root);
		const adapterA = processWorker(root, "instance-a");
		const adapterB = processWorker(root, "instance-b");
		const provider = new ProviderResilienceController();
		provider.register({
			provider_id: "pi-provider",
			rate_limit: { max_requests: 2, interval_ms: 1_000 },
			quota_limit: 2,
			failure_threshold: 2,
			cooldown_ms: 100,
		});
		const resilientA = new ProviderResilientWorkerAdapter({
			adapter: adapterA,
			provider_id: "pi-provider",
			controller: provider,
		});
		const resilientB = new ProviderResilientWorkerAdapter({
			adapter: adapterB,
			provider_id: "pi-provider",
			controller: provider,
		});
		const state = new PersistentStateStore(join(root, "state.json"));
		const pool = new WorkerPool({
			lease_manager: new LeaseManager(state),
			instance_store: state,
			coordination_budget: { max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
		});
		pool.register({
			worker_id: "instance-a",
			kind: "local_process_worker",
			adapter: resilientA,
			lifecycle: adapterA,
		});
		pool.register({
			worker_id: "instance-b",
			kind: "local_process_worker",
			adapter: resilientB,
			lifecycle: adapterB,
		});
		await pool.warmAllAsync();
		const [leaseA, leaseB] = await Promise.all([pool.acquireAsync("provider-a"), pool.acquireAsync("provider-b")]);
		const [resultA, resultB] = await Promise.all([
			pool.execute(leaseA, request("provider-a", leaseA.lease.lease_epoch, { kind: "sleep", delay_ms: 100 })),
			pool.execute(leaseB, request("provider-b", leaseB.lease.lease_epoch, { kind: "sleep", delay_ms: 100 })),
		]);
		expect(resultA.status).toBe("success");
		expect(resultB.status).toBe("success");
		expect(resultA.model_identity).toEqual({
			requested_model: "unknown",
			platform_accepted_model: "unknown",
			observed_runtime_model: "unknown",
		});
		expect(resilientA.getModelIdentity()).toEqual(resultA.model_identity);
		expect(provider.status("pi-provider")).toMatchObject({ requests_used: 2, quota_remaining: 0, state: "CLOSED" });
		expect(resultA.evidence).toContain("pi-provider:admission=ALLOW");
		expect(resultB.evidence).toContain("pi-provider:admission=ALLOW");
		pool.release(leaseA);
		pool.release(leaseB);
		await adapterA.stop();
		await adapterB.stop();
	});
});
