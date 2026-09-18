import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDeliveryEvidencePackage, deliveryEvidencePackageDigest } from "../src/evidence.ts";
import {
	createCommitActionDigest,
	createPublishActionDigest,
	createPushActionDigest,
	type GitCommandRunner,
	GitDeliveryExecutor,
} from "../src/git-delivery.ts";
import { createHumanApprovalRecord } from "../src/human-approval.ts";
import { PersistentStateStore } from "../src/persistence.ts";
import { TaskStateMachine } from "../src/state-machine.ts";
import type { HumanApprovalAction, TaskContract, WorkspaceSnapshot } from "../src/types.ts";
import { captureWorkspaceSnapshot } from "../src/verification.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];
const APPROVED_AT = "2026-09-18T12:03:00.000Z";
const ACTIVE_NOW = "2026-09-18T12:05:00.000Z";
const EXPIRES_AT = "2026-09-18T13:03:00.000Z";
let approvalSequence = 0;

interface AcceptedFixture {
	root: string;
	repo: string;
	baseline: string;
	store: PersistentStateStore;
	task_id: string;
	acceptance_id: string;
	evidence_id: string;
	package_digest: string;
	snapshot: WorkspaceSnapshot;
}

afterEach(() => {
	approvalSequence = 0;
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function changedFiles(repo: string): string[] {
	const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: repo,
		encoding: "utf8",
	});
	return porcelain
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3))
		.sort();
}

function initializeRepository(): { root: string; repo: string; baseline: string } {
	const root = mkdtempSync(join(tmpdir(), "personal-pi-git-delivery-"));
	temporaryDirectories.push(root);
	const repo = join(root, "project");
	mkdirSync(join(repo, "src"), { recursive: true });
	git(root, ["init", "-q", repo]);
	git(repo, ["config", "user.email", "git-delivery@example.invalid"]);
	git(repo, ["config", "user.name", "Git Delivery Test"]);
	writeFileSync(join(repo, "src", "a.ts"), "export const value = 'old';\n", "utf8");
	writeFileSync(join(repo, "outside.txt"), "outside-old\n", "utf8");
	git(repo, ["add", "--", "src/a.ts", "outside.txt"]);
	git(repo, ["commit", "-q", "-m", "baseline"]);
	return { root, repo: realpathSync(repo), baseline: git(repo, ["rev-parse", "HEAD"]) };
}

