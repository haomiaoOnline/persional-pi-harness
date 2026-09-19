export type BackpressureScope = "domain" | "provider";

export interface BackpressureKey {
	scope: BackpressureScope;
	key: string;
}

export interface BackpressureSignal extends BackpressureKey {
	status: number;
	retry_after_ms?: number;
	at?: number;
}

export interface BackpressureAdmission extends BackpressureKey {
	action: "ALLOW" | "QUEUE";
	wait_ms: number;
	blocked_until?: number;
	reason: string;
}

interface BackpressureState {
	consecutive_failures: number;
	blocked_until?: number;
}

export class ExecutionBackpressureController {
	private readonly states = new Map<string, BackpressureState>();
	private readonly baseBackoffMs: number;
	private readonly maxBackoffMs: number;

	constructor(options: { base_backoff_ms?: number; max_backoff_ms?: number } = {}) {
		this.baseBackoffMs = options.base_backoff_ms ?? 1_000;
		this.maxBackoffMs = options.max_backoff_ms ?? 60_000;
		if (this.baseBackoffMs < 1 || this.maxBackoffMs < this.baseBackoffMs)
			throw new Error("invalid backpressure backoff bounds");
	}

	admit(input: BackpressureKey, at = Date.now()): BackpressureAdmission {
		const state = this.states.get(this.id(input));
		const blockedUntil = state?.blocked_until;
		if (blockedUntil !== undefined && blockedUntil > at) {
			return {
				...input,
				action: "QUEUE",
				wait_ms: blockedUntil - at,
				blocked_until: blockedUntil,
				reason: `${input.scope} backpressure until ${blockedUntil}`,
			};
		}
		return { ...input, action: "ALLOW", wait_ms: 0, reason: `${input.scope} admitted` };
	}

	report(signal: BackpressureSignal): BackpressureAdmission {
		const at = signal.at ?? Date.now();
		const id = this.id(signal);
		const state = this.states.get(id) ?? { consecutive_failures: 0 };
		if (!this.retryable(signal.status)) {
			state.consecutive_failures = 0;
			state.blocked_until = undefined;
			this.states.set(id, state);
			return this.admit(signal, at);
		}
		state.consecutive_failures += 1;
		const deterministicBackoff = Math.min(
			this.maxBackoffMs,
			this.baseBackoffMs * 2 ** Math.max(0, state.consecutive_failures - 1),
		);
		const waitMs = Math.min(this.maxBackoffMs, Math.max(1, signal.retry_after_ms ?? deterministicBackoff));
		state.blocked_until = at + waitMs;
		this.states.set(id, state);
		return this.admit(signal, at);
	}

	clear(input: BackpressureKey): void {
		this.states.delete(this.id(input));
	}

	private retryable(status: number): boolean {
		return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
	}

	private id(input: BackpressureKey): string {
		const key = input.key.trim().toLowerCase();
		if (!key) throw new Error("backpressure key must not be empty");
		return `${input.scope}:${key}`;
	}
}
