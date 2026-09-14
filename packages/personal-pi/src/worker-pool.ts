import { LeaseManager } from "./lease.ts";
import type { Lease } from "./types.ts";
import type { WorkerAdapter } from "./worker.ts";

export type WorkerRuntimeKind = "local_process_worker" | "cli_ephemeral_worker" | "remote_agent_worker";
export type WorkerPoolState = "COLD" | "WARMING" | "IDLE" | "LEASED" | "BUSY" | "DEAD";

export interface WorkerPoolRegistration {
	worker_id: string;
	kind: WorkerRuntimeKind;
	adapter: WorkerAdapter;
	idle_timeout_ms?: number;
}

export interface WorkerPoolHooks {
	start?: (workerId: string) => void;
	stop?: (workerId: string) => void;
	clear_context?: (workerId: string) => void;
}

export interface WorkerPoolSnapshot {
	worker_id: string;
	kind: WorkerRuntimeKind;
	state: WorkerPoolState;
	last_activity_at: number;
	session_context: Record<string, string>;
}

export interface WorkerPoolLease {
	task_id: string;
	worker_id: string;
	lease: Lease;
	adapter: WorkerAdapter;
}

export class WorkerPoolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerPoolError";
	}
}

export class WorkerPoolLeaseConflictError extends WorkerPoolError {
	constructor(message: string) {
		super(message);
		this.name = "WorkerPoolLeaseConflictError";
	}
}

interface WorkerPoolEntry extends WorkerPoolRegistration {
	idle_timeout_ms: number;
	state: WorkerPoolState;
	last_activity_at: number;
	session_context: Record<string, string>;
}

const TRANSITIONS: Record<WorkerPoolState, readonly WorkerPoolState[]> = {
	COLD: ["WARMING"],
	WARMING: ["IDLE", "DEAD"],
	IDLE: ["LEASED", "COLD", "DEAD"],
	LEASED: ["BUSY", "IDLE"],
	BUSY: ["IDLE"],
	DEAD: ["WARMING"],
};

function cloneSnapshot(entry: WorkerPoolEntry): WorkerPoolSnapshot {
	return {
		worker_id: entry.worker_id,
		kind: entry.kind,
		state: entry.state,
		last_activity_at: entry.last_activity_at,
		session_context: { ...entry.session_context },
	};
}

export class WorkerPool {
	private readonly workers = new Map<string, WorkerPoolEntry>();
	private readonly taskLeases = new Map<string, WorkerPoolLease>();
	private readonly workerLeases = new Map<string, WorkerPoolLease>();
	private readonly leaseManager: LeaseManager;
	private readonly hooks: WorkerPoolHooks;
	private readonly now: () => number;

	constructor(options: { lease_manager?: LeaseManager; hooks?: WorkerPoolHooks; now?: () => number } = {}) {
		this.leaseManager = options.lease_manager ?? new LeaseManager();
		this.hooks = options.hooks ?? {};
		this.now = options.now ?? (() => Date.now());
	}

	register(input: WorkerPoolRegistration): WorkerPoolSnapshot {
		if (input.worker_id.length === 0) throw new WorkerPoolError("worker_id must not be empty");
		if (input.adapter.worker_id !== input.worker_id)
			throw new WorkerPoolError("adapter worker_id must match worker_id");
		if (this.workers.has(input.worker_id)) throw new WorkerPoolError(`worker already registered: ${input.worker_id}`);
		if (input.idle_timeout_ms !== undefined && input.idle_timeout_ms < 0)
			throw new WorkerPoolError("idle_timeout_ms must be non-negative");
		const entry: WorkerPoolEntry = {
			...input,
			idle_timeout_ms: input.idle_timeout_ms ?? 300_000,
			state: "COLD",
			last_activity_at: this.now(),
			session_context: {},
		};
		this.workers.set(input.worker_id, entry);
		return cloneSnapshot(entry);
	}

	get(workerId: string): WorkerPoolSnapshot | undefined {
		const entry = this.workers.get(workerId);
		return entry ? cloneSnapshot(entry) : undefined;
	}

	list(): WorkerPoolSnapshot[] {
		return [...this.workers.values()].map(cloneSnapshot);
	}

	warm(workerId: string): WorkerPoolSnapshot {
		const entry = this.requireWorker(workerId);
		if (entry.state === "IDLE") return cloneSnapshot(entry);
		if (entry.state !== "COLD" && entry.state !== "DEAD")
			throw new WorkerPoolError(`worker ${workerId} cannot warm from ${entry.state}`);
		this.transition(entry, "WARMING");
		this.hooks.start?.(workerId);
		this.transition(entry, "IDLE");
		entry.last_activity_at = this.now();
		return cloneSnapshot(entry);
	}

	warmAll(): WorkerPoolSnapshot[] {
		for (const worker of this.workers.values()) {
			if (worker.state === "COLD" || worker.state === "DEAD") this.warm(worker.worker_id);
		}
		return this.list();
	}

