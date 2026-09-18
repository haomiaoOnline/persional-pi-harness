import type { PersistentStateStore } from "./persistence.ts";
import type { TaskLedgerBinding, TaskLedgerEntry, VerificationRecord } from "./types.ts";

export interface TaskLedgerBindingInput {
	project_id: string;
	project_task_id: string;
	pph_task_id: string;
	phase: string;
	unknowns: string[];
}

export class TaskLedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskLedgerError";
	}
}

function required(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new TaskLedgerError(`${field} must not be empty`);
	return normalized;
}

function normalizeBinding(input: TaskLedgerBindingInput): TaskLedgerBinding {
	if (!Array.isArray(input.unknowns)) throw new TaskLedgerError("unknowns must be present");
	return {
		project_id: required(input.project_id, "project_id"),
		project_task_id: required(input.project_task_id, "project_task_id"),
		pph_task_id: required(input.pph_task_id, "pph_task_id"),
		phase: required(input.phase, "phase"),
		unknowns: input.unknowns.map((unknown, index) => required(unknown, `unknowns[${index}]`)),
	};
}

function latestVerification(
	verifications: readonly VerificationRecord[],
	taskId: string,
	taskRevision: number,
): VerificationRecord | undefined {
	return verifications
		.filter((verification) => verification.task_id === taskId && verification.task_revision === taskRevision)
		.at(-1);
}

export class TaskLedger {
	private readonly store: PersistentStateStore;

	constructor(store: PersistentStateStore) {
		this.store = store;
	}

	bind(input: TaskLedgerBindingInput): TaskLedgerEntry {
		const binding = normalizeBinding(input);
		if (!this.store.getProject(binding.project_id))
			throw new TaskLedgerError(`unknown project: ${binding.project_id}`);
		if (!this.store.getTask(binding.pph_task_id)) throw new TaskLedgerError(`unknown task: ${binding.pph_task_id}`);
		const bindings = this.store.listTaskLedgerBindings();
		if (
			bindings.some(
				(candidate) =>
					candidate.project_id === binding.project_id && candidate.project_task_id === binding.project_task_id,
			)
		)
			throw new TaskLedgerError(`project task already bound: ${binding.project_id}/${binding.project_task_id}`);
		if (bindings.some((candidate) => candidate.pph_task_id === binding.pph_task_id))
			throw new TaskLedgerError(`pph task already bound: ${binding.pph_task_id}`);
		this.store.addTaskLedgerBinding(binding);
		return this.project(binding);
	}

	resolveByProjectTask(projectId: string, projectTaskId: string): TaskLedgerEntry {
		const binding = this.store
			.listTaskLedgerBindings()
			.find((candidate) => candidate.project_id === projectId && candidate.project_task_id === projectTaskId);
		if (!binding) throw new TaskLedgerError(`unknown project task: ${projectId}/${projectTaskId}`);
		return this.project(binding);
	}

	resolveByPphTask(pphTaskId: string): TaskLedgerEntry {
		const binding = this.store.listTaskLedgerBindings().find((candidate) => candidate.pph_task_id === pphTaskId);
		if (!binding) throw new TaskLedgerError(`unknown pph task: ${pphTaskId}`);
		return this.project(binding);
	}

	listProject(projectId: string): TaskLedgerEntry[] {
		if (!this.store.getProject(projectId)) throw new TaskLedgerError(`unknown project: ${projectId}`);
		return this.store
			.listTaskLedgerBindings()
			.filter((binding) => binding.project_id === projectId)
			.map((binding) => this.project(binding));
	}

	private project(binding: TaskLedgerBinding): TaskLedgerEntry {
		const task = this.store.getTask(binding.pph_task_id);
		if (!task) throw new TaskLedgerError(`dangling task ledger binding: ${binding.pph_task_id}`);
		if (!task.role_profile_ref) throw new TaskLedgerError(`task has no owner role_profile_ref: ${task.id}`);
		const state = this.store.read();
		const verification = latestVerification(state.verifications, task.id, task.task_revision);
		const acceptance = state.acceptances.find(
			(entry) => entry.task_id === task.id && entry.task_revision === task.task_revision,
		);
		if (task.state === "DONE" && !acceptance)
			throw new TaskLedgerError(`DONE task is missing current-revision AcceptanceRecord: ${task.id}`);
		if (acceptance && task.state !== "DONE")
			throw new TaskLedgerError(`AcceptanceRecord exists for non-DONE task: ${task.id}`);
		const gateStatus = acceptance
			? "PASS"
			: verification?.status === "FAIL"
				? "FAIL"
				: verification?.status === "UNKNOWN"
					? "UNKNOWN"
					: "PENDING";
		return {
			...structuredClone(binding),
			task_revision: task.task_revision,
			owner: task.role_profile_ref,
			scope: [...task.scope.files],
			status: task.state,
			verification_recipe: task.verification.recipe_ref ?? null,
			evidence_refs: state.evidence
				.filter((evidence) => evidence.task_id === task.id)
				.map((evidence) => evidence.id),
			gate_status: gateStatus,
		};
	}
}
