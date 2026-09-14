import { describe, expect, test } from "vitest";
import { PiWorker, WorkerPool, WorkerPoolLeaseConflictError } from "../src/index.ts";

function adapter(workerId: string) {
	return new PiWorker(workerId, () => ({ status: "success", summary: `${workerId} completed` }));
}

describe("T12.4 Worker Pool Lifecycle Manager", () => {
	test("atomically leases two ready tasks to different local Workers and clears context", () => {
		const pool = new WorkerPool({ now: () => 1_000 });
		pool.register({ worker_id: "local-a", kind: "local_process_worker", adapter: adapter("local-a") });
		pool.register({ worker_id: "local-b", kind: "local_process_worker", adapter: adapter("local-b") });
		pool.warmAll();

		const first = pool.acquire("task-a");
		pool.markBusy(first);
		pool.setSessionContext(first.worker_id, { browser: "signed-in" });
		const second = pool.acquire("task-b");
		expect(second.worker_id).not.toBe(first.worker_id);
		pool.markBusy(second);
		pool.release(first);

		expect(pool.get(first.worker_id)?.state).toBe("IDLE");
		expect(pool.get(first.worker_id)?.session_context).toEqual({});
		pool.release(second);
	});

	test("does not destroy idle Workers while work is queued, then honors idle_timeout", () => {
		let clock = 1_000;
		const stopped: string[] = [];
		const pool = new WorkerPool({ now: () => clock, hooks: { stop: (workerId) => stopped.push(workerId) } });
		pool.register({
			worker_id: "local-timeout",
			kind: "local_process_worker",
			adapter: adapter("local-timeout"),
			idle_timeout_ms: 100,
		});
		pool.warm("local-timeout");
		const lease = pool.acquire("task-timeout");
		pool.markBusy(lease);
		pool.release(lease);

		clock = 1_200;
		expect(pool.reapIdle(1)).toEqual([]);
		expect(pool.get("local-timeout")?.state).toBe("IDLE");
		expect(pool.reapIdle(0)).toEqual(["local-timeout"]);
		expect(pool.get("local-timeout")?.state).toBe("DEAD");
		expect(stopped).toEqual(["local-timeout"]);
	});

	test("starts ephemeral and remote Workers on demand and releases them safely", () => {
		const pool = new WorkerPool();
		pool.register({ worker_id: "cli", kind: "cli_ephemeral_worker", adapter: adapter("cli") });
		pool.register({ worker_id: "remote", kind: "remote_agent_worker", adapter: adapter("remote") });

		const cliLease = pool.acquire("cli-task", ["cli"]);
		pool.markBusy(cliLease);
		pool.release(cliLease);
		expect(pool.get("cli")?.state).toBe("DEAD");

		const remoteLease = pool.acquire("remote-task", ["remote"]);
		pool.markBusy(remoteLease);
		pool.release(remoteLease);
		expect(pool.get("remote")?.state).toBe("COLD");
	});

	test("rejects stale or duplicate leases instead of dispatching twice", () => {
		const pool = new WorkerPool();
		pool.register({ worker_id: "single", kind: "local_process_worker", adapter: adapter("single") });
		const lease = pool.acquire("same-task");
		expect(() => pool.acquire("same-task")).toThrow(WorkerPoolLeaseConflictError);
		expect(pool.release({ ...lease, lease: { ...lease.lease, lease_epoch: lease.lease.lease_epoch + 1 } })).toBe(
			false,
		);
		expect(pool.release(lease)).toBe(true);
	});
});
