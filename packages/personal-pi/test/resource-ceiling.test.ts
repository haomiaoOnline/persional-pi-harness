import { describe, expect, test } from "vitest";
import {
	createProtocolEnvelope,
	PiWorker,
	validateResourceCeiling,
	WorkerPool,
	WorkerPoolLeaseConflictError,
	WorkerPoolMemoryLimitError,
	type WorkerProcessLifecycle,
	type WorkerProcessSnapshot,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

class FakeLifecycle implements WorkerProcessLifecycle {
	readonly pid: number;
	readonly worker_instance_id: string;
	readonly adapter_id = "fake-process";
	readonly workspace_path: string;
	readonly session_id: string;
	private alive = false;
	crashes = 0;

	constructor(pid: number, workerId: string) {
		this.pid = pid;
		this.worker_instance_id = `instance-${workerId}`;
		this.workspace_path = `/tmp/${workerId}`;
		this.session_id = `session-${workerId}`;
	}

	async start(): Promise<WorkerProcessSnapshot> {
		this.alive = true;
		return this.snapshot();
	}

	async stop(): Promise<void> {
		this.alive = false;
	}

	async crash(): Promise<void> {
		this.crashes += 1;
		this.alive = false;
	}

	isAlive(): boolean {
		return this.alive;
	}

	snapshot(): WorkerProcessSnapshot {
		return {
			adapter_id: this.adapter_id,
			pid: this.alive ? this.pid : null,
			session_id: this.session_id,
			session_id_sha256: `sha-${this.pid}`,
			workspace_path: this.workspace_path,
			alive: this.alive,
		};
	}
}

function request(taskId: string, epoch: number): WorkerProtocolRequest {
	const task = makeV3Task(taskId);
	return {
		task,
		protocol: createProtocolEnvelope(task, epoch),
		run_id: `run-${taskId}-${epoch}`,
	};
}

function successAdapter(workerId: string, delayMs = 0) {
	return new PiWorker(workerId, async () => {
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		return { status: "success", summary: `${workerId} completed` };
	});
}

describe("T8.4-A resource ceiling", () => {
	test("resource_ceiling has exactly the four checklist fields", () => {
		const valid = {
			max_parallel_workers: 4,
			max_memory_mb_per_worker: 256,
			max_total_memory_mb: 768,
			on_pressure: "degrade_to_serial",
		} as const;
		expect(validateResourceCeiling(valid).valid).toBe(true);
		expect(validateResourceCeiling({ ...valid, max_cpu: 4 }).valid).toBe(false);
	});

	test("monitoring unavailable conservatively degrades parallel work to serial", async () => {
		const pool = new WorkerPool({
			resource_ceiling: {
				max_parallel_workers: 4,
				max_memory_mb_per_worker: 256,
				max_total_memory_mb: 768,
				on_pressure: "degrade_to_serial",
			},
			memory_monitor: { workerMemoryMb: () => undefined },
		});
		for (let index = 0; index < 3; index += 1) {
			const workerId = `serial-${index}`;
			const lifecycle = new FakeLifecycle(10_000 + index, workerId);
			pool.register({
				worker_id: workerId,
				kind: "local_process_worker",
				adapter: successAdapter(workerId),
				lifecycle,
			});
		}
		await pool.warmAllAsync();
		expect(pool.planParallelism(3)).toMatchObject({
			mode: "serial",
			reason: expect.stringContaining("monitoring unavailable"),
		});

		const jobs = Array.from({ length: 8 }, (_, index) => {
			const taskId = `serial-task-${index}`;
			return {
				task_id: taskId,
				preferred_worker_ids: ["serial-0"] as const,
				request: request(taskId, index + 1),
			};
		});
		const batch = await pool.executeResourceAwareBatch(jobs);
		expect(batch.mode).toBe("serial");
		expect(batch.results).toHaveLength(8);
		expect(batch.results.every((result) => result.status === "success")).toBe(true);
		expect(batch.results.flatMap((result) => result.errors).join(" ")).not.toContain("137");
	});

	test("total memory pressure prevents a second concurrent lease and allows serial continuation", async () => {
		const memory = new Map([
			[20_001, 70],
			[20_002, 70],
		]);
		const pool = new WorkerPool({
			resource_ceiling: {
				max_parallel_workers: 2,
				max_memory_mb_per_worker: 90,
				max_total_memory_mb: 100,
				on_pressure: "degrade_to_serial",
			},
			memory_monitor: { workerMemoryMb: (pid) => memory.get(pid) },
		});
		for (let index = 0; index < 2; index += 1) {
			const workerId = `pressure-${index}`;
			const lifecycle = new FakeLifecycle(20_001 + index, workerId);
			pool.register({
				worker_id: workerId,
				kind: "local_process_worker",
				adapter: successAdapter(workerId),
				lifecycle,
			});
		}
		await pool.warmAllAsync();
		expect(pool.planParallelism(2).mode).toBe("serial");
		const first = await pool.acquireAsync("pressure-task-a", ["pressure-0"]);
		await expect(pool.acquireAsync("pressure-task-b", ["pressure-1"])).rejects.toThrow(WorkerPoolLeaseConflictError);
		expect(pool.release(first)).toBe(true);
		const second = await pool.acquireAsync("pressure-task-b", ["pressure-1"]);
		expect(pool.release(second)).toBe(true);
	});

	test("healthy resources run in bounded parallel chunks capped by max_parallel_workers", async () => {
		const memory = new Map<number, number>();
		const pool = new WorkerPool({
			resource_ceiling: {
				max_parallel_workers: 2,
				max_memory_mb_per_worker: 100,
				max_total_memory_mb: 300,
				on_pressure: "degrade_to_serial",
			},
			memory_monitor: { workerMemoryMb: (pid) => memory.get(pid) },
		});
		for (let index = 0; index < 3; index += 1) {
			const workerId = `healthy-${index}`;
			const pid = 50_001 + index;
			memory.set(pid, 30);
			const lifecycle = new FakeLifecycle(pid, workerId);
			pool.register({
				worker_id: workerId,
				kind: "local_process_worker",
				adapter: successAdapter(workerId, 5),
				lifecycle,
			});
		}
		await pool.warmAllAsync();
		const jobs = Array.from({ length: 5 }, (_, index) => {
			const taskId = `healthy-task-${index}`;
			return { task_id: taskId, request: request(taskId, index + 1) };
		});
		const batch = await pool.executeResourceAwareBatch(jobs);
		expect(batch.mode).toBe("parallel");
		expect(batch.results).toHaveLength(5);
		expect(batch.results.every((result) => result.status === "success")).toBe(true);
	});

	test("many pressure-heavy tasks complete through automatic serial degradation without exit 137 or OOM", async () => {
		const memory = new Map<number, number>();
		const pool = new WorkerPool({
			resource_ceiling: {
				max_parallel_workers: 4,
				max_memory_mb_per_worker: 90,
				max_total_memory_mb: 150,
				on_pressure: "degrade_to_serial",
			},
			memory_monitor: { workerMemoryMb: (pid) => memory.get(pid) },
		});
		for (let index = 0; index < 4; index += 1) {
			const workerId = `stress-${index}`;
			const pid = 40_001 + index;
			memory.set(pid, 50);
			const lifecycle = new FakeLifecycle(pid, workerId);
			pool.register({
				worker_id: workerId,
				kind: "local_process_worker",
				adapter: successAdapter(workerId, 5),
				lifecycle,
			});
		}
		await pool.warmAllAsync();
		const jobs = Array.from({ length: 12 }, (_, index) => {
			const taskId = `stress-task-${index}`;
			return {
				task_id: taskId,
				request: request(taskId, index + 1),
			};
		});
		const batch = await pool.executeResourceAwareBatch(jobs);
		expect(batch.mode).toBe("serial");
		expect(batch.reason).toContain("total memory pressure");
		expect(batch.results).toHaveLength(12);
		expect(batch.results.every((result) => result.status === "success")).toBe(true);
		const diagnostics = batch.results.flatMap((result) => [result.summary, ...result.errors]).join(" ");
		expect(diagnostics).not.toMatch(/exit\s*137|code=137|OOM/i);
	});

	test("per-worker memory excess proactively crashes, reclaims, fences, and enters crash recovery", async () => {
		const lifecycle = new FakeLifecycle(30_001, "memory-worker");
		const recoveries: Array<{ task_id: string; fault: string; reason?: string }> = [];
		const pool = new WorkerPool({
			resource_ceiling: {
				max_parallel_workers: 2,
				max_memory_mb_per_worker: 100,
				max_total_memory_mb: 200,
				on_pressure: "degrade_to_serial",
			},
			memory_monitor: { workerMemoryMb: () => 150 },
			recovery_manager: {
				recover: (input) => {
					recoveries.push({ task_id: input.task_id, fault: input.fault, reason: input.reason });
					return {} as never;
				},
			},
		});
		pool.register({
			worker_id: "memory-worker",
			kind: "local_process_worker",
			adapter: successAdapter("memory-worker", 100),
			lifecycle,
		});
		await pool.warmAllAsync();
		const lease = await pool.acquireAsync("memory-task");
		await expect(pool.execute(lease, request("memory-task", lease.lease.lease_epoch))).rejects.toBeInstanceOf(
			WorkerPoolMemoryLimitError,
		);
		expect(lifecycle.crashes).toBe(1);
		expect(pool.get("memory-worker")?.state).toBe("DEAD");
		expect(pool.release(lease)).toBe(false);
		expect(recoveries).toHaveLength(1);
		expect(recoveries[0]).toMatchObject({ task_id: "memory-task", fault: "crash" });
		expect(recoveries[0]?.reason).not.toContain("137");
	});
});
