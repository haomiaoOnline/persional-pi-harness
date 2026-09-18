import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateResultContract } from "./result.ts";
import { validateRoleProfile } from "./roles.ts";
import { validateTaskContract } from "./schema.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import type {
	AcceptanceRecord,
	ControlPlaneReconstruction,
	DecisionRecord,
	DispatchRecord,
	EvidenceRecord,
	ExecutionTrace,
	LoopUsage,
	PersistentState,
	ProjectRecord,
	RecoveryDecision,
	RegressionCase,
	ResultContract,
	RoleProfile,
	RunRecord,
	StateSnapshot,
	TaskContract,
	TaskGraph,
	TaskLedgerBinding,
	TaskRecord,
	VerificationRecord,
	WorkerInstanceRecord,
	WorkspaceSnapshot,
} from "./types.ts";
import { AcceptanceGate } from "./verification.ts";

function emptyState(): PersistentState {
	return {
		version: 1,
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

function normalizeState(state: Partial<PersistentState>): PersistentState {
	const base = emptyState();
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

function assertDoneAcceptanceInvariant(previous: PersistentState, candidate: PersistentState): void {
	for (const task of candidate.tasks) {
		const previousTask = previous.tasks.find((entry) => entry.id === task.id);
		if (task.state !== "DONE" || previousTask?.state === "DONE") continue;
		const acceptance = candidate.acceptances.find(
			(entry) => entry.task_id === task.id && entry.task_revision === task.task_revision,
		);
		if (!acceptance) throw new Error(`DONE task ${task.id} is missing a current-revision AcceptanceRecord`);
		const verification = candidate.verifications.find((entry) => entry.id === acceptance.verification_id);
		if (
			!verification ||
			verification.task_id !== task.id ||
			verification.task_revision !== task.task_revision ||
			verification.status !== "PASS"
		)
			throw new Error(`DONE task ${task.id} is not backed by current-revision Verification PASS`);
		const result = candidate.results.find((entry) => entry.run_id === acceptance.run_id);
		if (!result || result.task_id !== task.id || result.status !== "success")
			throw new Error(`DONE task ${task.id} is not backed by a successful persisted Result`);
	}
}

function cloneState(state: PersistentState): PersistentState {
	return normalizeState(structuredClone(state));
}

function stateDigest(state: PersistentState): string {
	const snapshotSafe = { ...state, snapshots: [], snapshot_payloads: {} };
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
		assertDoneAcceptanceInvariant(this.state, candidate);
		if (this.filePath) writeAtomically(this.filePath, candidate);
		this.state = candidate;
		return this.read();
	}

	probeWriteCapability(): void {
		this.transact(() => {});
	}

	upsertWorkerInstance(instance: WorkerInstanceRecord): void {
		this.transact((state) => {
			state.worker_instances[instance.worker_instance_id] = structuredClone(instance);
		});
	}

	getWorkerInstance(workerInstanceId: string): WorkerInstanceRecord | undefined {
		const instance = this.state.worker_instances[workerInstanceId];
		return instance ? structuredClone(instance) : undefined;
	}

	listWorkerInstances(): WorkerInstanceRecord[] {
		return Object.values(this.state.worker_instances).map((instance) => structuredClone(instance));
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
		if (task.state === "DONE")
			throw new Error("DONE must be persisted through acceptTask() after independent Verification PASS");
		const { state: _state, audit_log: _auditLog, ...contract } = task;
		const validation = validateTaskContract(contract);
		if (!validation.valid) throw new Error(`cannot persist invalid task: ${validation.errors.join("; ")}`);
		this.transact((state) => {
			state.tasks[index] = structuredClone(task);
		});
		return structuredClone(task);
	}

	acceptTask(
		taskId: string,
		verificationId: string,
		resultRunId: string,
		currentSnapshot: WorkspaceSnapshot,
		acceptedAt = new Date().toISOString(),
		acceptanceGate = new AcceptanceGate(),
	): { task: TaskRecord; acceptance: AcceptanceRecord } {
		const taskIndex = this.state.tasks.findIndex((candidate) => candidate.id === taskId);
		if (taskIndex === -1) throw new Error(`unknown task: ${taskId}`);
		const task = structuredClone(this.state.tasks[taskIndex]);
		const verification = this.state.verifications.find((candidate) => candidate.id === verificationId);
		if (!verification) throw new Error(`unknown verification: ${verificationId}`);
		if (verification.task_id !== taskId)
			throw new Error(`verification ${verificationId} does not belong to task ${taskId}`);
		const result = this.state.results.find((candidate) => candidate.run_id === resultRunId);
		if (!result) throw new Error(`unknown persisted result: ${resultRunId}`);
		if (result.task_id !== taskId) throw new Error(`result ${resultRunId} does not belong to task ${taskId}`);
		const accepted = acceptanceGate.markDone(task, verification, currentSnapshot, result);
		const acceptance: AcceptanceRecord = {
			id: randomUUID(),
			task_id: taskId,
			task_revision: task.task_revision,
			verification_id: verificationId,
			run_id: resultRunId,
			accepted_at: acceptedAt,
		};
		this.transact((state) => {
			const current = state.tasks[taskIndex];
			if (
				!current ||
				current.id !== taskId ||
				current.task_revision !== task.task_revision ||
				current.state !== task.state
			)
				throw new Error(`task changed during acceptance: ${taskId}`);
			if (state.acceptances.some((entry) => entry.task_id === taskId && entry.task_revision === task.task_revision))
				throw new Error(`task revision already accepted: ${taskId}@${task.task_revision}`);
			state.acceptances.push(structuredClone(acceptance));
			state.tasks[taskIndex] = structuredClone(accepted);
		});
		return { task: structuredClone(accepted), acceptance: structuredClone(acceptance) };
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

	markRunFailed(runId: string, reason: string, endedAt = new Date().toISOString()): void {
		this.transact((state) => {
			const run = state.runs.find((candidate) => candidate.id === runId);
			if (!run) throw new Error(`unknown Run: ${runId}`);
			if (["SUCCEEDED", "RUNNING", "PENDING"].includes(run.status)) run.status = "FAILED";
			run.ended_at = endedAt;
			run.failure_reason = reason;
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

	getLoopUsage(taskId: string): LoopUsage {
		const usage = this.state.loop_usage[taskId];
		return structuredClone(
			usage ?? {
				attempts: 0,
				model_calls: 0,
				tool_calls: 0,
				handoffs: 0,
				elapsed_ms: 0,
				input_tokens: 0,
				output_tokens: 0,
				cost_usd: 0,
				state_growth_bytes: 0,
			},
		);
	}

	recordLoopUsage(taskId: string, delta: Partial<LoopUsage>): LoopUsage {
		if (!this.state.tasks.some((task) => task.id === taskId)) throw new Error(`unknown task: ${taskId}`);
		this.transact((state) => {
			const current = state.loop_usage[taskId] ?? this.getLoopUsage(taskId);
			state.loop_usage[taskId] = {
				attempts: current.attempts + (delta.attempts ?? 0),
				model_calls: current.model_calls + (delta.model_calls ?? 0),
				tool_calls: current.tool_calls + (delta.tool_calls ?? 0),
				handoffs: current.handoffs + (delta.handoffs ?? 0),
				elapsed_ms: current.elapsed_ms + (delta.elapsed_ms ?? 0),
				input_tokens: current.input_tokens + (delta.input_tokens ?? 0),
				output_tokens: current.output_tokens + (delta.output_tokens ?? 0),
				cost_usd: current.cost_usd + (delta.cost_usd ?? 0),
				state_growth_bytes: current.state_growth_bytes + (delta.state_growth_bytes ?? 0),
			};
		});
		return this.getLoopUsage(taskId);
	}

	addRegression(regression: RegressionCase): void {
		this.transact((state) => state.regressions.push(structuredClone(regression)));
	}

	addProject(project: ProjectRecord): ProjectRecord {
		if (this.state.projects.some((candidate) => candidate.project_id === project.project_id))
			throw new Error(`project already exists: ${project.project_id}`);
		if (this.state.projects.some((candidate) => candidate.repo_path === project.repo_path))
			throw new Error(`repo_path already registered: ${project.repo_path}`);
		this.transact((state) => state.projects.push(structuredClone(project)));
		return structuredClone(project);
	}

	getProject(projectId: string): ProjectRecord | undefined {
		const project = this.state.projects.find((candidate) => candidate.project_id === projectId);
		return project ? structuredClone(project) : undefined;
	}

	listProjects(): ProjectRecord[] {
		return this.state.projects.map((project) => structuredClone(project));
	}

	addTaskLedgerBinding(binding: TaskLedgerBinding): TaskLedgerBinding {
		if (!this.state.projects.some((project) => project.project_id === binding.project_id))
			throw new Error(`unknown project: ${binding.project_id}`);
		if (!this.state.tasks.some((task) => task.id === binding.pph_task_id))
			throw new Error(`unknown task: ${binding.pph_task_id}`);
		if (
			this.state.task_ledger.some(
				(candidate) =>
					candidate.project_id === binding.project_id && candidate.project_task_id === binding.project_task_id,
			)
		)
			throw new Error(`project task already bound: ${binding.project_id}/${binding.project_task_id}`);
		if (this.state.task_ledger.some((candidate) => candidate.pph_task_id === binding.pph_task_id))
			throw new Error(`pph task already bound: ${binding.pph_task_id}`);
		this.transact((state) => state.task_ledger.push(structuredClone(binding)));
		return structuredClone(binding);
	}

	listTaskLedgerBindings(): TaskLedgerBinding[] {
		return this.state.task_ledger.map((binding) => structuredClone(binding));
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
		snapshotState.snapshot_payloads = {};
		const snapshot: StateSnapshot = {
			id: randomUUID(),
			created_at: createdAt,
			digest: stateDigest(snapshotState),
			state: snapshotState,
		};
		this.transact((state) => {
			state.snapshots.push({ id: snapshot.id, created_at: snapshot.created_at, digest: snapshot.digest });
			state.snapshot_payloads[snapshot.id] = {
				created_at: snapshot.created_at,
				digest: snapshot.digest,
				state: structuredClone(snapshot.state),
			};
		});
		return structuredClone(snapshot);
	}

	getSnapshot(snapshotId: string): StateSnapshot | undefined {
		const payload = this.state.snapshot_payloads[snapshotId];
		if (!payload) return undefined;
		return {
			id: snapshotId,
			created_at: payload.created_at,
			digest: payload.digest,
			state: structuredClone(payload.state),
		};
	}

	restoreSnapshotFromStore(snapshotId: string): PersistentState {
		const snapshot = this.getSnapshot(snapshotId);
		if (!snapshot) throw new Error(`unknown persisted snapshot: ${snapshotId}`);
		return this.restoreSnapshot(snapshot);
	}

	restoreSnapshot(snapshot: StateSnapshot): PersistentState {
		const candidate = cloneState(snapshot.state);
		candidate.snapshots = [];
		candidate.snapshot_payloads = {};
		if (stateDigest(candidate) !== snapshot.digest) throw new Error("snapshot digest mismatch");
		const knownSnapshots = this.state.snapshots.filter((entry) => entry.id !== snapshot.id);
		const knownPayloads = { ...this.state.snapshot_payloads };
		candidate.snapshots = [
			...knownSnapshots,
			{ id: snapshot.id, created_at: snapshot.created_at, digest: snapshot.digest },
		];
		knownPayloads[snapshot.id] = {
			created_at: snapshot.created_at,
			digest: snapshot.digest,
			state: structuredClone(snapshot.state),
		};
		candidate.snapshot_payloads = knownPayloads;
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
		const compare = (state: PersistentState) => ({ ...state, snapshots: [], snapshot_payloads: {} });
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
				delete state.leases[run.task_id];
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
			active_leases: Object.values(this.state.leases).map((lease) => structuredClone(lease)),
			lease_epochs: { ...this.state.lease_epochs },
			snapshot_ids: this.state.snapshots.map((snapshot) => snapshot.id),
		};
	}
}

export function digestPersistentState(state: PersistentState): string {
	return stateDigest(state);
}
