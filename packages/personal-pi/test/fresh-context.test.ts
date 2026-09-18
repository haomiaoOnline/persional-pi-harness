import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ArtifactStore,
	captureWorkspaceSnapshot,
	MasterControlPlane,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	type TaskContract,
	TaskStateMachine,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, planFor, requirementFor, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];
const PRIVATE_MARKER = "TASK_A_PRIVATE_TRANSCRIPT_MARKER";

function task(id: string): TaskContract {
	return makeV3Task(id, {
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		execution: {
			...makeV3Task(id).execution,
			allowed_tools: [],
		},
	});
}

function noOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "verification-only leaf task",
		evidence_refs: ["worker_result"],
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T3.5 Fresh Context / receipt-only handoff", () => {
	test("persists Task A receipt and builds Task B input without Task A Worker text", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pph-fresh-context-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const store = new PersistentStateStore(statePath);
		const pipeline = new PersonalPiPipeline({ state_store: store });
		const taskA = task("task-a");
		const executionA = await pipeline.execute({
			...planFor(taskA),
			requirement: requirementFor(),
			task: taskA,
			worker: new PiWorker("worker-a", () => ({
				status: "success",
				summary: `${PRIVATE_MARKER}: private Worker prose must not cross Task boundary`,
				evidence: ["worker_result"],
				work_receipt: noOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("git-a", [], []),
		});

		expect(executionA.task.state).toBe("DONE");
		expect(JSON.stringify(executionA.handoff)).not.toContain(PRIVATE_MARKER);
		expect(store.getHandoffReceipt(taskA.id)).toEqual(executionA.handoff);

		const restarted = new PersistentStateStore(statePath);
		expect(restarted.getHandoffReceipt(taskA.id)).toEqual(executionA.handoff);
		expect(() =>
			restarted.transact((state) => {
				const receipt = state.handoff_receipts.find((candidate) => candidate.task_id === taskA.id);
				if (receipt) receipt.git_sha = "forged-git";
			}),
		).toThrow(/provenance|verification/);
		expect(() =>
			restarted.transact((state) => {
				delete state.handoff_bindings[taskA.id];
			}),
		).toThrow("missing controller provenance");

		const master = new MasterControlPlane();
		expect(() => master.receiveHandoff(executionA as unknown)).toThrow("receipt-only handoff");
		expect(master.receiveHandoff(restarted.getHandoffReceipt(taskA.id))).toEqual(executionA.handoff);

		let taskBInput = "";
		const taskB = task("task-b");
		const executionB = await new PersonalPiPipeline({ state_store: restarted }).execute({
			...planFor(taskB),
			requirement: requirementFor(),
			task: taskB,
			handoff_task_ids: [taskA.id],
			worker: new PiWorker("worker-b", (request) => {
				taskBInput = request.resolved_context?.text ?? "";
				return {
					status: "success",
					summary: "Task B completed from receipt-only context",
					evidence: ["worker_result"],
					work_receipt: noOpReceipt(),
				};
			}),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("git-b", [], []),
		});

		expect(executionB.task.state).toBe("DONE");
		expect(taskBInput).toContain('"task_id":"task-a"');
		expect(taskBInput).toContain('"git_sha":"git-a"');
		expect(taskBInput).not.toContain(PRIVATE_MARKER);
		expect(taskBInput).not.toContain("private Worker prose");
		expect(taskBInput).not.toContain("resolved_context");
	});

	test("keeps failed Worker detail out of the persisted receipt and behind an Artifact ref", async () => {
		const artifacts = new ArtifactStore();
		const store = new PersistentStateStore();
		const failedTask = task("task-failed");
		const execution = await new PersonalPiPipeline({ state_store: store, artifact_store: artifacts }).execute({
			...planFor(failedTask),
			requirement: requirementFor(),
			task: failedTask,
			worker: new PiWorker("worker-failed", () => {
				throw new Error(`${PRIVATE_MARKER}:${"stack-line ".repeat(2_000)}`);
			}),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("git-failed", [], []),
		});

		expect(execution.task.state).toBe("FAILED");
		expect(execution.handoff.failure?.error_summary).toContain("error_fingerprint=");
		expect(JSON.stringify(execution.handoff)).not.toContain(PRIVATE_MARKER);
		const artifactRef = execution.handoff.failure?.artifact_refs[0];
		expect(artifactRef).toBeTruthy();
		expect(JSON.stringify(artifacts.get(artifactRef as string)?.payload)).toContain(PRIVATE_MARKER);
		expect(store.getHandoffReceipt(failedTask.id)).toEqual(execution.handoff);
	});

	test("invalidates a terminal receipt before retry so a stale FAILED receipt cannot revive after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pph-stale-handoff-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const store = new PersistentStateStore(statePath);
		const failedTask = task("task-retry");
		const first = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(failedTask),
			requirement: requirementFor(),
			task: failedTask,
			worker: new PiWorker("worker-first", () => {
				throw new Error("first attempt failed");
			}),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("git-first", [], []),
		});

		expect(first.task.state).toBe("FAILED");
		expect(store.getHandoffReceipt(failedTask.id)).toEqual(first.handoff);

		const machine = new TaskStateMachine();
		let retried = store.getTask(failedTask.id);
		expect(retried?.state).toBe("FAILED");
		retried = store.updateTask(machine.transition(retried as NonNullable<typeof retried>, "READY", "retry"));
		expect(store.getHandoffReceipt(failedTask.id)).toBeUndefined();
		expect(store.read().handoff_bindings[failedTask.id]).toBeUndefined();
		retried = store.updateTask(machine.transition(retried, "RUNNING", "second attempt"));
		const secondRun = store.createRun(failedTask.id, "worker-second", 2, {
			worker_status: AVAILABLE_WORKER_STATUS,
			model_identity: UNKNOWN_MODEL_IDENTITY,
			workspace_commit_hash: "git-second",
		});
		store.saveResult({
			task_id: failedTask.id,
			run_id: secondRun.id,
			worker_id: "worker-second",
			lease_epoch: 2,
			status: "failure",
			summary: "second attempt failed before new handoff persisted",
			changed_files: [],
			artifacts: [],
			evidence: [],
			errors: ["second failure"],
			model_identity: UNKNOWN_MODEL_IDENTITY,
			work_receipt: {
				work_attempted: true,
				effects_count: 0,
				artifacts_created: [],
				state_changed: false,
				no_op: true,
				no_op_reason: "failed without durable effects",
				evidence_refs: [],
			},
		});
		store.updateTask(machine.transition(retried, "FAILED", "second failure"));

		const restarted = new PersistentStateStore(statePath);
		expect(restarted.getTask(failedTask.id)?.state).toBe("FAILED");
		expect(restarted.getHandoffReceipt(failedTask.id)).toBeUndefined();
		expect(restarted.read().handoff_receipts).toEqual([]);
		expect(restarted.read().handoff_bindings[failedTask.id]).toBeUndefined();
	});

	test("keeps default failure Artifact refs readable after a file-backed controller restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pph-handoff-artifact-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const store = new PersistentStateStore(statePath);
		const failedTask = task("task-artifact-restart");
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(failedTask),
			requirement: requirementFor(),
			task: failedTask,
			worker: new PiWorker("worker-artifact", () => {
				throw new Error(`${PRIVATE_MARKER}: durable raw failure detail`);
			}),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("git-artifact", [], []),
		});
		const artifactRef = execution.handoff.failure?.artifact_refs[0];
		expect(artifactRef).toBeTruthy();

		const restarted = new PersistentStateStore(statePath);
		expect(restarted.getHandoffReceipt(failedTask.id)).toEqual(execution.handoff);
		const reopenedArtifacts = new ArtifactStore(restarted.artifactStoreRootPath());
		expect(JSON.stringify(reopenedArtifacts.get(artifactRef as string)?.payload)).toContain(PRIVATE_MARKER);
	});

	test("cannot downgrade verified failure provenance or rebind an old Run to a newer task revision", async () => {
		const store = new PersistentStateStore();
		const verifiedFailureTask = task("task-verified-failure");
		verifiedFailureTask.verification.commands = ["verify-fails"];
		verifiedFailureTask.verification.evidence_required = [];
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(verifiedFailureTask),
			requirement: requirementFor(),
			task: verifiedFailureTask,
			worker: new PiWorker("worker-verified-failure", () => ({
				status: "success",
				summary: "worker completed, verifier will reject",
				evidence: [],
				work_receipt: noOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("git-verified-failure", [], []),
			command_runner: (command) => ({ command, exit_code: 1, stdout: "", stderr: "verification failed" }),
		});

		expect(execution.task.state).toBe("FAILED");
		expect(execution.handoff.evidence_refs).toHaveLength(1);
		expect(store.read().handoff_bindings[verifiedFailureTask.id]?.provenance_stage).toBe("verified");
		expect(() =>
			store.transact((state) => {
				const binding = state.handoff_bindings[verifiedFailureTask.id];
				if (binding) {
					binding.provenance_stage = "pre_verification";
					binding.verification_id = undefined;
				}
			}),
		).toThrow(/pre-verification|Verification|Evidence/);
		expect(() =>
			store.transact((state) => {
				const persistedTask = state.tasks.find((candidate) => candidate.id === verifiedFailureTask.id);
				const binding = state.handoff_bindings[verifiedFailureTask.id];
				if (persistedTask) persistedTask.task_revision += 1;
				if (binding) binding.task_revision += 1;
			}),
		).toThrow("Run belongs to a different task revision");
	});
});
