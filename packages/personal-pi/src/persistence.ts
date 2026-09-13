import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateResultContract } from "./result.ts";
import { validateRoleProfile } from "./roles.ts";
import { validateTaskContract } from "./schema.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import type {
	ControlPlaneReconstruction,
	DecisionRecord,
	DispatchRecord,
	EvidenceRecord,
	ExecutionTrace,
	PersistentState,
	RecoveryDecision,
	RegressionCase,
	ResultContract,
	RoleProfile,
	RunRecord,
	StateSnapshot,
	TaskContract,
	TaskGraph,
	TaskRecord,
	VerificationRecord,
} from "./types.ts";

function emptyState(): PersistentState {
	return {
		version: 1,
		projects: [],
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
		traces: [],
		regressions: [],
		snapshots: [],
	};
}

function normalizeState(state: Partial<PersistentState>): PersistentState {
	const base = emptyState();
	return {
		...base,
		...state,
		traces: state.traces ?? [],
		regressions: state.regressions ?? [],
	};
}

function cloneState(state: PersistentState): PersistentState {
	return normalizeState(structuredClone(state));
}

function stateDigest(state: PersistentState): string {
	const snapshotSafe = { ...state, snapshots: [] };
	return createHash("sha256").update(JSON.stringify(snapshotSafe)).digest("hex");
}

function writeAtomically(path: string, state: PersistentState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

function loadState(path: string): PersistentState {
	if (!existsSync(path)) return emptyState();
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
		throw new Error(`unsupported persistent state at ${path}`);
	}
	return normalizeState(parsed as Partial<PersistentState>);
}

export type PersistentStateMutation = (state: PersistentState) => void;

export class PersistentStateStore {
	private state: PersistentState;
	private readonly filePath?: string;

	constructor(options?: string | { filePath?: string; initialState?: PersistentState }) {
		if (typeof options === "string") {
			this.filePath = options;
			this.state = loadState(options);
		} else {
			this.filePath = options?.filePath;
			this.state = cloneState(options?.initialState ?? emptyState());
			if (this.filePath && existsSync(this.filePath)) this.state = loadState(this.filePath);
		}
	}

	read(): PersistentState {
		return cloneState(this.state);
	}

	transact(mutation: PersistentStateMutation): PersistentState {
		const candidate = cloneState(this.state);
		mutation(candidate);
		if (this.filePath) writeAtomically(this.filePath, candidate);
		this.state = candidate;
		return this.read();
	}

	createTask(contract: TaskContract): TaskRecord {
		const validation = validateTaskContract(contract);
		if (!validation.valid) throw new Error(`cannot persist invalid task: ${validation.errors.join("; ")}`);
		if (this.state.tasks.some((task) => task.id === contract.id))
			throw new Error(`task already exists: ${contract.id}`);
		const task = createTaskRecord(contract);
		this.transact((state) => state.tasks.push(task));
		return structuredClone(task);
	}

	getTask(taskId: string): TaskRecord | undefined {
		const task = this.state.tasks.find((candidate) => candidate.id === taskId);
		return task ? structuredClone(task) : undefined;
	}

	listTasks(): TaskRecord[] {
		return this.state.tasks.map((task) => structuredClone(task));
	}

	updateTask(task: TaskRecord): TaskRecord {
		const index = this.state.tasks.findIndex((candidate) => candidate.id === task.id);
		if (index === -1) throw new Error(`unknown task: ${task.id}`);
		const { state: _state, audit_log: _auditLog, ...contract } = task;
		const validation = validateTaskContract(contract);
		if (!validation.valid) throw new Error(`cannot persist invalid task: ${validation.errors.join("; ")}`);
		this.transact((state) => {
			state.tasks[index] = structuredClone(task);
		});
		return structuredClone(task);
	}

	createRun(taskId: string, workerId: string, leaseEpoch: number, startedAt = new Date().toISOString()): RunRecord {
		if (!this.state.tasks.some((task) => task.id === taskId)) throw new Error(`unknown task: ${taskId}`);
		const attempts = this.state.runs.filter((run) => run.task_id === taskId).map((run) => run.attempt);
		const run: RunRecord = {
			id: randomUUID(),
			task_id: taskId,
			attempt: attempts.length > 0 ? Math.max(...attempts) + 1 : 1,
			worker_id: workerId,
			lease_epoch: leaseEpoch,
			status: "RUNNING",
			started_at: startedAt,
		};
		this.transact((state) => state.runs.push(run));
		return structuredClone(run);
	}

	getRuns(taskId: string): RunRecord[] {
		return this.state.runs.filter((run) => run.task_id === taskId).map((run) => structuredClone(run));
	}

	saveResult(result: ResultContract, endedAt = new Date().toISOString()): void {
		const validation = validateResultContract(result);
		if (!validation.valid) throw new Error(`cannot persist invalid result: ${validation.errors.join("; ")}`);
		this.transact((state) => {
			const existing = state.results.findIndex((candidate) => candidate.run_id === result.run_id);
			if (existing >= 0) state.results[existing] = structuredClone(result);
			else state.results.push(structuredClone(result));
			const run = state.runs.find((candidate) => candidate.id === result.run_id);
			if (run) {
				run.status = result.status === "success" ? "SUCCEEDED" : result.status === "timeout" ? "TIMEOUT" : "FAILED";
				run.ended_at = endedAt;
				run.result_id = result.run_id;
				run.failure_reason = result.errors.length > 0 ? result.errors.join("; ") : undefined;
			}
		});
	}