function acceptedFixture(
	options: { git_allowed?: string[]; stage_outside?: boolean; package_baseline?: string } = {},
): AcceptedFixture {
	const repository = initializeRepository();
	writeFileSync(join(repository.repo, "src", "a.ts"), "export const value = 'new';\n", "utf8");
	writeFileSync(join(repository.repo, "outside.txt"), "outside-dirty\n", "utf8");
	if (options.stage_outside) git(repository.repo, ["add", "--", "outside.txt"]);

	const store = new PersistentStateStore();
	store.addProject({
		project_id: "project-git-delivery",
		repo_path: repository.repo,
		baseline_commit: repository.baseline,
		architecture_doc_ref: "ARCHITECTURE.md",
		task_ledger_ref: "TASKS.md",
	});
	const base = makeV3Task("git-delivery-task");
	const contract: TaskContract = {
		...base,
		scope: { files: ["src/a.ts"] },
		permissions: {
			...base.permissions,
			git: { allowed: options.git_allowed ?? ["commit", "push", "publish"] },
		},
		execution: { ...base.execution, working_directory: repository.repo },
		verification: {
			strategy: "automated",
			commands: [],
			checks: [],
			evidence_required: [],
			strength: "strong",
		},
	};
	let task = store.createTaskWithLedgerBinding(contract, {
		project_id: "project-git-delivery",
		project_task_id: "T4.3-A",
		pph_task_id: contract.id,
		phase: "P4",
		unknowns: [],
	});
	const machine = new TaskStateMachine();
	task = store.updateTask(machine.transition(task, "READY"));
	task = store.updateTask(machine.transition(task, "RUNNING"));
	const run = store.createRun(task.id, "worker-git-delivery", 1, {
		worker_status: AVAILABLE_WORKER_STATUS,
		model_identity: UNKNOWN_MODEL_IDENTITY,
		workspace_commit_hash: repository.baseline,
	});
	store.saveResult({
		task_id: task.id,
		run_id: run.id,
		worker_id: "worker-git-delivery",
		lease_epoch: 1,
		status: "success",
		summary: "accepted project change",
		changed_files: ["src/a.ts"],
		artifacts: [],
		evidence: ["worker_result"],
		errors: [],
		model_identity: UNKNOWN_MODEL_IDENTITY,
		work_receipt: {
			work_attempted: true,
			effects_count: 1,
			artifacts_created: [],
			state_changed: true,
			no_op: false,
			evidence_refs: ["worker_result"],
		},
	});
	task = store.updateTask(machine.transition(task, "VERIFYING"));
	const workspaceFiles = changedFiles(repository.repo);
	const snapshot = captureWorkspaceSnapshot(repository.baseline, workspaceFiles, []);
	const deliveryPackage = createDeliveryEvidencePackage({
		baseline_commit: options.package_baseline ?? repository.baseline,
		task_revision: task.task_revision,
		snapshot,
		changed_files: ["src/a.ts"],
		commands: [],
		test_output_summary: "verified",
		provider_mode: "local",
	});
	const evidenceId = "evidence-git-delivery";
	store.saveEvidence({
		id: evidenceId,
		task_id: task.id,
		run_id: run.id,
		captured_at: "2026-09-18T12:00:00.000Z",
		diff: { files: workspaceFiles, digest: snapshot.diff_digest },
		commands: [],
		stdout: "",
		stderr: "",
		artifacts: [],
		evidence_types: [],
		delivery_evidence_package: deliveryPackage,
	});
	const packageDigest = deliveryEvidencePackageDigest(deliveryPackage);
	store.saveVerification({
		id: "verification-git-delivery",
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
	const accepted = store.acceptTask(
		task.id,
		"verification-git-delivery",
		run.id,
		snapshot,
		"2026-09-18T12:02:00.000Z",
	);
	return {
		...repository,
		store,
		task_id: task.id,
		acceptance_id: accepted.acceptance.id,
		evidence_id: evidenceId,
		package_digest: packageDigest,
		snapshot,
	};
}

function saveApproval(
	fixture: AcceptedFixture,
	action: HumanApprovalAction,
	digest: string,
	overrides: Partial<{ task_revision: number; approved_at: string; expires_at: string }> = {},
): string {
	approvalSequence += 1;
	const record = createHumanApprovalRecord({
		id: `approval-${action}-${approvalSequence}`,
		task_id: fixture.task_id,
		task_revision: overrides.task_revision ?? 1,
		action,
		action_digest: digest,
		approved_at: overrides.approved_at ?? APPROVED_AT,
		expires_at: overrides.expires_at ?? EXPIRES_AT,
		approved_by: "owner",
	});
	fixture.store.saveHumanApproval(record, ACTIVE_NOW);
	return record.id;
}

async function commitFixture(fixture: AcceptedFixture, message = "scope-only commit") {
	const executor = new GitDeliveryExecutor({ state_store: fixture.store, now: () => ACTIVE_NOW });
	const digest = executor.expectedCommitActionDigest(fixture.task_id, message);
	const approvalId = saveApproval(fixture, "commit", digest);
	const record = await executor.executeCommit({
		task_id: fixture.task_id,
		approval_id: approvalId,
		message,
	});
	if (record.action !== "commit" || record.status !== "COMMITTED") throw new Error("fixture commit did not complete");
	return { executor, record };
}

describe("T4.3-A git delivery executor", () => {
	test("commits only Task scope and preserves unrelated unstaged changes", async () => {
		const fixture = acceptedFixture();
		const beforeOutside = readFileSync(join(fixture.repo, "outside.txt"), "utf8");
		const { record } = await commitFixture(fixture);

		expect(record.parent_sha).toBe(fixture.baseline);
		expect(record.scope_files).toEqual(["src/a.ts"]);
		expect(record.commit_sha).toBe(git(fixture.repo, ["rev-parse", "HEAD"]));
		expect(record).toMatchObject({
			acceptance_id: fixture.acceptance_id,
			evidence_id: fixture.evidence_id,
			delivery_evidence_package_digest: fixture.package_digest,
		});
		expect(git(fixture.repo, ["diff", "--name-only", `${record.parent_sha}`, `${record.commit_sha}`])).toBe(
			"src/a.ts",
		);
		expect(readFileSync(join(fixture.repo, "outside.txt"), "utf8")).toBe(beforeOutside);
		expect(git(fixture.repo, ["status", "--short"])).toContain("outside.txt");
		expect(git(fixture.repo, ["diff", "--cached", "--name-only"])).toBe("");
		expect(fixture.store.getDeliveryAction(record.id)).toEqual(record);
	});

	test("fails closed on an out-of-scope pre-staged path without changing the index", async () => {
		const fixture = acceptedFixture({ stage_outside: true });
		const beforeIndex = execFileSync("git", ["diff", "--cached", "--binary"], {
			cwd: fixture.repo,
			encoding: "utf8",
		});
		const executor = new GitDeliveryExecutor({ state_store: fixture.store, now: () => ACTIVE_NOW });
		const digest = executor.expectedCommitActionDigest(fixture.task_id, "must block");
		const approvalId = saveApproval(fixture, "commit", digest);
		const record = await executor.executeCommit({
			task_id: fixture.task_id,
			approval_id: approvalId,
			message: "must block",
		});

		expect(record).toMatchObject({ action: "commit", status: "BLOCKED", parent_sha: fixture.baseline });
		expect(record.detail).toContain("out-of-scope paths are already staged");
		const afterIndex = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: fixture.repo, encoding: "utf8" });
		expect(afterIndex).toBe(beforeIndex);
		expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.baseline);
	});

	test("rejects missing, expired, wrong-action, wrong-digest, and stale-revision approvals before git effects", async () => {
		const fixture = acceptedFixture();
		const executor = new GitDeliveryExecutor({ state_store: fixture.store, now: () => ACTIVE_NOW });
		const digest = executor.expectedCommitActionDigest(fixture.task_id, "approval checks");
		await expect(
			executor.executeCommit({
				task_id: fixture.task_id,
				approval_id: "missing-approval",
				message: "approval checks",
			}),
		).rejects.toThrow("unknown human approval");

		const wrongDigest = saveApproval(fixture, "commit", "wrong-digest");
		await expect(
			executor.executeCommit({
				task_id: fixture.task_id,
				approval_id: wrongDigest,
				message: "approval checks",
			}),
		).rejects.toThrow("binding mismatch");
		const wrongAction = saveApproval(fixture, "push", digest);
		await expect(
			executor.executeCommit({
				task_id: fixture.task_id,
				approval_id: wrongAction,
				message: "approval checks",
			}),
		).rejects.toThrow("binding mismatch");
		const expired = saveApproval(fixture, "commit", digest, { expires_at: "2026-09-18T12:06:00.000Z" });
		const expiredExecutor = new GitDeliveryExecutor({
			state_store: fixture.store,
			now: () => "2026-09-18T12:07:00.000Z",
		});
		await expect(
			expiredExecutor.executeCommit({
				task_id: fixture.task_id,
				approval_id: expired,
				message: "approval checks",
			}),
		).rejects.toThrow("expired");
		expect(() =>
			fixture.store.saveHumanApproval(
				createHumanApprovalRecord({
					id: "approval-stale-revision",
					task_id: fixture.task_id,
					task_revision: 2,
					action: "commit",
					action_digest: digest,
					approved_at: APPROVED_AT,
					expires_at: EXPIRES_AT,
					approved_by: "owner",
				}),
				ACTIVE_NOW,
			),
		).toThrow("revision is stale");
		expect(fixture.store.listDeliveryActions()).toEqual([]);
		expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.baseline);
	});

	test("blocks stale package, workspace snapshot, index, and denied git permission", async () => {
		const stalePackage = acceptedFixture({ package_baseline: "stale-baseline" });
		const stalePackageExecutor = new GitDeliveryExecutor({ state_store: stalePackage.store });
		expect(() => stalePackageExecutor.expectedCommitActionDigest(stalePackage.task_id, "stale package")).toThrow(
			"baseline does not match registered project",
		);

		const staleWorkspace = acceptedFixture();
		const staleExecutor = new GitDeliveryExecutor({ state_store: staleWorkspace.store, now: () => ACTIVE_NOW });
		const staleDigest = staleExecutor.expectedCommitActionDigest(staleWorkspace.task_id, "stale workspace");
		const staleApproval = saveApproval(staleWorkspace, "commit", staleDigest);
		writeFileSync(join(staleWorkspace.repo, "new-outside.txt"), "new dirty file\n", "utf8");
		const staleRecord = await staleExecutor.executeCommit({
			task_id: staleWorkspace.task_id,
			approval_id: staleApproval,
			message: "stale workspace",
		});
		expect(staleRecord).toMatchObject({ action: "commit", status: "BLOCKED" });
		expect(staleRecord.detail).toContain("workspace snapshot");

		const denied = acceptedFixture({ git_allowed: [] });
		const deniedExecutor = new GitDeliveryExecutor({ state_store: denied.store, now: () => ACTIVE_NOW });
		const deniedDigest = deniedExecutor.expectedCommitActionDigest(denied.task_id, "permission denied");
		const deniedApproval = saveApproval(denied, "commit", deniedDigest);
		const deniedRecord = await deniedExecutor.executeCommit({
			task_id: denied.task_id,
			approval_id: deniedApproval,
			message: "permission denied",
		});
		expect(deniedRecord).toMatchObject({ action: "commit", status: "BLOCKED" });
		expect(deniedRecord.detail).toContain("git action outside scope: commit");
	});

	test("separates commit/push/publish digests and binds push/publish to the exact committed SHA", async () => {
		const fixture = acceptedFixture();
		const { record: committed } = await commitFixture(fixture, "delivery commit");
		const commitSha = committed.commit_sha;
		const pushCalls: string[][] = [];
		const gitRunner: GitCommandRunner = ({ cwd, args }) => {
			if (args[0] === "push") {
				pushCalls.push([...args]);
				return { exit_code: 0, stdout: "pushed", stderr: "" };
			}
			const result = spawnSync("git", args, { cwd, encoding: "utf8" });
			return {
				exit_code: result.status ?? 1,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? result.error?.message ?? "",
			};
		};
		const publishes: Array<{ commit_sha: string; package_name: string; version: string; registry: string }> = [];
		const executor = new GitDeliveryExecutor({
			state_store: fixture.store,
			git_runner: gitRunner,
			now: () => ACTIVE_NOW,
			publisher: (request) => {
				publishes.push(request);
				return { ok: true, detail: "published by test double" };
			},
		});
		const commitDigest = createCommitActionDigest({
			task_id: fixture.task_id,
			task_revision: 1,
			acceptance_id: fixture.acceptance_id,
			evidence_id: fixture.evidence_id,
			delivery_evidence_package_digest: fixture.package_digest,
			workspace_snapshot_ref: `workspace:${"x".repeat(64)}`,
			repo_path: fixture.repo,
			parent_sha: fixture.baseline,
			scope_files: ["src/a.ts"],
			message: "delivery commit",
		});
		const pushDigest = executor.expectedPushActionDigest(
			fixture.task_id,
			commitSha,
			"origin",
			"HEAD:refs/heads/main",
		);
		const publishDigest = executor.expectedPublishActionDigest(
			fixture.task_id,
			commitSha,
			"@example/pkg",
			"1.2.3",
			"https://registry.example.invalid",
		);
		expect(new Set([commitDigest, pushDigest, publishDigest]).size).toBe(3);
		expect(
			createPushActionDigest({
				task_id: fixture.task_id,
				task_revision: 1,
				acceptance_id: fixture.acceptance_id,
				evidence_id: fixture.evidence_id,
				delivery_evidence_package_digest: fixture.package_digest,
				workspace_snapshot_ref: `workspace:${"x".repeat(64)}`,
				repo_path: fixture.repo,
				commit_sha: commitSha,
				remote: "origin",
				refspec: "HEAD:refs/heads/main",
			}),
		).not.toBe(
			createPublishActionDigest({
				task_id: fixture.task_id,
				task_revision: 1,
				acceptance_id: fixture.acceptance_id,
				evidence_id: fixture.evidence_id,
				delivery_evidence_package_digest: fixture.package_digest,
				workspace_snapshot_ref: `workspace:${"x".repeat(64)}`,
				commit_sha: commitSha,
				package_name: "@example/pkg",
				version: "1.2.3",
				registry: "https://registry.example.invalid",
			}),
		);

		const pushApproval = saveApproval(fixture, "push", pushDigest);
		const pushed = await executor.executePush({
			task_id: fixture.task_id,
			approval_id: pushApproval,
			commit_sha: commitSha,
			remote: "origin",
			refspec: "HEAD:refs/heads/main",
		});
		expect(pushed).toMatchObject({ action: "push", status: "PUSHED", commit_sha: commitSha });
		expect(pushCalls).toEqual([["push", "--", "origin", "HEAD:refs/heads/main"]]);

		const publishApproval = saveApproval(fixture, "publish", publishDigest);
		const published = await executor.executePublish({
			task_id: fixture.task_id,
			approval_id: publishApproval,
			commit_sha: commitSha,
			package_name: "@example/pkg",
			version: "1.2.3",
			registry: "https://registry.example.invalid",
		});
		expect(published).toMatchObject({ action: "publish", status: "PUBLISHED", commit_sha: commitSha });
		expect(publishes).toEqual([
			expect.objectContaining({
				commit_sha: commitSha,
				package_name: "@example/pkg",
				version: "1.2.3",
				registry: "https://registry.example.invalid",
			}),
		]);

		await expect(
			executor.executePush({
				task_id: fixture.task_id,
				approval_id: committed.approval_id,
				commit_sha: commitSha,
				remote: "origin",
				refspec: "HEAD:refs/heads/main",
			}),
		).rejects.toThrow("binding mismatch");
	});

	test("records blocked wrong-commit attempts and failed injected push/publish attempts after valid approval", async () => {
		const fixture = acceptedFixture();
		const { record: committed } = await commitFixture(fixture);
		const failingRunner: GitCommandRunner = ({ cwd, args }) => {
			if (args[0] === "push") return { exit_code: 1, stdout: "", stderr: "remote rejected" };
			const result = spawnSync("git", args, { cwd, encoding: "utf8" });
			return {
				exit_code: result.status ?? 1,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? result.error?.message ?? "",
			};
		};
		const executor = new GitDeliveryExecutor({
			state_store: fixture.store,
			git_runner: failingRunner,
			now: () => ACTIVE_NOW,
			publisher: () => ({ ok: false, detail: "registry rejected" }),
		});
		const wrongCommit = `${committed.commit_sha.slice(0, -1)}${committed.commit_sha.endsWith("0") ? "1" : "0"}`;
		const wrongDigest = executor.expectedPushActionDigest(
			fixture.task_id,
			wrongCommit,
			"origin",
			"HEAD:refs/heads/main",
		);
		const wrongApproval = saveApproval(fixture, "push", wrongDigest);
		const blocked = await executor.executePush({
			task_id: fixture.task_id,
			approval_id: wrongApproval,
			commit_sha: wrongCommit,
			remote: "origin",
			refspec: "HEAD:refs/heads/main",
		});
		expect(blocked).toMatchObject({ action: "push", status: "BLOCKED", commit_sha: wrongCommit });

		const failDigest = executor.expectedPushActionDigest(
			fixture.task_id,
			committed.commit_sha,
			"origin",
			"HEAD:refs/heads/failing",
		);
		const failApproval = saveApproval(fixture, "push", failDigest);
		const failedPush = await executor.executePush({
			task_id: fixture.task_id,
			approval_id: failApproval,
			commit_sha: committed.commit_sha,
			remote: "origin",
			refspec: "HEAD:refs/heads/failing",
		});
		expect(failedPush).toMatchObject({ action: "push", status: "FAILED" });
		expect(failedPush.detail).toContain("remote rejected");

		const publishDigest = executor.expectedPublishActionDigest(
			fixture.task_id,
			committed.commit_sha,
			"@example/pkg",
			"9.9.9",
			"https://registry.example.invalid",
		);
		const publishApproval = saveApproval(fixture, "publish", publishDigest);
		const failedPublish = await executor.executePublish({
			task_id: fixture.task_id,
			approval_id: publishApproval,
			commit_sha: committed.commit_sha,
			package_name: "@example/pkg",
			version: "9.9.9",
			registry: "https://registry.example.invalid",
		});
		expect(failedPublish).toMatchObject({ action: "publish", status: "FAILED" });
		expect(failedPublish.detail).toBe("registry rejected");
	});
});
