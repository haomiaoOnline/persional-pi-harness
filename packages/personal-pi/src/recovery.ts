import type { LeaseManager } from "./lease.ts";
import type { PersistentStateStore } from "./persistence.ts";
import { createDecisionRecord } from "./planning.ts";
import { validateResultContract } from "./result.ts";
import { TaskStateMachine } from "./state-machine.ts";
import type { DecisionRecord, Lease, LeaseDecision, RunRecord, TaskRecord, TaskStatus } from "./types.ts";

export type RecoveryFault = "timeout" | "crash" | "malformed_output" | "wrong_result";
export type RecoveryAction = "RETRY" | "RESUME" | "REASSIGN" | "BLOCK";

export interface RecoveryInput {
	task_id: string;
	run_id?: string;
	fault: RecoveryFault;
	worker_id?: string;
	candidate_worker_id?: string;
	changed_files?: string[];
	resume_safe?: boolean;
	reason?: string;
	at?: string;
}

export interface RecoveryPlan {
	task_id: string;
	previous_run_id: string;
	action: RecoveryAction;
	next_worker_id?: string;
	next_attempt?: number;
	task: TaskRecord;
	decision: DecisionRecord;
}

export interface RecoveryStartedRun {
	task: TaskRecord;
	run: RunRecord;
	lease: Lease;
}

export interface ResultAdmission {
	accepted: boolean;
	reason: LeaseDecision["reason"] | "malformed_result" | "wrong_result";
	decision: DecisionRecord;
	recovery?: RecoveryPlan;
}

export class RecoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryError";
	}
}

function terminalRunStatus(fault: RecoveryFault): RunRecord["status"] {
	if (fault === "timeout") return "TIMEOUT";
	if (fault === "crash") return "CRASHED";
	return "FAILED";
}

function failureReason(input: RecoveryInput): string {
	return input.reason ?? `fault injected: ${input.fault}`;
}

function isOpenTask(state: TaskStatus): boolean {
	return state === "RUNNING" || state === "FAILED" || state === "READY";
}

export class RecoveryManager {
	private readonly stateStore: PersistentStateStore;
	private readonly leaseManager: LeaseManager;

	constructor(stateStore: PersistentStateStore, leaseManager: LeaseManager) {
		this.stateStore = stateStore;
		this.leaseManager = leaseManager;
	}

	findTimedOut(at = new Date()): RecoveryPlan[] {
		const plans: RecoveryPlan[] = [];
		for (const task of this.stateStore.listTasks()) {
			const run = this.latestRun(task.id);
			if (!run || run.status !== "RUNNING") continue;
			if (Date.parse(run.started_at) + task.timeout <= at.getTime()) {
				plans.push(this.recover({ task_id: task.id, run_id: run.id, fault: "timeout", at: at.toISOString() }));
			}
		}
		return plans;
	}

	recover(input: RecoveryInput): RecoveryPlan {
		const task = this.stateStore.getTask(input.task_id);
		if (!task) throw new RecoveryError(`unknown task: ${input.task_id}`);
		const run = this.resolveRun(task.id, input.run_id);
		const at = input.at ?? new Date().toISOString();
		this.stateStore.transact((state) => {
			const persistedRun = state.runs.find((candidate) => candidate.id === run.id);
			if (!persistedRun) throw new RecoveryError(`run disappeared during recovery: ${run.id}`);
			persistedRun.status = terminalRunStatus(input.fault);
			persistedRun.ended_at = at;
			persistedRun.failure_reason = failureReason(input);
		});

		const failedRuns = this.stateStore
			.getRuns(task.id)
			.filter((candidate) => ["FAILED", "TIMEOUT", "CRASHED"].includes(candidate.status));
		const reason = failureReason(input);
		let nextTask = this.stateStore.getTask(task.id) as TaskRecord;
		let action: RecoveryAction;
		let nextWorkerId: string | undefined;
		const recoveryLimit = Math.min(task.retry_policy.max_attempts, 2);
		if (failedRuns.length >= recoveryLimit) {
			action = "BLOCK";
			if (isOpenTask(nextTask.state)) {
				if (nextTask.state === "RUNNING")
					nextTask = new TaskStateMachine().transition(nextTask, "BLOCKED", reason, at);
				else if (nextTask.state === "FAILED" || nextTask.state === "READY") {
					nextTask = new TaskStateMachine().transition(nextTask, "BLOCKED", reason, at);
				}
			}
		} else {
			nextWorkerId = input.candidate_worker_id ?? input.worker_id ?? run.worker_id;
			if (input.fault === "crash" && nextWorkerId !== run.worker_id) action = "REASSIGN";
			else if (input.resume_safe && (input.changed_files?.length ?? 0) > 0) action = "RESUME";
			else action = "RETRY";
			if (nextTask.state === "RUNNING") {
				nextTask = new TaskStateMachine().transition(nextTask, "FAILED", reason, at);
				nextTask = new TaskStateMachine().transition(nextTask, "READY", `recovery ${action.toLowerCase()}`, at);
			} else if (nextTask.state === "FAILED") {
				nextTask = new TaskStateMachine().transition(nextTask, "READY", `recovery ${action.toLowerCase()}`, at);
			}
		}
		// 回收决定一旦落地就立即推进 epoch，关闭旧 Worker 迟到写入的窗口；
		// startRetry 随后会再领取一个新的正式执行 Lease。
		this.leaseManager.acquire(task.id, nextWorkerId ?? run.worker_id, at);
		this.stateStore.updateTask(nextTask);
		const decision = createDecisionRecord(
			"recovery",
			action,
			`${reason}; failed_attempts=${failedRuns.length}`,
			[task.id, run.id],
			at,
		);
		this.stateStore.addDecision(decision);
		return {
			task_id: task.id,
			previous_run_id: run.id,
			action,
			next_worker_id: nextWorkerId,
			next_attempt: action === "BLOCK" ? undefined : failedRuns.length + 1,
			task: nextTask,
			decision,
		};
	}

