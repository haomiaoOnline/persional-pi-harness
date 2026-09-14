import { createHash } from "node:crypto";
import type { PersistentStateStore } from "./persistence.ts";
import type { EffectExecutionResult, EffectRecord, TaskContract } from "./types.ts";

export class MissingIdempotencyKeyError extends Error {
	constructor() {
		super("external effects require execution.idempotency_key");
		this.name = "MissingIdempotencyKeyError";
	}
}

export class EffectJournalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EffectJournalError";
	}
}

export class EffectJournal {
	private readonly records = new Map<string, EffectRecord>();
	private readonly inFlight = new Map<string, Promise<EffectExecutionResult>>();
	private readonly store?: PersistentStateStore;

	constructor(store?: PersistentStateStore) {
		this.store = store;
		for (const record of store?.read().effects ?? []) this.records.set(record.idempotency_key, { ...record });
	}

	get(idempotencyKey: string): EffectRecord | undefined {
		const record = this.records.get(idempotencyKey);
		return record ? { ...record } : undefined;
	}

	async run(
		idempotencyKey: string,
		target: string,
		action: () => Promise<void> | void,
		options: { action_digest?: string; reversible?: boolean; compensation_action?: string } = {},
	): Promise<EffectExecutionResult> {
		const existing = this.records.get(idempotencyKey);
		if (existing && options.action_digest && existing.action_digest !== options.action_digest) {
			throw new EffectJournalError(`effect action digest mismatch for ${idempotencyKey}`);
		}
		if (existing?.status === "committed") return { committed: true, reused: true, record: { ...existing } };
		const running = this.inFlight.get(idempotencyKey);
		if (running) {
			const result = await running;
			return { ...result, reused: true, record: { ...result.record } };
		}
		const execution = this.execute(idempotencyKey, target, action, options);
		this.inFlight.set(idempotencyKey, execution);
		try {
			return await execution;
		} finally {
			if (this.inFlight.get(idempotencyKey) === execution) this.inFlight.delete(idempotencyKey);
		}
	}

	private async execute(
		idempotencyKey: string,
		target: string,
		action: () => Promise<void> | void,
		options: { action_digest?: string; reversible?: boolean; compensation_action?: string },
	): Promise<EffectExecutionResult> {
		const record: EffectRecord = {
			idempotency_key: idempotencyKey,
			action_digest:
				options.action_digest ?? createHash("sha256").update(`${idempotencyKey}:${target}`).digest("hex"),
			target,
			status: "pending",
			reversible: options.reversible ?? true,
			compensation_action: options.compensation_action,
			updated_at: new Date().toISOString(),
		};
		this.records.set(idempotencyKey, record);
		this.persist(record);
		try {
			await action();
			record.status = "committed";
			record.updated_at = new Date().toISOString();
			this.records.set(idempotencyKey, record);
			this.persist(record);
			return { committed: true, reused: false, record: { ...record } };
		} catch (error) {
			record.status = "failed";
			record.updated_at = new Date().toISOString();
			this.records.set(idempotencyKey, record);
			this.persist(record);
			throw error;
		}
	}

	private persist(record: EffectRecord): void {
		this.store?.transact((state) => {
			const index = state.effects.findIndex((candidate) => candidate.idempotency_key === record.idempotency_key);
			if (index >= 0) state.effects[index] = { ...record };
			else state.effects.push({ ...record });
		});
	}
}

export function requireIdempotencyKey(task: Pick<TaskContract, "execution">): string {
	const key = task.execution.idempotency_key;
	if (!key) throw new MissingIdempotencyKeyError();
	return key;
}
