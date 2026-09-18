import { existsSync, readFileSync } from "node:fs";
import type { PersistentState } from "./types.ts";

export function createEmptyPersistentState(): PersistentState {
	return {
		version: 2,
		projects: [],
		task_ledger: [],
		acceptances: [],
		tasks: [],
		graphs: [],
		dispatches: [],
		runs: [],
		results: [],
		evidence: [],
		verifications: [],
		decisions: [],
		role_profiles: [],
		effects: [],
		budget_usage: {},
		budget_decisions: {},
		leases: {},
		lease_epochs: {},
		worker_instances: {},
		loop_usage: {},
		traces: [],
		regressions: [],
		snapshots: [],
		snapshot_payloads: {},
	};
}

export function normalizePersistentState(state: Partial<PersistentState>): PersistentState {
	const base = createEmptyPersistentState();
	return {
		...base,
		...state,
		task_ledger: state.task_ledger ?? [],
		acceptances: state.acceptances ?? [],
		traces: state.traces ?? [],
		regressions: state.regressions ?? [],
		budget_usage: state.budget_usage ?? {},
		budget_decisions: state.budget_decisions ?? {},
		leases: state.leases ?? {},
		lease_epochs: state.lease_epochs ?? {},
		worker_instances: state.worker_instances ?? {},
		loop_usage: state.loop_usage ?? {},
		snapshot_payloads: state.snapshot_payloads ?? {},
	};
}

export function clonePersistentState(state: PersistentState): PersistentState {
	return normalizePersistentState(structuredClone(state));
}

export function loadPersistentState(path: string): PersistentState {
	if (!existsSync(path)) return createEmptyPersistentState();
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 1) {
		throw new Error(
			`legacy persistent state at ${path} lacks T3.2-B WorkerStatus/ModelIdentity; explicit migration is required`,
		);
	}
	if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 2) {
		throw new Error(`unsupported persistent state at ${path}`);
	}
	return normalizePersistentState(parsed as Partial<PersistentState>);
}
