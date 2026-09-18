import { FileReadonlyPersistentStateView } from "./readonly-state.ts";

export function inspectStableCliTask(path: string, taskId: string): unknown {
	const view = new FileReadonlyPersistentStateView(path);
	const task = view.getTask(taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);
	const state = view.read();
	return {
		task,
		ledger: view.getTaskLedgerEntry(taskId),
		runs: view.getRuns(taskId),
		evidence: state.evidence.filter((record) => record.task_id === taskId),
		verifications: state.verifications.filter((record) => record.task_id === taskId),
		acceptances: state.acceptances.filter((record) => record.task_id === taskId),
	};
}

export function readStableCliGateStatus(path: string, taskId: string): unknown {
	const view = new FileReadonlyPersistentStateView(path);
	const entry = view.getTaskLedgerEntry(taskId);
	if (!entry) throw new Error(`task is not present in Task Ledger: ${taskId}`);
	return { task_id: taskId, status: entry.status, gate_status: entry.gate_status, task_revision: entry.task_revision };
}
