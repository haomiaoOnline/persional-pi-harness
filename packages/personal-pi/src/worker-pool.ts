import { createHash, randomUUID } from "node:crypto";
import type { BudgetController, CoordinationBudget } from "./graph-intelligence.ts";
import { LeaseManager } from "./lease.ts";
import type { PersistentStateStore } from "./persistence.ts";
import type { WorkerProcessLifecycle, WorkerProcessSnapshot } from "./process-worker.ts";
import type { RecoveryManager } from "./recovery.ts";
import {
	evaluateResourceParallelism,
	PsWorkerMemoryMonitor,
	type ResourceCeiling,
	type ResourceParallelismDecision,
	validateResourceCeiling,
	type WorkerMemoryMonitor,
} from "./resource-ceiling.ts";
import { validateResultContract } from "./result.ts";
import type {
	Lease,
	LoopUsage,
	ResultContract,
	WorkerExecutionControls,
	WorkerInstanceRecord,
	WorkerProtocolRequest,
} from "./types.ts";
import type { WorkerAdapter } from "./worker.ts";

export type WorkerRuntimeKind = "local_process_worker" | "cli_ephemeral_worker" | "remote_agent_worker";
export type WorkerPoolState = "COLD" | "WARMING" | "IDLE" | "LEASED" | "BUSY" | "DEAD";

export interface WorkerPoolRegistration {
	worker_id: string;
	kind: WorkerRuntimeKind;
	adapter: WorkerAdapter;
	idle_timeout_ms?: number;
	worker_instance_id?: string;
	adapter_id?: string;
	workspace_path?: string;
	session_id?: string;
	lifecycle?: WorkerProcessLifecycle;
}

export interface WorkerPoolHooks {
	start?: (workerId: string) => void;
	stop?: (workerId: string) => void;
	clear_context?: (workerId: string) => void;
}

export interface WorkerPoolSnapshot {
	worker_id: string;
	worker_instance_id: string;
	adapter_id: string;
	kind: WorkerRuntimeKind;
	state: WorkerPoolState;
	pid: number | null;
	session_id: string;
	session_id_sha256: string;
	lease_epoch: number;
	workspace_path: string;
	context_projection_digest: string;
	loop_usage: LoopUsage;
	execution_started_at?: string;
	execution_ended_at?: string;
	last_activity_at: number;
	session_context: Record<string, string>;
}

export interface WorkerPoolLease {
	task_id: string;
	worker_id: string;
	worker_instance_id: string;
	lease: Lease;
	adapter: WorkerAdapter;
}

export interface WorkerPoolBatchJob {
	task_id: string;
	request: WorkerProtocolRequest;
	preferred_worker_ids?: readonly string[];
	controls?: WorkerExecutionControls;
}

export interface WorkerPoolBatchResult {
	mode: "parallel" | "serial";
	reason: string;
	results: ResultContract[];
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

export class WorkerPoolStaleResultError extends WorkerPoolLeaseConflictError {
	constructor(message = "REJECTED_STALE_EPOCH") {
		super(message);
		this.name = "WorkerPoolStaleResultError";
	}
}

export class WorkerPoolMemoryLimitError extends WorkerPoolError {
	readonly worker_id: string;
	readonly observed_memory_mb: number;

