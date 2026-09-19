import { ArtifactStore } from "./artifacts.ts";
import type { PersonalPiPipeline, PipelineExecution, PipelineRequest } from "./pipeline.ts";
import { createProtocolEnvelope } from "./protocol.ts";
import { createModelIdentity } from "./result.ts";
import { computeGraphEfficiencyMetrics } from "./trace.ts";
import type {
	ExecutionMode,
	ExecutionTrace,
	ResultContract,
	WorkerExecutionControls,
	WorkerProtocolRequest,
	WorkerStatus,
} from "./types.ts";
import type { WorkerAdapter } from "./worker.ts";
import { workerStatusForAvailability } from "./worker.ts";
import type { WorkerPool, WorkerPoolLease } from "./worker-pool.ts";

export interface DispatchExecutorJob {
	request: Omit<PipelineRequest, "worker" | "worker_status" | "dispatch_execution">;
	preferred_worker_ids?: readonly string[];
	worker_status?: WorkerStatus;
}

export interface DispatchWaveExecution {
	requested_mode: "parallel";
	effective_mode: "parallel" | "single";
	effective_worker_count: number;
	degrade_reason?: string;
	overlap_proof_ref?: string;
	executions: PipelineExecution[];
}

interface WorkerWindow {
	task_id: string;
	worker_id: string;
	started_ms: number;
	ended_ms: number;
}

function peakOverlap(windows: readonly WorkerWindow[]): number {
	const events = windows.flatMap((window) => [
		{ at: window.started_ms, delta: 1 },
		{ at: window.ended_ms, delta: -1 },
	]);
	events.sort((left, right) => left.at - right.at || left.delta - right.delta);
	let active = 0;
	let peak = 0;
	for (const event of events) {
		active += event.delta;
		peak = Math.max(peak, active);
	}
	return peak;
}

function runtimeTrace(
	trace: ExecutionTrace,
	effectiveMode: "parallel" | "single",
	effectiveWorkers: number,
	overlapProofRef: string | undefined,
	degradeReason: string | undefined,
): ExecutionTrace {
	const next = structuredClone(trace);
	const dispatchEvent = next.events.find((event) => event.stage === "DISPATCH");
	if (dispatchEvent) {
		dispatchEvent.fields = {
			...(dispatchEvent.fields ?? {}),
			effective_mode: effectiveMode,
			effective_worker_count: effectiveWorkers,
			graph_width: effectiveWorkers,
			active_workers: effectiveWorkers,
			...(overlapProofRef ? { overlap_proof_ref: overlapProofRef } : {}),
			...(degradeReason ? { degrade_reason: degradeReason } : {}),
		};
	}
	next.metrics.graph_efficiency = computeGraphEfficiencyMetrics(next);
	return next;
}

class PoolLeaseWorker implements WorkerAdapter {
	readonly worker_id: string;
	readonly requested_model?: string;
	readonly context_limit?: number;
	private readonly pool: WorkerPool;
	private readonly lease: WorkerPoolLease;
	private readonly delegate: WorkerAdapter;
	private readonly windows: WorkerWindow[];

	constructor(pool: WorkerPool, lease: WorkerPoolLease, windows: WorkerWindow[]) {
		this.pool = pool;
		this.lease = lease;
		this.delegate = lease.adapter;
		this.windows = windows;
		this.worker_id = lease.worker_id;
		this.requested_model = lease.adapter.requested_model;
		this.context_limit = lease.adapter.context_limit;
	}

	getModelIdentity() {
		return this.delegate.getModelIdentity?.() ?? createModelIdentity(this.requested_model ?? "unknown");
	}

	getToolResults() {
		return this.delegate.getToolResults?.() ?? [];
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		const started = Date.now();
		const poolRequest: WorkerProtocolRequest = {
			...request,
			protocol: { ...request.protocol, lease_epoch: this.lease.lease.lease_epoch },
		};
		try {
			const result = await this.pool.execute(this.lease, poolRequest, controls);
			return { ...result, lease_epoch: request.protocol.lease_epoch };
		} finally {
			this.windows.push({
				task_id: request.task.id,
				worker_id: this.lease.worker_id,
				started_ms: started,
				ended_ms: Date.now(),
			});
		}
	}
}

export class DispatchExecutor {
	private readonly pipeline: PersonalPiPipeline;
	private readonly workerPool: WorkerPool;
	private readonly artifactStore: ArtifactStore;

