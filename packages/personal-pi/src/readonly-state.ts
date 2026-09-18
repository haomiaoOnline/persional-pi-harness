import { clonePersistentState, loadPersistentState } from "./state-file.ts";
import { projectTaskLedgerEntry } from "./task-ledger.ts";
import type {
	PersistentState,
	ProjectRecord,
	RunRecord,
	TaskLedgerBinding,
	TaskLedgerEntry,
	TaskRecord,
} from "./types.ts";

export interface ReadonlyPersistentStateView {
	read(): PersistentState;
	getProject(projectId: string): ProjectRecord | undefined;
	getTask(taskId: string): TaskRecord | undefined;
	getRuns(taskId: string): RunRecord[];
	listTaskLedgerBindings(): TaskLedgerBinding[];
	getTaskLedgerEntry(taskId: string): TaskLedgerEntry | undefined;
}

export class FileReadonlyPersistentStateView implements ReadonlyPersistentStateView {
	private readonly state: PersistentState;

	constructor(path: string) {
		this.state = loadPersistentState(path);
	}

	read(): PersistentState {
		return clonePersistentState(this.state);
	}

	getProject(projectId: string): ProjectRecord | undefined {
		const project = this.state.projects.find((candidate) => candidate.project_id === projectId);
		return project ? structuredClone(project) : undefined;
	}

	getTask(taskId: string): TaskRecord | undefined {
		const task = this.state.tasks.find((candidate) => candidate.id === taskId);
		return task ? structuredClone(task) : undefined;
	}

	getRuns(taskId: string): RunRecord[] {
		return this.state.runs.filter((run) => run.task_id === taskId).map((run) => structuredClone(run));
	}

	listTaskLedgerBindings(): TaskLedgerBinding[] {
		return this.state.task_ledger.map((binding) => structuredClone(binding));
	}

	getTaskLedgerEntry(taskId: string): TaskLedgerEntry | undefined {
		const binding = this.state.task_ledger.find((candidate) => candidate.pph_task_id === taskId);
		return binding ? projectTaskLedgerEntry(this.state, binding) : undefined;
	}
}
