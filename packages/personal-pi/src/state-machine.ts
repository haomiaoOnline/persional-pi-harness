import type { TaskRecord, TaskStatus, TransitionAuditEntry } from "./types.ts";

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	DRAFT: ["READY", "BLOCKED", "CANCELLED", "OBSOLETE"],
	READY: ["RUNNING", "BLOCKED", "CANCELLED", "OBSOLETE"],
	RUNNING: ["VERIFYING", "FAILED", "BLOCKED", "CANCELLED"],
	VERIFYING: ["DONE", "FAILED", "BLOCKED", "READY"],
	DONE: ["OBSOLETE"],
	FAILED: ["READY", "BLOCKED", "CANCELLED", "OBSOLETE"],
	BLOCKED: ["READY", "CANCELLED", "OBSOLETE"],
	CANCELLED: ["OBSOLETE"],
	OBSOLETE: [],
};

export class InvalidTaskTransitionError extends Error {
	readonly from: TaskStatus;
	readonly to: TaskStatus;

	constructor(from: TaskStatus, to: TaskStatus) {
		super(`invalid task transition: ${from} -> ${to}`);
		this.name = "InvalidTaskTransitionError";
		this.from = from;
		this.to = to;
	}
}

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
	return TRANSITIONS[from];
}

export class TaskStateMachine {
	transition(task: TaskRecord, to: TaskStatus, reason?: string, at = new Date().toISOString()): TaskRecord {
		if (!isValidTaskTransition(task.state, to)) throw new InvalidTaskTransitionError(task.state, to);
		const auditEntry: TransitionAuditEntry = {
			from: task.state,
			to,
			at,
			reason,
		};
		return {
			...task,
			state: to,
			audit_log: [...task.audit_log, auditEntry],
		};
	}
}

export function createTaskRecord(contract: Omit<TaskRecord, "state" | "audit_log">): TaskRecord {
	return {
		...contract,
		state: "DRAFT",
		audit_log: [],
	};
}
