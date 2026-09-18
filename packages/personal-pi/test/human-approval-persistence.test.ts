import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	assertHumanApprovalAuthorizes,
	captureWorkspaceSnapshot,
	createDeliveryActionRecord,
	createDeliveryEvidencePackage,
	createHumanApprovalRecord,
	deliveryEvidencePackageDigest,
	normalizePersistentState,
	type PersistentState,
	PersistentStateStore,
	TaskStateMachine,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

function acceptedStore(statePath?: string) {
	const store = new PersistentStateStore(statePath);
	const contract = makeV3Task("t4.3-authorization", {
		scope: { files: ["src/a.ts", "src/b.ts"] },
		verification: {
			strategy: "automated",
			commands: [],
			checks: [],
			evidence_required: [],
			strength: "strong",
		},
	});
	let task = store.createTask(contract);
	const machine = new TaskStateMachine();
	task = store.updateTask(machine.transition(task, "READY"));
	task = store.updateTask(machine.transition(task, "RUNNING"));
	const run = store.createRun(task.id, "worker", 1, {
		worker_status: AVAILABLE_WORKER_STATUS,
		model_identity: UNKNOWN_MODEL_IDENTITY,
	});
	store.saveResult({
		task_id: task.id,
		run_id: run.id,
		worker_id: "worker",
		lease_epoch: 1,
		status: "success",
		summary: "verified no-op",
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors: [],
		model_identity: UNKNOWN_MODEL_IDENTITY,
		work_receipt: {
			work_attempted: true,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: true,
			no_op_reason: "model-only authorization fixture",
			evidence_refs: [],
		},
	});
	task = store.updateTask(machine.transition(task, "VERIFYING"));
	const snapshot = captureWorkspaceSnapshot("parent-sha", [], []);
	const deliveryPackage = createDeliveryEvidencePackage({
		baseline_commit: "baseline-sha",
		task_revision: task.task_revision,
		snapshot,
		changed_files: [],
		commands: [],
		test_output_summary: "verified",
		provider_mode: "local",
	});
	const evidenceId = "evidence-t4.3";
	store.saveEvidence({
		id: evidenceId,
		task_id: task.id,
		run_id: run.id,
		captured_at: "2026-09-18T12:00:00.000Z",
		diff: structuredClone(deliveryPackage.actual_diff),
		commands: [],
		stdout: "",
		stderr: "",
		artifacts: [],
		evidence_types: [],
		delivery_evidence_package: deliveryPackage,
	});
	const packageDigest = deliveryEvidencePackageDigest(deliveryPackage);
	store.saveVerification({
		id: "verification-t4.3",
		task_id: task.id,
		evidence_id: evidenceId,
		delivery_evidence_package_digest: packageDigest,
		status: "PASS",
		verification_confidence: "strong",
		task_revision: task.task_revision,
		commit_hash: snapshot.commit_hash,
		diff_digest: snapshot.diff_digest,
		artifact_digest: snapshot.artifact_digest,
		checked_at: "2026-09-18T12:01:00.000Z",
		checks: [],
		reasons: [],
	});
	const accepted = store.acceptTask(task.id, "verification-t4.3", run.id, snapshot, "2026-09-18T12:02:00.000Z");
	return { store, task: accepted.task, acceptance: accepted.acceptance, evidenceId, packageDigest };
}

function approval(action: "commit" | "push" | "publish" = "commit", digest = "a".repeat(64)) {
	return createHumanApprovalRecord({
		id: `approval-${action}-${digest.slice(0, 6)}`,
		task_id: "t4.3-authorization",
		task_revision: 1,
		action,
		action_digest: digest,
		approved_at: "2026-09-18T12:03:00.000Z",
		expires_at: "2026-09-18T13:03:00.000Z",
		approved_by: "owner",
	});
}