	constructor(workerId: string, observedMemoryMb: number, limitMb: number) {
		super(`worker ${workerId} memory ${observedMemoryMb.toFixed(1)}MB exceeded ${limitMb}MB`);
		this.name = "WorkerPoolMemoryLimitError";
		this.worker_id = workerId;
		this.observed_memory_mb = observedMemoryMb;
	}
}

interface WorkerPoolEntry extends WorkerPoolRegistration {
	idle_timeout_ms: number;
	state: WorkerPoolState;
	worker_instance_id: string;
	adapter_id: string;
	workspace_path: string;
	session_id: string;
	session_id_sha256: string;
	lease_epoch: number;
	context_projection_digest: string;
	loop_usage: LoopUsage;
	execution_started_at?: string;
	execution_ended_at?: string;
	last_activity_at: number;
	session_context: Record<string, string>;
	lifecycle?: WorkerProcessLifecycle;
}

const TRANSITIONS: Record<WorkerPoolState, readonly WorkerPoolState[]> = {
	COLD: ["WARMING"],
	WARMING: ["IDLE", "DEAD"],
	IDLE: ["LEASED", "COLD", "DEAD"],
	LEASED: ["BUSY", "IDLE", "DEAD"],
	BUSY: ["IDLE", "DEAD"],
	DEAD: ["WARMING"],
};

function emptyLoopUsage(): LoopUsage {
	return {
		attempts: 0,
		model_calls: 0,
		tool_calls: 0,
		handoffs: 0,
		elapsed_ms: 0,
		input_tokens: 0,
		output_tokens: 0,
		cost_usd: 0,
		state_growth_bytes: 0,
	};
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isLifecycle(value: unknown): value is WorkerProcessLifecycle {
	return Boolean(
		value &&
			typeof value === "object" &&
			"start" in value &&
			"stop" in value &&
			"crash" in value &&
			"isAlive" in value &&
			"snapshot" in value,
	);
}

function lifecycleSnapshot(entry: WorkerPoolEntry): WorkerProcessSnapshot | undefined {
	return entry.lifecycle?.snapshot();
}

function cloneSnapshot(entry: WorkerPoolEntry): WorkerPoolSnapshot {
	const processSnapshot = lifecycleSnapshot(entry);
	return {
		worker_id: entry.worker_id,
		worker_instance_id: entry.worker_instance_id,
		adapter_id: entry.adapter_id,
		kind: entry.kind,
		state: entry.state,
		pid: processSnapshot?.pid ?? null,
		session_id: processSnapshot?.session_id ?? entry.session_id,
		session_id_sha256: processSnapshot?.session_id_sha256 ?? entry.session_id_sha256,
		lease_epoch: entry.lease_epoch,
		workspace_path: processSnapshot?.workspace_path ?? entry.workspace_path,
		context_projection_digest: entry.context_projection_digest,
		loop_usage: structuredClone(entry.loop_usage),
		execution_started_at: entry.execution_started_at,
		execution_ended_at: entry.execution_ended_at,
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
	private readonly coordinationBudget?: CoordinationBudget;
	private readonly budgetController?: Pick<BudgetController, "reserveDispatch" | "releaseDispatch">;
	private readonly instanceStore?: PersistentStateStore;
	private readonly resourceCeiling?: ResourceCeiling;
	private readonly memoryMonitor?: WorkerMemoryMonitor;
	private readonly recoveryManager?: Pick<RecoveryManager, "recover">;

	constructor(
		options: {
			lease_manager?: LeaseManager;
			hooks?: WorkerPoolHooks;
			now?: () => number;
			coordination_budget?: CoordinationBudget;
			budget_controller?: Pick<BudgetController, "reserveDispatch" | "releaseDispatch">;
			instance_store?: PersistentStateStore;
			resource_ceiling?: ResourceCeiling;
			memory_monitor?: WorkerMemoryMonitor;
			recovery_manager?: Pick<RecoveryManager, "recover">;
		} = {},
	) {
		this.leaseManager = options.lease_manager ?? new LeaseManager();
		this.hooks = options.hooks ?? {};
		this.now = options.now ?? (() => Date.now());
		this.coordinationBudget = options.coordination_budget;
		this.budgetController = options.budget_controller;
		this.instanceStore = options.instance_store;
		if (options.resource_ceiling) {
			const validation = validateResourceCeiling(options.resource_ceiling);
			if (!validation.valid) throw new WorkerPoolError(`invalid resource_ceiling: ${validation.errors.join("; ")}`);
			this.resourceCeiling = structuredClone(options.resource_ceiling);
			this.memoryMonitor = options.memory_monitor ?? new PsWorkerMemoryMonitor();
		}
		this.recoveryManager = options.recovery_manager;
	}

	register(input: WorkerPoolRegistration): WorkerPoolSnapshot {
		if (input.worker_id.length === 0) throw new WorkerPoolError("worker_id must not be empty");
		if (input.adapter.worker_id !== input.worker_id)
			throw new WorkerPoolError("adapter worker_id must match worker_id");
		if (this.workers.has(input.worker_id)) throw new WorkerPoolError(`worker already registered: ${input.worker_id}`);
		if (input.idle_timeout_ms !== undefined && input.idle_timeout_ms < 0)
			throw new WorkerPoolError("idle_timeout_ms must be non-negative");
		const lifecycle = input.lifecycle ?? (isLifecycle(input.adapter) ? input.adapter : undefined);
		if (lifecycle && lifecycle.adapter_id.length === 0) throw new WorkerPoolError("adapter_id must not be empty");
		if (lifecycle && lifecycle.workspace_path.length === 0)
			throw new WorkerPoolError("workspace_path must not be empty for a process Worker");
		const workerInstanceId = input.worker_instance_id ?? lifecycle?.worker_instance_id ?? input.worker_id;
		if (workerInstanceId.length === 0) throw new WorkerPoolError("worker_instance_id must not be empty");
		if ([...this.workers.values()].some((worker) => worker.worker_instance_id === workerInstanceId))
			throw new WorkerPoolError(`worker instance already registered: ${workerInstanceId}`);
		const adapterId = input.adapter_id ?? lifecycle?.adapter_id ?? input.adapter.worker_id;
		const workspacePath = input.workspace_path ?? lifecycle?.workspace_path ?? process.cwd();
		const sessionId = input.session_id ?? lifecycle?.session_id ?? `local-session:${randomUUID()}`;
		const entry: WorkerPoolEntry = {
			...input,
			worker_instance_id: workerInstanceId,
			adapter_id: adapterId,
			workspace_path: workspacePath,
			session_id: sessionId,
			session_id_sha256: digest(sessionId).slice(0, 16),
			lease_epoch: 0,
			context_projection_digest: digest({ worker_instance_id: workerInstanceId, context: [] }),
			loop_usage: emptyLoopUsage(),
			lifecycle,
			idle_timeout_ms: input.idle_timeout_ms ?? 300_000,
			state: "COLD",
			last_activity_at: this.now(),
			session_context: {},
		};
		this.workers.set(input.worker_id, entry);
		this.persistEntry(entry);
		return cloneSnapshot(entry);
	}

	get(workerId: string): WorkerPoolSnapshot | undefined {
		const entry = this.workers.get(workerId);
		return entry ? cloneSnapshot(entry) : undefined;
	}

	list(): WorkerPoolSnapshot[] {
		return [...this.workers.values()].map(cloneSnapshot);
	}

	planParallelism(requestedWorkers: number, preferredWorkerIds: readonly string[] = []): ResourceParallelismDecision {
		if (!this.resourceCeiling)
			return {
				mode: requestedWorkers > 1 ? "parallel" : "serial",
				reason: "resource ceiling is not configured",
			};
		const candidates = this.candidates(preferredWorkerIds).slice(0, Math.max(0, requestedWorkers));
		const memory = candidates.map((entry) => {
			const pid = lifecycleSnapshot(entry)?.pid;
			return pid && this.memoryMonitor ? this.memoryMonitor.workerMemoryMb(pid) : undefined;
		});
		return evaluateResourceParallelism({
			ceiling: this.resourceCeiling,
			requested_workers: requestedWorkers,
			worker_memory_mb: memory,
		});
	}

	async executeResourceAwareBatch(jobs: readonly WorkerPoolBatchJob[]): Promise<WorkerPoolBatchResult> {
		if (jobs.length === 0) return { mode: "serial", reason: "no jobs", results: [] };
		const requestedWorkers = Math.min(
			jobs.length,
			this.workers.size,
			this.resourceCeiling?.max_parallel_workers ?? Number.POSITIVE_INFINITY,
		);
		const decision = this.resourceCeiling
			? this.planParallelism(requestedWorkers)
			: {
					mode: requestedWorkers > 1 ? ("parallel" as const) : ("serial" as const),
					reason: "resource ceiling is not configured",
				};
		if (decision.mode === "serial") {
			const results: ResultContract[] = [];
			for (const job of jobs) {
				const lease = await this.acquireAsync(job.task_id, job.preferred_worker_ids ?? []);
				try {
					results.push(await this.execute(lease, this.bindRequestToLease(job.request, lease), job.controls));
				} finally {
					this.release(lease);
				}
			}
			return { mode: "serial", reason: decision.reason, results };
		}
		const results: ResultContract[] = [];
		for (let start = 0; start < jobs.length; start += requestedWorkers) {
			const chunk = jobs.slice(start, start + requestedWorkers);
			const leases: WorkerPoolLease[] = [];
			try {
				for (const job of chunk) leases.push(await this.acquireAsync(job.task_id, job.preferred_worker_ids ?? []));
				const chunkResults = await Promise.all(
					chunk.map((job, index) => {
						const lease = leases[index] as WorkerPoolLease;
						return this.execute(lease, this.bindRequestToLease(job.request, lease), job.controls);
					}),
				);
				results.push(...chunkResults);
			} finally {
				for (const lease of leases) this.release(lease);
			}
		}
		return { mode: "parallel", reason: decision.reason, results };
	}

	private bindRequestToLease(request: WorkerProtocolRequest, lease: WorkerPoolLease): WorkerProtocolRequest {
		if (request.task.id !== lease.task_id)
			throw new WorkerPoolError(`batch request task mismatch: ${request.task.id} != ${lease.task_id}`);
		return {
			...request,
			protocol: {
				...request.protocol,
				task_id: lease.task_id,
				lease_epoch: lease.lease.lease_epoch,
			},
		};
	}

	warm(workerId: string): WorkerPoolSnapshot {
		const entry = this.requireWorker(workerId);
		if (entry.lifecycle) throw new WorkerPoolError(`worker ${workerId} requires warmAsync for process startup`);
		if (entry.state === "IDLE") return cloneSnapshot(entry);
		if (entry.state !== "COLD" && entry.state !== "DEAD")
			throw new WorkerPoolError(`worker ${workerId} cannot warm from ${entry.state}`);
		this.transition(entry, "WARMING");
		this.hooks.start?.(workerId);
		this.transition(entry, "IDLE");
		entry.last_activity_at = this.now();
		this.persistEntry(entry);
		return cloneSnapshot(entry);
	}

	async warmAsync(workerId: string): Promise<WorkerPoolSnapshot> {
		const entry = this.requireWorker(workerId);
		if (entry.state === "IDLE") return cloneSnapshot(entry);
		if (entry.state !== "COLD" && entry.state !== "DEAD")
			throw new WorkerPoolError(`worker ${workerId} cannot warm from ${entry.state}`);
		this.transition(entry, "WARMING");
		try {
			const processSnapshot = await entry.lifecycle?.start();
			if (processSnapshot) this.applyProcessSnapshot(entry, processSnapshot);
			this.hooks.start?.(workerId);
			this.transition(entry, "IDLE");
			entry.last_activity_at = this.now();
			this.persistEntry(entry);
			return cloneSnapshot(entry);
		} catch (error) {
			this.transition(entry, "DEAD");
			this.hooks.stop?.(workerId);
			throw new WorkerPoolError(
				`worker ${workerId} failed to warm: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	warmAll(): WorkerPoolSnapshot[] {
		for (const worker of this.workers.values()) {
			if (worker.state === "COLD" || worker.state === "DEAD") this.warm(worker.worker_id);
		}
		return this.list();
	}

	async warmAllAsync(): Promise<WorkerPoolSnapshot[]> {
		for (const worker of this.workers.values()) {
			if (worker.state === "COLD" || worker.state === "DEAD") await this.warmAsync(worker.worker_id);
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
		for (const entry of this.candidates(preferredWorkerIds)) {
			if (entry.state === "COLD" || entry.state === "DEAD") this.warm(entry.worker_id);
			if (entry.state !== "IDLE" || this.workerLeases.has(entry.worker_id)) continue;
			return this.claim(taskId, entry);
		}
		throw new WorkerPoolLeaseConflictError(`no idle Worker available for task: ${taskId}`);
	}

	async acquireAsync(taskId: string, preferredWorkerIds: readonly string[] = []): Promise<WorkerPoolLease> {
		if (this.taskLeases.has(taskId))
			throw new WorkerPoolLeaseConflictError(`task already has an active lease: ${taskId}`);
		for (const entry of this.candidates(preferredWorkerIds)) {
			if (entry.state === "COLD" || entry.state === "DEAD") await this.warmAsync(entry.worker_id);
			if (entry.state !== "IDLE" || this.workerLeases.has(entry.worker_id)) continue;
			return this.claim(taskId, entry);
		}
		throw new WorkerPoolLeaseConflictError(`no idle Worker available for task: ${taskId}`);
	}

	markBusy(poolLease: WorkerPoolLease): WorkerPoolSnapshot {
		const entry = this.requireWorker(poolLease.worker_id);
		if (!this.isCurrentLease(poolLease) || entry.state !== "LEASED")
			throw new WorkerPoolLeaseConflictError(`lease is not current for worker: ${poolLease.worker_id}`);
		this.transition(entry, "BUSY");
		entry.last_activity_at = this.now();
		this.persistEntry(entry);
		return cloneSnapshot(entry);
	}

	async execute(
		poolLease: WorkerPoolLease,
		request: WorkerProtocolRequest,
		controls?: WorkerExecutionControls,
	): Promise<ResultContract> {
		const entry = this.requireWorker(poolLease.worker_id);
		if (!this.isCurrentLease(poolLease))
			throw new WorkerPoolLeaseConflictError(`lease is not current for worker: ${poolLease.worker_id}`);
		if (entry.state === "LEASED") this.transition(entry, "BUSY");
		if (entry.state !== "BUSY") throw new WorkerPoolLeaseConflictError(`worker is not busy: ${poolLease.worker_id}`);
		if (entry.lifecycle && !entry.lifecycle.isAlive())
			throw new WorkerPoolError(`worker process is not alive: ${poolLease.worker_id}`);

		const startedAt = new Date(this.now()).toISOString();
		entry.execution_started_at = startedAt;
		entry.execution_ended_at = undefined;
		entry.context_projection_digest = digest({
			worker_instance_id: entry.worker_instance_id,
			manifest_digest: request.resolved_context?.manifest_digest ?? null,
			context_items: request.resolved_context?.items.map((item) => item.digest) ?? [],
		});
		entry.last_activity_at = this.now();
		this.persistEntry(entry);
		const scopedControls = controls
			? {
					beforeModelCall: () => {
						const usage = controls.beforeModelCall();
						entry.loop_usage = structuredClone(usage);
						return usage;
					},
					beforeToolCall: () => {
						const usage = controls.beforeToolCall();
						entry.loop_usage = structuredClone(usage);
						return usage;
					},
				}
			: undefined;
		try {
			const execution = poolLease.adapter.execute(request, scopedControls);
			const result = this.resourceCeiling
				? await this.executeWithMemoryGuard(entry, poolLease, execution)
				: await execution;
			const validation = validateResultContract(result);
			if (!validation.valid || !validation.value)
				throw new WorkerPoolError(`worker returned malformed Result: ${validation.errors.join("; ")}`);
			if (
				result.task_id !== request.task.id ||
				(request.run_id !== undefined && result.run_id !== request.run_id) ||
				result.worker_id !== poolLease.worker_id ||
				result.lease_epoch !== poolLease.lease.lease_epoch
			)
				throw new WorkerPoolError("worker Result identity mismatch");
			if (!this.isCurrentLease(poolLease)) throw new WorkerPoolStaleResultError();
			return result;
		} finally {
			const endedAt = this.now();
			entry.execution_ended_at = new Date(endedAt).toISOString();
			entry.loop_usage = {
				...entry.loop_usage,
				elapsed_ms: entry.loop_usage.elapsed_ms + Math.max(0, endedAt - Date.parse(startedAt)),
			};
			entry.last_activity_at = endedAt;
			this.persistEntry(entry);
		}
	}

	/** Reclaim a crashed or timed-out instance and remove its active lease. */
	async reclaim(poolLease: WorkerPoolLease, reason = "worker process reclaimed"): Promise<boolean> {
		const entry = this.workers.get(poolLease.worker_id);
		if (!entry || !this.isCurrentLease(poolLease)) return false;
		if (!this.leaseManager.release(poolLease.lease)) return false;
		this.taskLeases.delete(poolLease.task_id);
		this.workerLeases.delete(poolLease.worker_id);
		if (entry.state === "LEASED" || entry.state === "BUSY") this.transition(entry, "DEAD");
		entry.session_context = {};
		entry.execution_ended_at ??= new Date(this.now()).toISOString();
		entry.last_activity_at = this.now();
		this.hooks.clear_context?.(entry.worker_id);
		this.hooks.stop?.(entry.worker_id);
		this.releaseCoordination(entry, poolLease.task_id);
		if (entry.lifecycle) await entry.lifecycle.stop();
		this.persistEntry(entry);
		void reason;
		return true;
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
		this.releaseCoordination(entry, poolLease.task_id);
		if (entry.kind === "cli_ephemeral_worker" || (entry.lifecycle && !entry.lifecycle.isAlive())) {
			this.destroy(entry);
		} else if (entry.kind === "remote_agent_worker") {
			this.transition(entry, "COLD");
			this.hooks.stop?.(entry.worker_id);
		}
		this.persistEntry(entry);
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

	async reapIdleAsync(queueDepth: number, at = this.now()): Promise<string[]> {
		if (queueDepth > 0) return [];
		const destroyed: string[] = [];
		for (const entry of this.workers.values()) {
			if (
				entry.kind === "local_process_worker" &&
				entry.state === "IDLE" &&
				at - entry.last_activity_at >= entry.idle_timeout_ms
			) {
				this.transition(entry, "DEAD");
				entry.session_context = {};
				this.hooks.stop?.(entry.worker_id);
				if (entry.lifecycle) await entry.lifecycle.stop();
				this.persistEntry(entry);
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
		if (entry.lifecycle) void entry.lifecycle.stop();
		this.persistEntry(entry);
	}

	private persistEntry(entry: WorkerPoolEntry): void {
		if (!this.instanceStore) return;
		const snapshot = cloneSnapshot(entry);
		const record: WorkerInstanceRecord = {
			worker_instance_id: snapshot.worker_instance_id,
			adapter_id: snapshot.adapter_id,
			pid: snapshot.pid,
			session_id: snapshot.session_id,
			session_id_sha256: snapshot.session_id_sha256,
			lease_epoch: snapshot.lease_epoch,
			workspace_path: snapshot.workspace_path,
			context_projection_digest: snapshot.context_projection_digest,
			loop_usage: structuredClone(snapshot.loop_usage),
			state: snapshot.state,
			execution_started_at: snapshot.execution_started_at,
			execution_ended_at: snapshot.execution_ended_at,
			updated_at: new Date(this.now()).toISOString(),
		};
		this.instanceStore.upsertWorkerInstance(record);
	}

	private candidates(preferredWorkerIds: readonly string[]): WorkerPoolEntry[] {
		const preferred = new Set(preferredWorkerIds);
		return [...this.workers.values()].filter((worker) => preferred.size === 0 || preferred.has(worker.worker_id));
	}

	private claim(taskId: string, entry: WorkerPoolEntry): WorkerPoolLease {
		if (this.taskLeases.has(taskId))
			throw new WorkerPoolLeaseConflictError(`task already has an active lease: ${taskId}`);
		if (entry.state !== "IDLE" || this.workerLeases.has(entry.worker_id))
			throw new WorkerPoolLeaseConflictError(`worker is no longer idle: ${entry.worker_id}`);
		this.reserveCoordination(taskId);
		try {
			const lease = this.leaseManager.acquire(taskId, entry.worker_id, new Date(this.now()).toISOString());
			const poolLease: WorkerPoolLease = {
				task_id: taskId,
				worker_id: entry.worker_id,
				worker_instance_id: entry.worker_instance_id,
				lease,
				adapter: entry.adapter,
			};
			this.transition(entry, "LEASED");
			entry.lease_epoch = lease.lease_epoch;
			entry.last_activity_at = this.now();
			this.taskLeases.set(taskId, poolLease);
			this.workerLeases.set(entry.worker_id, poolLease);
			this.persistEntry(entry);
			return { ...poolLease, lease: { ...poolLease.lease } };
		} catch (error) {
			this.releaseCoordination(entry, taskId);
			throw error;
		}
	}

	private reserveCoordination(taskId: string): void {
		const activeWorkers = this.workerLeases.size + 1;
		if (this.resourceCeiling && activeWorkers > 1) {
			const resourceDecision = this.planParallelism(activeWorkers);
			if (resourceDecision.mode === "serial")
				throw new WorkerPoolLeaseConflictError(`resource pressure: ${resourceDecision.reason}`);
		}
		if (this.coordinationBudget) {
			if (activeWorkers > this.coordinationBudget.max_active_workers)
				throw new WorkerPoolLeaseConflictError("coordination budget max_active_workers exceeded");
			if (activeWorkers > this.coordinationBudget.max_concurrent_roles)
				throw new WorkerPoolLeaseConflictError("coordination budget max_concurrent_roles exceeded");
		}
		this.budgetController?.reserveDispatch(taskId, activeWorkers, 0, activeWorkers);
	}

	private releaseCoordination(_entry: WorkerPoolEntry, taskId: string): void {
		this.budgetController?.releaseDispatch(taskId, this.workerLeases.size, this.workerLeases.size);
	}

	private async executeWithMemoryGuard(
		entry: WorkerPoolEntry,
		poolLease: WorkerPoolLease,
		execution: Promise<ResultContract>,
	): Promise<ResultContract> {
		const ceiling = this.resourceCeiling;
		const monitor = this.memoryMonitor;
		const pid = lifecycleSnapshot(entry)?.pid;
		if (!ceiling || !monitor || !pid) return execution;
		let timer: NodeJS.Timeout | undefined;
		let cancelled = false;
		const pressure = new Promise<{ memory_mb: number }>((resolve) => {
			const check = () => {
				if (cancelled) return;
				const memoryMb = monitor.workerMemoryMb(pid);
				if (memoryMb !== undefined && memoryMb > ceiling.max_memory_mb_per_worker) {
					resolve({ memory_mb: memoryMb });
					return;
				}
				timer = setTimeout(check, 20);
			};
			check();
		});
		const outcome = await Promise.race([
			execution.then((result) => ({ kind: "result" as const, result })),
			pressure.then((sample) => ({ kind: "memory" as const, sample })),
		]);
		cancelled = true;
		if (timer) clearTimeout(timer);
		if (outcome.kind === "result") return outcome.result;
		void execution.catch(() => undefined);
		const reason = `resource ceiling exceeded: worker_memory_mb=${outcome.sample.memory_mb.toFixed(1)}`;
		await entry.lifecycle?.crash();
		await this.reclaim(poolLease, reason);
		this.recoveryManager?.recover({
			task_id: poolLease.task_id,
			fault: "crash",
			worker_id: poolLease.worker_id,
			reason,
			at: new Date(this.now()).toISOString(),
		});
		throw new WorkerPoolMemoryLimitError(
			poolLease.worker_id,
			outcome.sample.memory_mb,
			ceiling.max_memory_mb_per_worker,
		);
	}

	private applyProcessSnapshot(entry: WorkerPoolEntry, snapshot: WorkerProcessSnapshot): void {
		if (snapshot.adapter_id !== entry.adapter_id)
			throw new WorkerPoolError(`process adapter mismatch for ${entry.worker_id}`);
		if (snapshot.workspace_path !== entry.workspace_path)
			throw new WorkerPoolError(`process workspace mismatch for ${entry.worker_id}`);
		entry.session_id = snapshot.session_id;
		entry.session_id_sha256 = snapshot.session_id_sha256;
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