	saveEvidence(evidence: EvidenceRecord): void {
		this.transact((state) => state.evidence.push(structuredClone(evidence)));
	}

	saveVerification(verification: VerificationRecord): void {
		this.transact((state) => state.verifications.push(structuredClone(verification)));
	}

	addDecision(decision: DecisionRecord): void {
		this.transact((state) => state.decisions.push(structuredClone(decision)));
	}

	addTrace(trace: ExecutionTrace): void {
		this.transact((state) => {
			const index = state.traces.findIndex((candidate) => candidate.trace_id === trace.trace_id);
			if (index >= 0) state.traces[index] = structuredClone(trace);
			else state.traces.push(structuredClone(trace));
		});
	}

	getTrace(traceId: string): ExecutionTrace | undefined {
		const trace = this.state.traces.find((candidate) => candidate.trace_id === traceId);
		return trace ? structuredClone(trace) : undefined;
	}

	addRegression(regression: RegressionCase): void {
		this.transact((state) => state.regressions.push(structuredClone(regression)));
	}

	addProject(project: { id: string; name: string; working_directory: string }): void {
		this.transact((state) => state.projects.push(structuredClone(project)));
	}

	saveGraph(graph: TaskGraph): void {
		this.transact((state) => {
			const index = state.graphs.findIndex((candidate) => candidate.revision === graph.revision);
			if (index >= 0) state.graphs[index] = structuredClone(graph);
			else state.graphs.push(structuredClone(graph));
		});
	}

	addDispatch(dispatch: DispatchRecord): void {
		this.transact((state) => state.dispatches.push(structuredClone(dispatch)));
	}

	addRoleProfile(role: RoleProfile): void {
		const validation = validateRoleProfile(role);
		if (!validation.valid) throw new Error(`cannot persist invalid role: ${validation.errors.join("; ")}`);
		this.transact((state) => state.role_profiles.push(structuredClone(role)));
	}

	createSnapshot(createdAt = new Date().toISOString()): StateSnapshot {
		const snapshotState = this.read();
		snapshotState.snapshots = [];
		const snapshot: StateSnapshot = {
			id: randomUUID(),
			created_at: createdAt,
			digest: stateDigest(snapshotState),
			state: snapshotState,
		};
		this.transact((state) =>
			state.snapshots.push({ id: snapshot.id, created_at: snapshot.created_at, digest: snapshot.digest }),
		);
		return structuredClone(snapshot);
	}

	restoreSnapshot(snapshot: StateSnapshot): PersistentState {
		const candidate = cloneState(snapshot.state);
		candidate.snapshots = [];
		if (stateDigest(candidate) !== snapshot.digest) throw new Error("snapshot digest mismatch");
		const knownSnapshots = this.state.snapshots.filter((entry) => entry.id !== snapshot.id);
		candidate.snapshots = [
			...knownSnapshots,
			{ id: snapshot.id, created_at: snapshot.created_at, digest: snapshot.digest },
		];
		if (this.filePath) writeAtomically(this.filePath, candidate);
		this.state = candidate;
		return this.read();
	}

	restoreDrill(mutate: PersistentStateMutation): {
		restored: boolean;
		before: PersistentState;
		after: PersistentState;
	} {
		const before = this.read();
		const snapshot = this.createSnapshot();
		this.transact(mutate);
		this.restoreSnapshot(snapshot);
		const after = this.read();
		const compare = (state: PersistentState) => ({ ...state, snapshots: [] });
		return { restored: JSON.stringify(compare(before)) === JSON.stringify(compare(after)), before, after };
	}

	recoverUnclosedRuns(workerExists: (workerId: string) => boolean, at = new Date().toISOString()): RecoveryDecision[] {
		const decisions: RecoveryDecision[] = [];
		this.transact((state) => {
			for (const run of state.runs.filter((candidate) => candidate.status === "RUNNING")) {
				if (workerExists(run.worker_id)) {
					decisions.push({
						run_id: run.id,
						task_id: run.task_id,
						action: "NOOP",
						reason: "worker is still present",
					});
					continue;
				}
				run.status = "CRASHED";
				run.ended_at = at;
				run.failure_reason = "worker missing after controller restart";
				const task = state.tasks.find((candidate) => candidate.id === run.task_id);
				if (task?.state === "RUNNING") {
					task.state = new TaskStateMachine().transition(
						task,
						"BLOCKED",
						"worker missing after controller restart",
						at,
					).state;
					task.audit_log.push({
						from: "RUNNING",
						to: "BLOCKED",
						at,
						reason: "worker missing after controller restart",
					});
				}
				decisions.push({
					run_id: run.id,
					task_id: run.task_id,
					action: "BLOCK",
					reason: "worker missing after controller restart",
				});
			}
		});
		return decisions;
	}

	reconstructControlPlane(): ControlPlaneReconstruction {
		return {
			next_ready_task_ids: this.state.tasks.filter((task) => task.state === "READY").map((task) => task.id),
			running_run_ids: this.state.runs.filter((run) => run.status === "RUNNING").map((run) => run.id),
			blocked_task_ids: this.state.tasks.filter((task) => task.state === "BLOCKED").map((task) => task.id),
			decision_ids: this.state.decisions.map((decision) => decision.id),
		};
	}
}

export function digestPersistentState(state: PersistentState): string {
	return stateDigest(state);
}
