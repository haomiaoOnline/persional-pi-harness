import { createTaskRecord } from "./state-machine.ts";
import type { JsonValue, TaskContract, TaskRecord } from "./types.ts";

export interface WebhookEvent {
	source: string;
	event_id: string;
	payload: JsonValue;
	received_at?: string;
}

export interface ScheduleDefinition {
	id: string;
	cron: string;
}

export interface TriggerTaskInput {
	trigger_id: string;
	idempotency_key: string;
	payload: JsonValue;
	triggered_at: string;
}

export type TriggerTaskFactory = (input: TriggerTaskInput) => TaskContract;

export interface TriggerResult {
	created: boolean;
	idempotency_key: string;
	task?: TaskRecord;
	reason: string;
}

export interface TriggerAlert {
	idempotency_key: string;
	message: string;
	at: string;
}

export class TriggerGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TriggerGatewayError";
	}
}

function cloneResult(result: TriggerResult): TriggerResult {
	return { ...result, task: result.task ? structuredClone(result.task) : undefined };
}

function fieldMatches(field: string, value: number, minimum: number, maximum: number): boolean {
	if (field === "*") return true;
	return field.split(",").some((part) => {
		if (part.startsWith("*/")) {
			const step = Number(part.slice(2));
			return Number.isInteger(step) && step > 0 && (value - minimum) % step === 0;
		}
		if (part.includes("-")) {
			const [start, end] = part.split("-").map(Number);
			return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end;
		}
		const expected = Number(part);
		return Number.isInteger(expected) && expected >= minimum && expected <= maximum && expected === value;
	});
}

export function matchesLocalCron(expression: string, date: Date): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) return false;
	const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
	const ranges = [
		[0, 59],
		[0, 23],
		[1, 31],
		[1, 12],
		[0, 6],
	] as const;
	return fields.every((field, index) => fieldMatches(field, values[index], ranges[index][0], ranges[index][1]));
}

export class TriggerGateway {
	private readonly handled = new Map<string, TriggerResult>();
	private readonly triggerAlerts: TriggerAlert[] = [];
	private readonly createTask: (contract: TaskContract) => TaskRecord;

	constructor(createTask?: (contract: TaskContract) => TaskRecord) {
		this.createTask = createTask ?? ((contract) => createTaskRecord(contract));
	}

	createFromWebhook(
		event: WebhookEvent,
		factory: TriggerTaskFactory,
		condition: (payload: JsonValue) => boolean = () => true,
	): TriggerResult {
		const idempotencyKey = `webhook:${event.source}:${event.event_id}`;
		const previous = this.handled.get(idempotencyKey);
		if (previous) return { ...cloneResult(previous), created: false, reason: "duplicate idempotency_key" };
		if (!condition(event.payload)) {
			const result = { created: false, idempotency_key: idempotencyKey, reason: "trigger condition did not match" };
			this.handled.set(idempotencyKey, result);
			return cloneResult(result);
		}
		return this.createOnce(
			idempotencyKey,
			event.source,
			event.payload,
			event.received_at ?? new Date().toISOString(),
			factory,
		);
	}

	createFromSchedule(schedule: ScheduleDefinition, at: Date, factory: TriggerTaskFactory): TriggerResult {
		const idempotencyKey = `schedule:${schedule.id}:${at.toISOString().slice(0, 16)}`;
		const previous = this.handled.get(idempotencyKey);
		if (previous) return { ...cloneResult(previous), created: false, reason: "duplicate idempotency_key" };
		if (!matchesLocalCron(schedule.cron, at)) {
			const result = { created: false, idempotency_key: idempotencyKey, reason: "schedule does not match" };
			this.handled.set(idempotencyKey, result);
			return cloneResult(result);
		}
		return this.createOnce(idempotencyKey, schedule.id, { schedule: schedule.id }, at.toISOString(), factory);
	}

	alerts(): TriggerAlert[] {
		return this.triggerAlerts.map((alert) => ({ ...alert }));
	}

	private createOnce(
		idempotencyKey: string,
		triggerId: string,
		payload: JsonValue,
		triggeredAt: string,
		factory: TriggerTaskFactory,
	): TriggerResult {
		try {
			const task = this.createTask(
				factory({ trigger_id: triggerId, idempotency_key: idempotencyKey, payload, triggered_at: triggeredAt }),
			);
			const result = { created: true, idempotency_key: idempotencyKey, task, reason: "task contract created" };
			this.handled.set(idempotencyKey, result);
			return cloneResult(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const alert = {
				idempotency_key: idempotencyKey,
				message: `task creation failed: ${message}`,
				at: triggeredAt,
			};
			this.triggerAlerts.push(alert);
			const result = { created: false, idempotency_key: idempotencyKey, reason: alert.message };
			this.handled.set(idempotencyKey, result);
			return cloneResult(result);
		}
	}
}