	constructor(options: { pipeline: PersonalPiPipeline; worker_pool: WorkerPool; artifact_store?: ArtifactStore }) {
		this.pipeline = options.pipeline;
		this.workerPool = options.worker_pool;
		this.artifactStore =
			options.artifact_store ?? new ArtifactStore(this.pipeline.stateStore.artifactStoreRootPath());
	}

	async executeParallelWave(jobs: readonly DispatchExecutorJob[]): Promise<DispatchWaveExecution> {
		if (jobs.length < 2) throw new Error("parallel Dispatch wave requires at least two leaf Tasks");
		const executions: PipelineExecution[] = [];
		const windows: WorkerWindow[] = [];
		const placeholders = jobs.map((job) => ({
			task_id: job.request.task.id,
			role_id: job.request.task.role_profile_ref,
			preferred_worker_ids: job.preferred_worker_ids,
			request: {
				task: job.request.task,
				protocol: createProtocolEnvelope(job.request.task, 1),
			} satisfies WorkerProtocolRequest,
			execute_with_lease: async (
				lease: WorkerPoolLease,
				decision: { mode: "parallel" | "serial"; reason: string },
			): Promise<ResultContract> => {
				const worker = new PoolLeaseWorker(this.workerPool, lease, windows);
				const workerStatus = job.worker_status ?? workerStatusForAvailability(true);
				const execution = await this.pipeline.execute({
					...job.request,
					worker,
					worker_status: workerStatus,
					dispatch_execution: {
						requested_mode: "parallel",
						effective_mode: "single",
						executor_kind: "worker_pool",
						planned_worker_count: jobs.length,
						effective_worker_count: 1,
						degrade_reason:
							decision.mode === "serial" ? decision.reason : "parallel runtime overlap proof pending",
					},
				});
				executions.push(execution);
				return execution.result;
			},
		}));

		const batch = await this.workerPool.executeResourceAwareBatch(placeholders);
		const observedPeak = peakOverlap(windows);
		const parallel = batch.mode === "parallel" && observedPeak >= 2;
		const effectiveMode: "parallel" | "single" = parallel ? "parallel" : "single";
		const effectiveWorkers = parallel ? observedPeak : Math.min(1, observedPeak);
		const degradeReason = parallel
			? undefined
			: batch.mode === "serial"
				? batch.reason
				: "parallel execution produced no overlapping Worker windows";
		let overlapProofRef: string | undefined;
		if (parallel) {
			const anchor = jobs[0]?.request.task;
			if (!anchor) throw new Error("parallel Dispatch wave lost its anchor Task");
			overlapProofRef = this.artifactStore.put(
				"dispatch_overlap_proof",
				1,
				{
					requested_mode: "parallel",
					effective_worker_count: observedPeak,
					windows: windows.map((window) => ({
						task_id: window.task_id,
						worker_id: window.worker_id,
						started_ms: window.started_ms,
						ended_ms: window.ended_ms,
					})),
				},
				anchor.id,
				anchor.task_revision,
			).digest;
		}

		const finalizedExecutions = executions.map((execution) => {
			const finalizedDispatch = this.pipeline.stateStore.finalizeDispatchRuntime(execution.dispatch_record.id, {
				effective_mode: effectiveMode,
				effective_worker_count: effectiveWorkers,
				executor_kind: "worker_pool",
				degrade_reason: degradeReason,
				overlap_proof_ref: overlapProofRef,
			});
			const trace = runtimeTrace(execution.trace, effectiveMode, effectiveWorkers, overlapProofRef, degradeReason);
			this.pipeline.stateStore.addTrace(trace);
			return { ...execution, dispatch_record: finalizedDispatch, trace };
		});

		return {
			requested_mode: "parallel",
			effective_mode: effectiveMode,
			effective_worker_count: effectiveWorkers,
			degrade_reason: degradeReason,
			overlap_proof_ref: overlapProofRef,
			executions: finalizedExecutions,
		};
	}
}

export function dispatchModeForDecision(mode: "SINGLE_WORKER" | "DECOMPOSE" | "PARALLEL" | "BATCH"): ExecutionMode {
	if (mode === "DECOMPOSE") return "decompose";
	if (mode === "PARALLEL") return "parallel";
	if (mode === "BATCH") return "batch";
	return "single";
}