describe("T4.3-A persistent human approval model", () => {
	test("requires an active exact action/digest/revision-bound approval", () => {
		const record = approval();
		expect(() =>
			assertHumanApprovalAuthorizes(record, {
				task_id: record.task_id,
				task_revision: record.task_revision,
				action: record.action,
				action_digest: record.action_digest,
				now: "2026-09-18T12:30:00.000Z",
			}),
		).not.toThrow();
		for (const mismatch of [{ action: "push" as const }, { action_digest: "b".repeat(64) }, { task_revision: 2 }]) {
			expect(() =>
				assertHumanApprovalAuthorizes(record, {
					task_id: record.task_id,
					task_revision: record.task_revision,
					action: record.action,
					action_digest: record.action_digest,
					now: "2026-09-18T12:30:00.000Z",
					...mismatch,
				}),
			).toThrow("binding mismatch");
		}
		expect(() =>
			assertHumanApprovalAuthorizes(record, {
				task_id: record.task_id,
				task_revision: record.task_revision,
				action: record.action,
				action_digest: record.action_digest,
				now: record.expires_at,
			}),
		).toThrow("expired");
		expect(() =>
			assertHumanApprovalAuthorizes(record, {
				task_id: record.task_id,
				task_revision: record.task_revision,
				action: record.action,
				action_digest: record.action_digest,
				now: "2026-09-18T14:00:00.000Z",
			}),
		).toThrow("expired");
		expect(() =>
			createHumanApprovalRecord({
				...record,
				id: "invalid-expiry",
				expires_at: "",
			}),
		).toThrow("expires_at");
		expect(() =>
			createDeliveryActionRecord({
				id: "push-shape",
				task_id: record.task_id,
				task_revision: record.task_revision,
				action: "push",
				status: "PUSHED",
				approval_id: "approval-push",
				action_digest: "b".repeat(64),
				acceptance_id: "acceptance",
				evidence_id: "evidence",
				delivery_evidence_package_digest: "c".repeat(64),
				attempted_at: "2026-09-18T12:30:00.000Z",
				repo_path: "/repo",
				commit_sha: "commit-sha",
				remote: "origin",
				refspec: "HEAD:refs/heads/main",
			}),
		).not.toThrow();
		expect(() =>
			createDeliveryActionRecord({
				id: "publish-shape",
				task_id: record.task_id,
				task_revision: record.task_revision,
				action: "publish",
				status: "PUBLISHED",
				approval_id: "approval-publish",
				action_digest: "c".repeat(64),
				acceptance_id: "acceptance",
				evidence_id: "evidence",
				delivery_evidence_package_digest: "d".repeat(64),
				attempted_at: "2026-09-18T12:30:00.000Z",
				commit_sha: "commit-sha",
				package_name: "@example/pkg",
				version: "1.2.3",
				registry: "https://registry.example.test",
			}),
		).not.toThrow();
	});

	test("persists immutable approval and evidence-bound final Commit record across restart", () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-t4.3-auth-"));
		temporaryDirectories.push(root);
		const statePath = join(root, "state.json");
		const fixture = acceptedStore(statePath);
		const record = fixture.store.saveHumanApproval(approval(), "2026-09-18T12:04:00.000Z");
		const action = createDeliveryActionRecord({
			id: "delivery-commit-1",
			task_id: fixture.task.id,
			task_revision: fixture.task.task_revision,
			action: "commit",
			status: "COMMITTED",
			approval_id: record.id,
			action_digest: record.action_digest,
			acceptance_id: fixture.acceptance.id,
			evidence_id: fixture.evidenceId,
			delivery_evidence_package_digest: fixture.packageDigest,
			attempted_at: "2026-09-18T12:05:00.000Z",
			repo_path: "/repo",
			scope_files: ["src/a.ts", "src/b.ts"],
			parent_sha: "parent-sha",
			commit_sha: "commit-sha",
			detail: "scope-only commit completed",
		});
		fixture.store.saveDeliveryAction(action);

		expect(fixture.store.getHumanApproval(record.id)).toEqual(record);
		expect(fixture.store.listHumanApprovals(fixture.task.id, "commit")).toEqual([record]);
		expect(fixture.store.getDeliveryAction(action.id)).toEqual(action);
		expect(fixture.store.listDeliveryActions(fixture.task.id, "commit")).toEqual([action]);
		const restarted = new PersistentStateStore(statePath);
		expect(restarted.getHumanApproval(record.id)).toEqual(record);
		expect(restarted.getDeliveryAction(action.id)).toEqual(action);
	});

	test("rejects stale/expired approvals and invalid delivery authorization bindings", () => {
		const fixture = acceptedStore();
		const stale = createHumanApprovalRecord({ ...approval(), id: "approval-stale", task_revision: 2 });
		expect(() => fixture.store.saveHumanApproval(stale, "2026-09-18T12:04:00.000Z")).toThrow("revision is stale");
		const expired = createHumanApprovalRecord({
			...approval(),
			id: "approval-expired",
			expires_at: "2026-09-18T12:10:00.000Z",
		});
		expect(() => fixture.store.saveHumanApproval(expired, "2026-09-18T12:11:00.000Z")).toThrow("expired");

		const commitApproval = fixture.store.saveHumanApproval(approval(), "2026-09-18T12:04:00.000Z");
		const base = {
			id: "delivery-invalid",
			task_id: fixture.task.id,
			task_revision: fixture.task.task_revision,
			action: "commit" as const,
			status: "BLOCKED" as const,
			approval_id: commitApproval.id,
			action_digest: commitApproval.action_digest,
			acceptance_id: fixture.acceptance.id,
			evidence_id: fixture.evidenceId,
			delivery_evidence_package_digest: fixture.packageDigest,
			attempted_at: "2026-09-18T12:05:00.000Z",
			repo_path: "/repo",
			scope_files: ["src/a.ts", "src/b.ts"],
			parent_sha: "parent-sha",
		};
		expect(() =>
			fixture.store.saveDeliveryAction(createDeliveryActionRecord({ ...base, scope_files: ["src/a.ts"] })),
		).toThrow("commit scope");
		expect(() =>
			fixture.store.saveDeliveryAction(
				createDeliveryActionRecord({
					id: "delivery-cross-action",
					task_id: fixture.task.id,
					task_revision: fixture.task.task_revision,
					action: "push",
					status: "BLOCKED",
					approval_id: commitApproval.id,
					action_digest: commitApproval.action_digest,
					acceptance_id: fixture.acceptance.id,
					evidence_id: fixture.evidenceId,
					delivery_evidence_package_digest: fixture.packageDigest,
					attempted_at: "2026-09-18T12:05:00.000Z",
					repo_path: "/repo",
					commit_sha: "commit-sha",
					remote: "origin",
					refspec: "HEAD:refs/heads/main",
				}),
			),
		).toThrow("human approval binding");
		expect(() =>
			fixture.store.saveDeliveryAction(
				createDeliveryActionRecord({
					...base,
					id: "delivery-wrong-package",
					delivery_evidence_package_digest: "wrong",
				}),
			),
		).toThrow("package digest mismatch");
		expect(() =>
			fixture.store.saveDeliveryAction(
				createDeliveryActionRecord({
					...base,
					id: "delivery-after-expiry",
					attempted_at: "2026-09-18T14:00:00.000Z",
				}),
			),
		).toThrow("human approval binding");
	});

	test("prevents mutation, deletion, duplicate IDs, and approval reuse", () => {
		const fixture = acceptedStore();
		const record = fixture.store.saveHumanApproval(approval(), "2026-09-18T12:04:00.000Z");
		const action = createDeliveryActionRecord({
			id: "delivery-final",
			task_id: fixture.task.id,
			task_revision: fixture.task.task_revision,
			action: "commit",
			status: "FAILED",
			approval_id: record.id,
			action_digest: record.action_digest,
			acceptance_id: fixture.acceptance.id,
			evidence_id: fixture.evidenceId,
			delivery_evidence_package_digest: fixture.packageDigest,
			attempted_at: "2026-09-18T12:05:00.000Z",
			repo_path: "/repo",
			scope_files: ["src/a.ts", "src/b.ts"],
			parent_sha: "parent-sha",
			detail: "commit command failed",
		});
		fixture.store.saveDeliveryAction(action);

		expect(() =>
			fixture.store.transact((state) => {
				const persisted = state.human_approvals.find((candidate) => candidate.id === record.id);
				if (persisted) persisted.approved_by = "other";
			}),
		).toThrow("immutable");
		expect(() =>
			fixture.store.transact((state) => {
				state.human_approvals = [];
			}),
		).toThrow("cannot be deleted");
		expect(() => fixture.store.transact((state) => state.human_approvals.push(structuredClone(record)))).toThrow(
			/duplicate/,
		);
		expect(() =>
			fixture.store.transact((state) =>
				state.human_approvals.push({ ...structuredClone(record), id: "approval-stale-direct", task_revision: 2 }),
			),
		).toThrow("task revision is stale");
		expect(() =>
			fixture.store.transact((state) => {
				const persisted = state.delivery_actions.find((candidate) => candidate.id === action.id);
				if (persisted) persisted.detail = "tampered";
			}),
		).toThrow("immutable");
		expect(() =>
			fixture.store.transact((state) => {
				state.delivery_actions = [];
			}),
		).toThrow("cannot be deleted");
		expect(() =>
			fixture.store.saveDeliveryAction(
				createDeliveryActionRecord({
					...action,
					id: "delivery-reuse",
					status: "BLOCKED",
					detail: "same approval reused",
				}),
			),
		).toThrow("reused by multiple delivery actions");
	});

	test("keeps state version 2 backward-compatible by normalizing new collections to empty arrays", () => {
		const normalized = normalizePersistentState({ version: 2 } as Partial<PersistentState>);
		expect(normalized.version).toBe(2);
		expect(normalized.human_approvals).toEqual([]);
		expect(normalized.delivery_actions).toEqual([]);
	});
});
