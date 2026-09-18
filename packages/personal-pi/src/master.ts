import { validateMasterHandoffReceipt } from "./handoff.ts";
import { validateTaskContract } from "./schema.ts";
import { createTaskRecord } from "./state-machine.ts";
import type { MasterHandoffReceipt, TaskContract, TaskRecord } from "./types.ts";

export class MasterBoundaryViolationError extends Error {
	constructor(action: string) {
		super(`Master is control-only and cannot perform business action: ${action}`);
		this.name = "MasterBoundaryViolationError";
	}
}

export class MasterControlPlane {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly handoffs = new Map<string, MasterHandoffReceipt>();
	private businessWriteAttempts = 0;

	createTask(contract: TaskContract): TaskRecord {
		const validation = validateTaskContract(contract);
		if (!validation.valid) throw new Error(`cannot create invalid task: ${validation.errors.join("; ")}`);
		if (this.tasks.has(contract.id)) throw new Error(`task already exists: ${contract.id}`);
		const record = createTaskRecord(contract);
		this.tasks.set(record.id, record);
		return structuredClone(record);
	}

	updateTask(task: TaskRecord): TaskRecord {
		if (!this.tasks.has(task.id)) throw new Error(`unknown task: ${task.id}`);
		this.tasks.set(task.id, structuredClone(task));
		return structuredClone(task);
	}

	getTask(taskId: string): TaskRecord | undefined {
		const task = this.tasks.get(taskId);
		return task ? structuredClone(task) : undefined;
	}

	listTasks(): TaskRecord[] {
		return [...this.tasks.values()].map((task) => structuredClone(task));
	}

	receiveHandoff(value: unknown): MasterHandoffReceipt {
		const validation = validateMasterHandoffReceipt(value);
		if (!validation.valid || !validation.value)
			throw new MasterBoundaryViolationError(`invalid receipt-only handoff: ${validation.errors.join("; ")}`);
		const receipt = structuredClone(validation.value);
		this.handoffs.set(receipt.task_id, receipt);
		return structuredClone(receipt);
	}

	getHandoff(taskId: string): MasterHandoffReceipt | undefined {
		const receipt = this.handoffs.get(taskId);
		return receipt ? structuredClone(receipt) : undefined;
	}

	listHandoffs(): MasterHandoffReceipt[] {
		return [...this.handoffs.values()].map((receipt) => structuredClone(receipt));
	}

	requestBusinessWrite(action: string): never {
		this.businessWriteAttempts += 1;
		throw new MasterBoundaryViolationError(action);
	}

	getBusinessWriteAttempts(): number {
		return this.businessWriteAttempts;
	}
}
