import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateMasterHandoffReceipt } from "./handoff.ts";
import { validateModelIdentity, validateResultContract, validateWorkerStatus } from "./result.ts";
import { validateRoleProfile } from "./roles.ts";
import { validateTaskContract } from "./schema.ts";
import { clonePersistentState, createEmptyPersistentState, loadPersistentState } from "./state-file.ts";
import { createTaskRecord, TaskStateMachine } from "./state-machine.ts";
import type {
	AcceptanceRecord,
	ControlPlaneReconstruction,
	DecisionRecord,
	DispatchRecord,
	EvidenceRecord,
	ExecutionTrace,
	LoopUsage,
	MasterHandoffBinding,
	MasterHandoffReceipt,
	ModelIdentity,
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
	WorkerStatus,
	WorkspaceSnapshot,
} from "./types.ts";
import { AcceptanceGate } from "./verification.ts";

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

function assertWorkerRuntimeInvariant(state: PersistentState): void {
	for (const dispatch of state.dispatches) {
		const status = validateWorkerStatus(dispatch.worker_status);
		if (!status.valid)
			throw new Error(`Dispatch ${dispatch.id} has invalid WorkerStatus: ${status.errors.join("; ")}`);
		if (!dispatch.requested_model.trim()) throw new Error(`Dispatch ${dispatch.id} has empty requested_model`);
		if (dispatch.worker_status.worker_capability === "unavailable" && dispatch.lease_epoch !== undefined)
			throw new Error(`unavailable Worker Dispatch ${dispatch.id} must not have a lease_epoch`);
		if (dispatch.worker_status.worker_capability === "available" && dispatch.lease_epoch === undefined)
			throw new Error(`available Worker Dispatch ${dispatch.id} requires a lease_epoch`);
	}
	for (const run of state.runs) {
		const status = validateWorkerStatus(run.worker_status);
		if (!status.valid) throw new Error(`Run ${run.id} has invalid WorkerStatus: ${status.errors.join("; ")}`);
		if (run.worker_status.worker_capability !== "available")
			throw new Error(`Run ${run.id} cannot exist when worker_capability=unavailable`);
		const identity = validateModelIdentity(run.model_identity);
		if (!identity.valid) throw new Error(`Run ${run.id} has invalid ModelIdentity: ${identity.errors.join("; ")}`);
	}
	for (const result of state.results) {
		const validation = validateResultContract(result);
		if (!validation.valid) throw new Error(`Result ${result.run_id} is invalid: ${validation.errors.join("; ")}`);
		const run = state.runs.find((candidate) => candidate.id === result.run_id);
		if (!run) throw new Error(`Result ${result.run_id} has no persisted Run`);
		if (
			run.task_id !== result.task_id ||
			run.worker_id !== result.worker_id ||
			run.lease_epoch !== result.lease_epoch ||
			run.model_identity.requested_model !== result.model_identity.requested_model
		)
			throw new Error(`Result ${result.run_id} identity does not match its persisted Run`);
	}
	for (const receipt of state.handoff_receipts) {
		const validation = validateMasterHandoffReceipt(receipt);
		if (!validation.valid)
			throw new Error(`Master handoff ${receipt.task_id} is invalid: ${validation.errors.join("; ")}`);
		const task = state.tasks.find((candidate) => candidate.id === receipt.task_id);
		if (!task) throw new Error(`Master handoff ${receipt.task_id} has no persisted Task`);
		if (task.state !== receipt.status)
			throw new Error(`Master handoff ${receipt.task_id} is stale for task state ${task.state}`);
		const binding = state.handoff_bindings[receipt.task_id];
		if (!binding) throw new Error(`Master handoff ${receipt.task_id} is missing controller provenance`);
		if (binding.task_id !== receipt.task_id || binding.task_revision !== task.task_revision)
			throw new Error(`Master handoff ${receipt.task_id} provenance is stale for task revision`);
		const latestRun = state.runs.filter((candidate) => candidate.task_id === receipt.task_id).at(-1);
		if (!latestRun || latestRun.id !== binding.run_id)
			throw new Error(`Master handoff ${receipt.task_id} is not bound to the latest Run`);
		if (latestRun.task_revision !== task.task_revision)
			throw new Error(`Master handoff ${receipt.task_id} Run belongs to a different task revision`);
		const result = state.results.find((candidate) => candidate.run_id === binding.run_id);
		if (!result?.work_receipt)
			throw new Error(`Master handoff ${receipt.task_id} has no canonical terminal Work Receipt`);
		const workReceiptDigest = createHash("sha256").update(JSON.stringify(result.work_receipt)).digest("hex");
		if (
			binding.git_sha !== receipt.git_sha ||
			binding.work_receipt_digest !== workReceiptDigest ||
			JSON.stringify(receipt.work_receipt) !== JSON.stringify(result.work_receipt)
		)
			throw new Error(`Master handoff ${receipt.task_id} provenance does not match the terminal Result`);
		const canonicalEvidenceRefs = state.evidence
			.filter((candidate) => candidate.task_id === receipt.task_id && candidate.run_id === binding.run_id)
			.map((candidate) => candidate.id)
			.sort();
		const receiptEvidenceRefs = [...receipt.evidence_refs].sort();
		if (
			JSON.stringify(canonicalEvidenceRefs) !== JSON.stringify(receiptEvidenceRefs) ||
			JSON.stringify([...binding.evidence_refs].sort()) !== JSON.stringify(receiptEvidenceRefs)
		)
			throw new Error(`Master handoff ${receipt.task_id} Evidence refs do not match the terminal Run`);
		if (binding.provenance_stage === "verified") {
			if (!binding.verification_id || receipt.evidence_refs.length === 0)
				throw new Error(`verified Master handoff ${receipt.task_id} requires Evidence and Verification provenance`);
			const verification = state.verifications.find((candidate) => candidate.id === binding.verification_id);
			if (
				!verification ||
				verification.task_id !== receipt.task_id ||
				verification.task_revision !== task.task_revision ||
				verification.commit_hash !== receipt.git_sha
			)
				throw new Error(`Master handoff ${receipt.task_id} verification provenance is invalid`);
		} else {
			if (binding.verification_id || receipt.evidence_refs.length > 0)
				throw new Error(
					`pre-verification Master handoff ${receipt.task_id} cannot carry Verification/Evidence provenance`,
				);
			if (latestRun.workspace_commit_hash !== receipt.git_sha)
				throw new Error(`Master handoff ${receipt.task_id} git_sha does not match the terminal Run snapshot`);
		}
		for (const evidenceRef of receipt.evidence_refs) {
			const evidence = state.evidence.find((candidate) => candidate.id === evidenceRef);
			if (!evidence || evidence.task_id !== receipt.task_id)
				throw new Error(`Master handoff ${receipt.task_id} has non-canonical Evidence ref ${evidenceRef}`);
		}
		if (receipt.acceptance === "PASS") {
			const acceptance = binding.acceptance_id
				? state.acceptances.find((candidate) => candidate.id === binding.acceptance_id)
				: undefined;
			if (
				!acceptance ||
				acceptance.task_id !== receipt.task_id ||
				acceptance.task_revision !== task.task_revision ||
				acceptance.run_id !== binding.run_id ||
				acceptance.verification_id !== binding.verification_id
			)
				throw new Error(`Master handoff ${receipt.task_id} claims PASS without canonical Acceptance`);
		} else if (binding.acceptance_id) {
			throw new Error(`non-PASS Master handoff ${receipt.task_id} must not bind Acceptance`);
		}
	}
	for (const taskId of Object.keys(state.handoff_bindings))
		if (!state.handoff_receipts.some((receipt) => receipt.task_id === taskId))
			throw new Error(`orphan Master handoff provenance: ${taskId}`);
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

export type PersistentStateMutation = (state: PersistentState) => void;

export class PersistentStateStore {
	private state: PersistentState;
	private readonly filePath?: string;

	constructor(options?: string | { filePath?: string; initialState?: PersistentState }) {
		if (typeof options === "string") {
			this.filePath = options;
			this.state = loadPersistentState(options);
		} else {
			this.filePath = options?.filePath;
			this.state = clonePersistentState(options?.initialState ?? createEmptyPersistentState());
			if (this.filePath && existsSync(this.filePath)) this.state = loadPersistentState(this.filePath);
		}
		assertWorkerRuntimeInvariant(this.state);
	}

	read(): PersistentState {
		return clonePersistentState(this.state);
	}

	artifactStoreRootPath(): string | undefined {
		return this.filePath ? `${this.filePath}.artifacts` : undefined;
	}

	transact(mutation: PersistentStateMutation): PersistentState {
		const candidate = clonePersistentState(this.state);
		mutation(candidate);
		assertWorkerRuntimeInvariant(candidate);
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

	createTaskWithLedgerBinding(contract: TaskContract, binding: TaskLedgerBinding): TaskRecord {
		const validation = validateTaskContract(contract);
		if (!validation.valid) throw new Error(`cannot persist invalid task: ${validation.errors.join("; ")}`);
		if (!binding.project_id.trim()) throw new Error("ledger binding project_id must not be empty");
		if (!binding.project_task_id.trim()) throw new Error("ledger binding project_task_id must not be empty");
		if (!binding.pph_task_id.trim()) throw new Error("ledger binding pph_task_id must not be empty");
		if (!binding.phase.trim()) throw new Error("ledger binding phase must not be empty");
		if (binding.unknowns.some((unknown) => !unknown.trim()))
			throw new Error("ledger binding unknowns must not contain empty values");
		if (binding.pph_task_id !== contract.id)
			throw new Error("ledger binding pph_task_id must match Task Contract id");
		if (!this.state.projects.some((project) => project.project_id === binding.project_id))
			throw new Error(`unknown project: ${binding.project_id}`);
		if (this.state.tasks.some((task) => task.id === contract.id))
			throw new Error(`task already exists: ${contract.id}`);
		if (
			this.state.task_ledger.some(
				(candidate) =>
					candidate.project_id === binding.project_id && candidate.project_task_id === binding.project_task_id,
			)
		)
			throw new Error(`project task already bound: ${binding.project_id}/${binding.project_task_id}`);
		if (this.state.task_ledger.some((candidate) => candidate.pph_task_id === binding.pph_task_id))
			throw new Error(`pph task already bound: ${binding.pph_task_id}`);
		const task = createTaskRecord(contract);
		this.transact((state) => {
			state.tasks.push(structuredClone(task));
			state.task_ledger.push(structuredClone(binding));
		});
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
			const previous = state.tasks[index];
			const binding = state.handoff_bindings[task.id];
			if (binding && previous && (previous.state !== task.state || previous.task_revision !== task.task_revision)) {
				state.handoff_receipts = state.handoff_receipts.filter((receipt) => receipt.task_id !== task.id);
				delete state.handoff_bindings[task.id];
			}
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

	createRun(
		taskId: string,
		workerId: string,
		leaseEpoch: number,
		metadata: {
			worker_status: WorkerStatus;
			model_identity: ModelIdentity;
			started_at?: string;
			workspace_commit_hash?: string;
		},
	): RunRecord {
		if (!this.state.tasks.some((task) => task.id === taskId)) throw new Error(`unknown task: ${taskId}`);
		const workerStatusValidation = validateWorkerStatus(metadata.worker_status);
		if (!workerStatusValidation.valid)
			throw new Error(`cannot persist Run with invalid WorkerStatus: ${workerStatusValidation.errors.join("; ")}`);
		if (metadata.worker_status.worker_capability !== "available")
			throw new Error("cannot create Run when worker_capability=unavailable");
		const modelIdentityValidation = validateModelIdentity(metadata.model_identity);
		if (!modelIdentityValidation.valid)
			throw new Error(`cannot persist Run with invalid ModelIdentity: ${modelIdentityValidation.errors.join("; ")}`);
		const attempts = this.state.runs.filter((run) => run.task_id === taskId).map((run) => run.attempt);
		const run: RunRecord = {
			id: randomUUID(),
			task_id: taskId,
			task_revision: this.state.tasks.find((task) => task.id === taskId)?.task_revision,
			attempt: attempts.length > 0 ? Math.max(...attempts) + 1 : 1,
			worker_id: workerId,
			lease_epoch: leaseEpoch,
			worker_status: structuredClone(metadata.worker_status),
			model_identity: structuredClone(metadata.model_identity),
			status: "RUNNING",
			started_at: metadata.started_at ?? new Date().toISOString(),
			workspace_commit_hash: metadata.workspace_commit_hash,
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
			const run = state.runs.find((candidate) => candidate.id === result.run_id);
			if (!run) throw new Error(`unknown Run for Result: ${result.run_id}`);
			if (
				run.task_id !== result.task_id ||
				run.worker_id !== result.worker_id ||
				run.lease_epoch !== result.lease_epoch
			)
				throw new Error(`Result identity does not match persisted Run: ${result.run_id}`);
			if (run.model_identity.requested_model !== result.model_identity.requested_model)
				throw new Error(`Result requested_model does not match persisted Run: ${result.run_id}`);
			const existing = state.results.findIndex((candidate) => candidate.run_id === result.run_id);
			if (existing >= 0) state.results[existing] = structuredClone(result);
			else state.results.push(structuredClone(result));
			run.model_identity = structuredClone(result.model_identity);
			run.status = result.status === "success" ? "SUCCEEDED" : result.status === "timeout" ? "TIMEOUT" : "FAILED";
			run.ended_at = endedAt;
			run.result_id = result.run_id;
			run.failure_reason = result.errors.length > 0 ? result.errors.join("; ") : undefined;
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

	saveHandoffReceipt(
		receipt: MasterHandoffReceipt,
		provenance: Pick<MasterHandoffBinding, "task_revision" | "run_id" | "verification_id" | "acceptance_id">,
	): MasterHandoffReceipt {
		const validation = validateMasterHandoffReceipt(receipt);
		if (!validation.valid) throw new Error(`cannot persist invalid Master handoff: ${validation.errors.join("; ")}`);
		this.transact((state) => {
			const task = state.tasks.find((candidate) => candidate.id === receipt.task_id);
			if (!task) throw new Error(`unknown task for Master handoff: ${receipt.task_id}`);
			if (task.state !== receipt.status)
				throw new Error(`Master handoff status does not match task ${receipt.task_id}`);
			if (task.task_revision !== provenance.task_revision)
				throw new Error(`Master handoff task revision is stale: ${receipt.task_id}`);
			const latestRun = state.runs.filter((candidate) => candidate.task_id === receipt.task_id).at(-1);
			if (!latestRun || latestRun.id !== provenance.run_id)
				throw new Error(`Master handoff must bind the latest Run: ${receipt.task_id}`);
			if (latestRun.task_revision !== task.task_revision)
				throw new Error(`Master handoff Run task revision mismatch: ${receipt.task_id}`);
			const result = state.results.find((candidate) => candidate.run_id === provenance.run_id);
			if (!result?.work_receipt)
				throw new Error(`Master handoff requires the persisted terminal Work Receipt: ${receipt.task_id}`);
			if (JSON.stringify(receipt.work_receipt) !== JSON.stringify(result.work_receipt))
				throw new Error(`Master handoff Work Receipt does not match terminal Result: ${receipt.task_id}`);
			const canonicalEvidenceRefs = state.evidence
				.filter((candidate) => candidate.task_id === receipt.task_id && candidate.run_id === provenance.run_id)
				.map((candidate) => candidate.id)
				.sort();
			if (JSON.stringify(canonicalEvidenceRefs) !== JSON.stringify([...receipt.evidence_refs].sort()))
				throw new Error(`Master handoff Evidence refs do not match terminal Run: ${receipt.task_id}`);
			const provenanceStage = provenance.verification_id ? "verified" : "pre_verification";
			if (provenanceStage === "verified") {
				if (receipt.evidence_refs.length === 0)
					throw new Error(`verified Master handoff requires canonical Evidence: ${receipt.task_id}`);
				const verification = state.verifications.find((candidate) => candidate.id === provenance.verification_id);
				if (
					!verification ||
					verification.task_id !== receipt.task_id ||
					verification.task_revision !== task.task_revision ||
					verification.commit_hash !== receipt.git_sha
				)
					throw new Error(`Master handoff verification provenance mismatch: ${receipt.task_id}`);
			} else {
				if (receipt.evidence_refs.length > 0)
					throw new Error(`pre-verification Master handoff cannot reference Evidence: ${receipt.task_id}`);
				if (latestRun.workspace_commit_hash !== receipt.git_sha)
					throw new Error(`Master handoff git_sha does not match terminal Run snapshot: ${receipt.task_id}`);
			}
			if (receipt.acceptance === "PASS") {
				const acceptance = provenance.acceptance_id
					? state.acceptances.find((candidate) => candidate.id === provenance.acceptance_id)
					: undefined;
				if (
					!acceptance ||
					acceptance.task_id !== receipt.task_id ||
					acceptance.task_revision !== task.task_revision ||
					acceptance.run_id !== provenance.run_id ||
					acceptance.verification_id !== provenance.verification_id
				)
					throw new Error(`Master handoff PASS requires canonical Acceptance: ${receipt.task_id}`);
			} else if (provenance.acceptance_id) {
				throw new Error(`non-PASS Master handoff cannot bind Acceptance: ${receipt.task_id}`);
			}
			const binding: MasterHandoffBinding = {
				task_id: receipt.task_id,
				task_revision: task.task_revision,
				run_id: provenance.run_id,
				provenance_stage: provenanceStage,
				git_sha: receipt.git_sha,
				work_receipt_digest: createHash("sha256").update(JSON.stringify(result.work_receipt)).digest("hex"),
				evidence_refs: [...receipt.evidence_refs],
				verification_id: provenance.verification_id,
				acceptance_id: provenance.acceptance_id,
			};
			const index = state.handoff_receipts.findIndex((candidate) => candidate.task_id === receipt.task_id);
			if (index >= 0) state.handoff_receipts[index] = structuredClone(receipt);
			else state.handoff_receipts.push(structuredClone(receipt));
			state.handoff_bindings[receipt.task_id] = binding;
		});
		return structuredClone(receipt);
	}

	getHandoffReceipt(taskId: string): MasterHandoffReceipt | undefined {
		const receipt = this.state.handoff_receipts.find((candidate) => candidate.task_id === taskId);
		const task = this.state.tasks.find((candidate) => candidate.id === taskId);
		const binding = this.state.handoff_bindings[taskId];
		const latestRun = this.state.runs.filter((candidate) => candidate.task_id === taskId).at(-1);
		return receipt &&
			task?.state === receipt.status &&
			binding?.task_revision === task.task_revision &&
			binding.run_id === latestRun?.id
			? structuredClone(receipt)
			: undefined;
	}

	listHandoffReceipts(): MasterHandoffReceipt[] {
		return this.state.handoff_receipts.map((receipt) => structuredClone(receipt));
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
		const workerStatusValidation = validateWorkerStatus(dispatch.worker_status);
		if (!workerStatusValidation.valid)
			throw new Error(
				`cannot persist Dispatch with invalid WorkerStatus: ${workerStatusValidation.errors.join("; ")}`,
			);
		if (!dispatch.requested_model.trim()) throw new Error("Dispatch requested_model must not be empty");
		if (dispatch.worker_status.worker_capability === "unavailable" && dispatch.lease_epoch !== undefined)
			throw new Error("unavailable Worker Dispatch must not have a lease_epoch");
		if (dispatch.worker_status.worker_capability === "available" && dispatch.lease_epoch === undefined)
			throw new Error("available Worker Dispatch requires a lease_epoch");
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
		const candidate = clonePersistentState(snapshot.state);
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
		assertWorkerRuntimeInvariant(candidate);
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
