export type ProviderCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type ProviderAdmissionAction = "ALLOW" | "QUEUE" | "FALLBACK";

import { createModelIdentity } from "./result.ts";
import type { ModelIdentity, ResultContract, WorkerExecutionControls, WorkerProtocolRequest } from "./types.ts";
import type { WorkerAdapter } from "./worker.ts";

export interface ProviderResilienceConfig {
	provider_id: string;
	rate_limit: {
		max_requests: number;
		interval_ms: number;
	};
	quota_limit?: number;
	failure_threshold: number;
	cooldown_ms: number;
}

export interface ProviderAdmission {
	action: ProviderAdmissionAction;
	provider_id: string;
	fallback_from?: string;
	reason: string;
	queue_depth: number;
}

export interface ProviderResilienceSnapshot {
	provider_id: string;
	state: ProviderCircuitState;
	requests_used: number;
	quota_remaining?: number;
	consecutive_failures: number;
	opened_until?: number;
	probe_in_flight: boolean;
}

interface ProviderState {
	config: ProviderResilienceConfig;
	state: ProviderCircuitState;
	request_timestamps: number[];
	requests_used: number;
	consecutive_failures: number;
	opened_until?: number;
	probe_in_flight: boolean;
}

interface QueuedRequest {
	request_id: string;
	provider_id: string;
	fallback_provider_id?: string;
}

export class ProviderResilienceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderResilienceError";
	}
}

function isRetryableProviderFailure(status: number): boolean {
	return status === 429 || status === 500;
}

export class ProviderResilienceController {
	private readonly providers = new Map<string, ProviderState>();
	private readonly pending: QueuedRequest[] = [];

	register(config: ProviderResilienceConfig): ProviderResilienceSnapshot {
		if (this.providers.has(config.provider_id))
			throw new ProviderResilienceError(`provider already registered: ${config.provider_id}`);
		if (config.rate_limit.max_requests < 1 || config.rate_limit.interval_ms < 1)
			throw new ProviderResilienceError("rate limit must be positive");
		if (config.failure_threshold < 1 || config.cooldown_ms < 1)
			throw new ProviderResilienceError("failure threshold and cooldown must be positive");
		if (config.quota_limit !== undefined && config.quota_limit < 1)
			throw new ProviderResilienceError("quota_limit must be positive");
		const state: ProviderState = {
			config: { ...config, rate_limit: { ...config.rate_limit } },
			state: "CLOSED",
			request_timestamps: [],
			requests_used: 0,
			consecutive_failures: 0,
			probe_in_flight: false,
		};
		this.providers.set(config.provider_id, state);
		return this.snapshot(state);
	}

	admit(providerId: string, options: { fallback_provider_id?: string; at?: number } = {}): ProviderAdmission {
		const at = options.at ?? Date.now();
		const primary = this.tryAdmit(providerId, at);
		if (primary.action === "ALLOW" || !options.fallback_provider_id) return primary;
		const fallback = this.tryAdmit(options.fallback_provider_id, at);
		if (fallback.action === "ALLOW") {
			return {
				action: "FALLBACK",
				provider_id: fallback.provider_id,
				fallback_from: providerId,
				reason: `${providerId} unavailable: ${primary.reason}`,
				queue_depth: this.pending.length,
			};
		}
		return {
			...primary,
			reason: `${primary.reason}; fallback ${options.fallback_provider_id} unavailable: ${fallback.reason}`,
		};
	}

	enqueue(
		requestId: string,
		providerId: string,
		options: { fallback_provider_id?: string; at?: number } = {},
	): ProviderAdmission {
		const admission = this.admit(providerId, options);
		if (admission.action !== "QUEUE") return admission;
		if (!this.pending.some((request) => request.request_id === requestId))
			this.pending.push({
				request_id: requestId,
				provider_id: providerId,
				fallback_provider_id: options.fallback_provider_id,
			});
		return { ...admission, queue_depth: this.pending.length };
	}

	drain(at = Date.now()): ProviderAdmission[] {
		const admitted: ProviderAdmission[] = [];
		const remaining: QueuedRequest[] = [];
		for (const request of this.pending) {
			const admission = this.admit(request.provider_id, {
				fallback_provider_id: request.fallback_provider_id,
				at,
			});
			if (admission.action === "QUEUE") remaining.push(request);
			else admitted.push(admission);
		}
		this.pending.length = 0;
		this.pending.push(...remaining);
		return admitted;
	}

	recordResponse(providerId: string, status: number, at = Date.now()): ProviderResilienceSnapshot {
		const state = this.requireProvider(providerId);
		if (state.state === "HALF_OPEN") {
			state.probe_in_flight = false;
			if (isRetryableProviderFailure(status)) this.open(state, at);
			else this.close(state);
			return this.snapshot(state);
		}
		if (!isRetryableProviderFailure(status)) {
			state.consecutive_failures = 0;
			return this.snapshot(state);
		}
		state.consecutive_failures += 1;
		if (state.consecutive_failures >= state.config.failure_threshold) this.open(state, at);
		return this.snapshot(state);
	}

	status(providerId: string): ProviderResilienceSnapshot {
		return this.snapshot(this.requireProvider(providerId));
	}

	queueDepth(): number {
		return this.pending.length;
	}