	setSessionContext(workerId: string, context: Record<string, string>): WorkerPoolSnapshot {
		const entry = this.requireWorker(workerId);
		if (entry.state === "COLD" || entry.state === "DEAD" || entry.state === "WARMING")
			throw new WorkerPoolError(`worker ${workerId} is not active`);
		entry.session_context = { ...context };
		return cloneSnapshot(entry);
	}

	acquire(taskId: string, preferredWorkerIds: readonly string[] = []): WorkerPoolLease {
		if (this.taskLeases.has(taskId))
			throw new WorkerPoolLeaseConflictError(`task already has an active lease: ${taskId}`);
		const preferred = new Set(preferredWorkerIds);
		const candidates = [...this.workers.values()].filter(
			(worker) => preferred.size === 0 || preferred.has(worker.worker_id),
		);
		for (const entry of candidates) {
			if (entry.state === "COLD" || entry.state === "DEAD") this.warm(entry.worker_id);
			if (entry.state !== "IDLE" || this.workerLeases.has(entry.worker_id)) continue;
			const lease = this.leaseManager.acquire(taskId, entry.worker_id, new Date(this.now()).toISOString());
			const poolLease: WorkerPoolLease = {
				task_id: taskId,
				worker_id: entry.worker_id,
				lease,
				adapter: entry.adapter,
			};
			this.transition(entry, "LEASED");
			entry.last_activity_at = this.now();
			this.taskLeases.set(taskId, poolLease);
			this.workerLeases.set(entry.worker_id, poolLease);
			return { ...poolLease, lease: { ...poolLease.lease } };
		}
		throw new WorkerPoolLeaseConflictError(`no idle Worker available for task: ${taskId}`);
	}

	markBusy(poolLease: WorkerPoolLease): WorkerPoolSnapshot {
		const entry = this.requireWorker(poolLease.worker_id);
		if (!this.isCurrentLease(poolLease) || entry.state !== "LEASED")
			throw new WorkerPoolLeaseConflictError(`lease is not current for worker: ${poolLease.worker_id}`);
		this.transition(entry, "BUSY");
		entry.last_activity_at = this.now();
		return cloneSnapshot(entry);
	}

	release(poolLease: WorkerPoolLease): boolean {
		const entry = this.workers.get(poolLease.worker_id);
		if (!entry || !this.isCurrentLease(poolLease)) return false;
		if (!this.leaseManager.release(poolLease.lease)) return false;
		this.taskLeases.delete(poolLease.task_id);
		this.workerLeases.delete(poolLease.worker_id);
		if (entry.state !== "LEASED" && entry.state !== "BUSY")
			throw new WorkerPoolError(`worker ${entry.worker_id} cannot release from ${entry.state}`);
		this.transition(entry, "IDLE");
		entry.session_context = {};
		this.hooks.clear_context?.(entry.worker_id);
		entry.last_activity_at = this.now();
		if (entry.kind === "cli_ephemeral_worker") {
			this.destroy(entry);
		} else if (entry.kind === "remote_agent_worker") {
			this.transition(entry, "COLD");
			this.hooks.stop?.(entry.worker_id);
		}
		return true;
	}

	reapIdle(queueDepth: number, at = this.now()): string[] {
		if (queueDepth > 0) return [];
		const destroyed: string[] = [];
		for (const entry of this.workers.values()) {
			if (
				entry.kind === "local_process_worker" &&
				entry.state === "IDLE" &&
				at - entry.last_activity_at >= entry.idle_timeout_ms
			) {
				this.destroy(entry);
				destroyed.push(entry.worker_id);
			}
		}
		return destroyed;
	}

	private destroy(entry: WorkerPoolEntry): void {
		if (entry.state !== "IDLE" && entry.state !== "WARMING")
			throw new WorkerPoolError(`worker ${entry.worker_id} cannot be destroyed from ${entry.state}`);
		this.transition(entry, "DEAD");
		entry.session_context = {};
		this.hooks.stop?.(entry.worker_id);
	}

	private isCurrentLease(poolLease: WorkerPoolLease): boolean {
		const taskLease = this.taskLeases.get(poolLease.task_id);
		const workerLease = this.workerLeases.get(poolLease.worker_id);
		return (
			taskLease?.worker_id === poolLease.worker_id &&
			workerLease?.task_id === poolLease.task_id &&
			taskLease.lease.lease_epoch === poolLease.lease.lease_epoch &&
			this.leaseManager.acceptResult(poolLease.lease).accepted
		);
	}

	private requireWorker(workerId: string): WorkerPoolEntry {
		const entry = this.workers.get(workerId);
		if (!entry) throw new WorkerPoolError(`unknown worker: ${workerId}`);
		return entry;
	}

	private transition(entry: WorkerPoolEntry, next: WorkerPoolState): void {
		if (!TRANSITIONS[entry.state].includes(next))
			throw new WorkerPoolError(`invalid Worker Pool transition ${entry.state} -> ${next}`);
		entry.state = next;
	}
}