	startRetry(taskId: string, workerId: string, at = new Date().toISOString()): RecoveryStartedRun {
		const task = this.stateStore.getTask(taskId);
		if (!task) throw new RecoveryError(`unknown task: ${taskId}`);
		if (task.state !== "READY") throw new RecoveryError(`task is not READY for recovery: ${task.state}`);
		const lease = this.leaseManager.acquire(task.id, workerId, at);
		const running = new TaskStateMachine().transition(task, "RUNNING", "recovery retry started", at);
		const updated = this.stateStore.updateTask(running);
		const run = this.stateStore.createRun(task.id, workerId, lease.lease_epoch, at);
		return { task: updated, run, lease };
	}

	admitResult(lease: Lease, result: unknown, at = new Date().toISOString()): ResultAdmission {
		const leaseDecision = this.leaseManager.acceptResult(lease);
		if (!leaseDecision.accepted) {
			const decision = createDecisionRecord(
				"recovery_result_admission",
				"REJECT",
				`fencing rejected ${leaseDecision.reason}`,
				[lease.task_id, String(lease.lease_epoch)],
				at,
			);
			this.stateStore.addDecision(decision);
			return { accepted: false, reason: leaseDecision.reason, decision };
		}
		const validation = validateResultContract(result);
		if (!validation.valid || !validation.value) {
			const recovery = this.recover({
				task_id: lease.task_id,
				fault: "malformed_output",
				worker_id: lease.worker_id,
				at,
			});
			return { accepted: false, reason: "malformed_result", decision: recovery.decision, recovery };
		}
		const admitted = validation.value;
		if (admitted.task_id !== lease.task_id || admitted.lease_epoch !== lease.lease_epoch) {
			const recovery = this.recover({
				task_id: lease.task_id,
				fault: "wrong_result",
				worker_id: lease.worker_id,
				at,
			});
			return { accepted: false, reason: "wrong_result", decision: recovery.decision, recovery };
		}
		const decision = createDecisionRecord(
			"recovery_result_admission",
			"ACCEPT",
			"current lease and result identity match",
			[lease.task_id, String(lease.lease_epoch)],
			at,
		);
		this.stateStore.addDecision(decision);
		return { accepted: true, reason: "current", decision };
	}

	private latestRun(taskId: string): RunRecord | undefined {
		return this.stateStore.getRuns(taskId).at(-1);
	}

	private resolveRun(taskId: string, runId?: string): RunRecord {
		const run = runId
			? this.stateStore.getRuns(taskId).find((candidate) => candidate.id === runId)
			: this.latestRun(taskId);
		if (!run) throw new RecoveryError(`no Run available for task: ${taskId}`);
		if (!["RUNNING", "FAILED", "TIMEOUT", "CRASHED"].includes(run.status))
			throw new RecoveryError(`Run is not recoverable: ${run.status}`);
		return run;
	}
}