	private tryAdmit(providerId: string, at: number): ProviderAdmission {
		const state = this.requireProvider(providerId);
		this.prune(state, at);
		if (state.state === "OPEN") {
			if ((state.opened_until ?? 0) > at)
				return this.blocked(providerId, `circuit open until ${state.opened_until}`);
			state.state = "HALF_OPEN";
		}
		if (state.state === "HALF_OPEN") {
			if (state.probe_in_flight) return this.blocked(providerId, "half-open probe already in flight");
			state.probe_in_flight = true;
		} else if (state.request_timestamps.length >= state.config.rate_limit.max_requests) {
			return this.blocked(providerId, "rate limit exceeded");
		} else if (state.config.quota_limit !== undefined && state.requests_used >= state.config.quota_limit) {
			return this.blocked(providerId, "quota exhausted");
		}
		state.request_timestamps.push(at);
		state.requests_used += 1;
		return {
			action: "ALLOW",
			provider_id: providerId,
			reason: "provider admitted",
			queue_depth: this.pending.length,
		};
	}

	private blocked(providerId: string, reason: string): ProviderAdmission {
		return { action: "QUEUE", provider_id: providerId, reason, queue_depth: this.pending.length };
	}

	private open(state: ProviderState, at: number): void {
		state.state = "OPEN";
		state.opened_until = at + state.config.cooldown_ms;
		state.probe_in_flight = false;
	}

	private close(state: ProviderState): void {
		state.state = "CLOSED";
		state.opened_until = undefined;
		state.consecutive_failures = 0;
		state.probe_in_flight = false;
	}

	private prune(state: ProviderState, at: number): void {
		const cutoff = at - state.config.rate_limit.interval_ms;
		state.request_timestamps = state.request_timestamps.filter((timestamp) => timestamp > cutoff);
	}

	private snapshot(state: ProviderState): ProviderResilienceSnapshot {
		return {
			provider_id: state.config.provider_id,
			state: state.state,
			requests_used: state.requests_used,
			quota_remaining:
				state.config.quota_limit === undefined
					? undefined
					: Math.max(0, state.config.quota_limit - state.requests_used),
			consecutive_failures: state.consecutive_failures,
			opened_until: state.opened_until,
			probe_in_flight: state.probe_in_flight,
		};
	}

	private requireProvider(providerId: string): ProviderState {
		const provider = this.providers.get(providerId);
		if (!provider) throw new ProviderResilienceError(`unknown provider: ${providerId}`);
		return provider;
	}
}

export interface ProviderResilientWorkerAdapterOptions {
	adapter: WorkerAdapter;
	provider_id: string;
	controller: ProviderResilienceController;
	fallback_provider_id?: string;
	response_status?: (result: ResultContract) => number;
}

function providerAdmissionFailure(
	request: WorkerProtocolRequest,
	workerId: string,
	requestedModel: string,
	admission: ProviderAdmission,
): ResultContract {
	return {
		task_id: request.task.id,
		run_id: request.run_id ?? `provider-queue-${request.task.id}`,
		worker_id: workerId,
		lease_epoch: request.protocol.lease_epoch,
		status: "failure",
		summary: "provider admission blocked the Worker execution",
		changed_files: [],
		artifacts: [],
		evidence: [
			`${admission.provider_id}:admission=QUEUE`,
			`${admission.provider_id}:queue_depth=${admission.queue_depth}`,
		],
		errors: [`provider backpressure: ${admission.reason}`],
		model_identity: createModelIdentity(requestedModel),
		work_receipt: {
			work_attempted: false,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: true,
			no_op_reason: "provider backpressure queue",
			evidence_refs: [],
		},
	};
}

/** Applies one shared provider admission controller to every Worker instance. */
export class ProviderResilientWorkerAdapter implements WorkerAdapter {
	readonly worker_id: string;
	readonly provider_id: string;
	readonly requested_model: string;
	private readonly adapter: WorkerAdapter;
	private readonly controller: ProviderResilienceController;
	private readonly fallbackProviderId?: string;
	private readonly responseStatus: (result: ResultContract) => number;

	constructor(options: ProviderResilientWorkerAdapterOptions) {
		if (!options.provider_id) throw new ProviderResilienceError("provider_id must not be empty");
		this.worker_id = options.adapter.worker_id;
		this.provider_id = options.provider_id;
		this.requested_model = options.adapter.requested_model?.trim() || "unknown";
		this.adapter = options.adapter;
		this.controller = options.controller;
		this.fallbackProviderId = options.fallback_provider_id;
		this.responseStatus = options.response_status ?? ((result) => (result.status === "success" ? 200 : 500));
	}

	getModelIdentity(): ModelIdentity {
		return this.adapter.getModelIdentity?.() ?? createModelIdentity(this.requested_model);
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		const admission = this.controller.admit(this.provider_id, {
			fallback_provider_id: this.fallbackProviderId,
		});
		if (admission.action === "QUEUE")
			return providerAdmissionFailure(request, this.worker_id, this.requested_model, admission);
		try {
			const result = await this.adapter.execute(request, controls);
			this.controller.recordResponse(admission.provider_id, this.responseStatus(result));
			return {
				...result,
				evidence: [
					...result.evidence,
					`${admission.provider_id}:admission=${admission.action}`,
					`${admission.provider_id}:queue_depth=${admission.queue_depth}`,
				],
			};
		} catch (error) {
			this.controller.recordResponse(admission.provider_id, 500);
			throw error;
		}
	}
}
