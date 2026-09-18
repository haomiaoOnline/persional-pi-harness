import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { digestFor } from "./artifacts.ts";
import { deliveryEvidencePackageDigest, validateDeliveryEvidencePackage, workspaceSnapshotRef } from "./evidence.ts";
import { assertHumanApprovalAuthorizes, createDeliveryActionRecord } from "./human-approval.ts";
import type { PersistentStateStore } from "./persistence.ts";
import { DEFAULT_ROLE_PROFILES } from "./roles.ts";
import { evaluateTaskPermissions } from "./security.ts";
import type {
	AcceptanceRecord,
	DeliveryActionRecord,
	DeliveryEvidencePackage,
	EvidenceRecord,
	HumanApprovalAction,
	HumanApprovalRecord,
	JsonValue,
	ProjectRecord,
	RoleProfile,
	TaskRecord,
	VerificationRecord,
	WorkspaceSnapshot,
} from "./types.ts";
import { captureWorkspaceSnapshot } from "./verification.ts";

export interface GitCommandRequest {
	cwd: string;
	args: string[];
}

export interface GitCommandResult {
	exit_code: number;
	stdout: string;
	stderr: string;
}

export type GitCommandRunner = (request: GitCommandRequest) => GitCommandResult | Promise<GitCommandResult>;

export interface PublishRequest {
	repo_path: string;
	commit_sha: string;
	package_name: string;
	version: string;
	registry: string;
}

export interface PublishResult {
	ok: boolean;
	detail?: string;
}

export type DeliveryPublisher = (request: PublishRequest) => PublishResult | Promise<PublishResult>;

export interface DeliveryDigestBinding {
	task_id: string;
	task_revision: number;
	acceptance_id: string;
	evidence_id: string;
	delivery_evidence_package_digest: string;
	workspace_snapshot_ref: string;
}

export interface CommitActionDigestInput extends DeliveryDigestBinding {
	repo_path: string;
	parent_sha: string;
	scope_files: string[];
	message: string;
}

export interface PushActionDigestInput extends DeliveryDigestBinding {
	repo_path: string;
	commit_sha: string;
	remote: string;
	refspec: string;
}

export interface PublishActionDigestInput extends DeliveryDigestBinding {
	commit_sha: string;
	package_name: string;
	version: string;
	registry: string;
}

export interface ExecuteCommitRequest {
	task_id: string;
	approval_id: string;
	message: string;
}

export interface ExecutePushRequest {
	task_id: string;
	approval_id: string;
	commit_sha: string;
	remote: string;
	refspec: string;
}

export interface ExecutePublishRequest {
	task_id: string;
	approval_id: string;
	commit_sha: string;
	package_name: string;
	version: string;
	registry: string;
}

export interface GitDeliveryExecutorOptions {
	state_store: PersistentStateStore;
	git_runner?: GitCommandRunner;
	publisher?: DeliveryPublisher;
	now?: () => string;
}

interface CanonicalDeliveryBinding {
	task: TaskRecord;
	acceptance: AcceptanceRecord;
	evidence: EvidenceRecord;
	delivery_package: DeliveryEvidencePackage;
	package_digest: string;
	verification: VerificationRecord;
	project: ProjectRecord;
	role?: RoleProfile;
}

type CommitDeliveryActionInput = Omit<Extract<DeliveryActionRecord, { action: "commit" }>, "id">;
type PushDeliveryActionInput = Omit<Extract<DeliveryActionRecord, { action: "push" }>, "id">;
type PublishDeliveryActionInput = Omit<Extract<DeliveryActionRecord, { action: "publish" }>, "id">;
type NonCommitDeliveryActionInput = PushDeliveryActionInput | PublishDeliveryActionInput;

function nonEmpty(value: string, field: string): string {
	if (!value.trim()) throw new Error(`${field} must not be empty`);
	return value;
}

function normalizedScope(files: readonly string[]): string[] {
	const normalized = files.map((file) => file.trim()).filter(Boolean);
	if (normalized.length === 0) throw new Error("TaskContract.scope.files must not be empty for commit delivery");
	if (new Set(normalized).size !== normalized.length)
		throw new Error("TaskContract.scope.files must not contain duplicates");
	return [...normalized].sort();
}

function semanticDigest(kind: string, value: JsonValue): string {
	return digestFor({ schema: `personal-pi/${kind}@1`, value });
}

export function createCommitActionDigest(input: CommitActionDigestInput): string {
	return semanticDigest("git-delivery/commit", {
		task_id: input.task_id,
		task_revision: input.task_revision,
		acceptance_id: input.acceptance_id,
		evidence_id: input.evidence_id,
		delivery_evidence_package_digest: input.delivery_evidence_package_digest,
		workspace_snapshot_ref: input.workspace_snapshot_ref,
		repo_path: input.repo_path,
		parent_sha: input.parent_sha,
		scope_files: [...input.scope_files].sort(),
		message: input.message,
	});
}

export function createPushActionDigest(input: PushActionDigestInput): string {
	return semanticDigest("git-delivery/push", {
		task_id: input.task_id,
		task_revision: input.task_revision,
		acceptance_id: input.acceptance_id,
		evidence_id: input.evidence_id,
		delivery_evidence_package_digest: input.delivery_evidence_package_digest,
		workspace_snapshot_ref: input.workspace_snapshot_ref,
		repo_path: input.repo_path,
		commit_sha: input.commit_sha,
		remote: input.remote,
		refspec: input.refspec,
	});
}

export function createPublishActionDigest(input: PublishActionDigestInput): string {
	return semanticDigest("git-delivery/publish", {
		task_id: input.task_id,
		task_revision: input.task_revision,
		acceptance_id: input.acceptance_id,
		evidence_id: input.evidence_id,
		delivery_evidence_package_digest: input.delivery_evidence_package_digest,
		workspace_snapshot_ref: input.workspace_snapshot_ref,
		commit_sha: input.commit_sha,
		package_name: input.package_name,
		version: input.version,
		registry: input.registry,
	});
}

function defaultGitRunner(request: GitCommandRequest): GitCommandResult {
	const result = spawnSync("git", request.args, { cwd: request.cwd, encoding: "utf8" });
	if (result.error) return { exit_code: 1, stdout: result.stdout ?? "", stderr: result.error.message };
	return {
		exit_code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function digestBinding(binding: CanonicalDeliveryBinding): DeliveryDigestBinding {
	return {
		task_id: binding.task.id,
		task_revision: binding.task.task_revision,
		acceptance_id: binding.acceptance.id,
		evidence_id: binding.evidence.id,
		delivery_evidence_package_digest: binding.package_digest,
		workspace_snapshot_ref: binding.delivery_package.workspace_snapshot_ref,
	};
}

function roleProfile(state: ReturnType<PersistentStateStore["read"]>, task: TaskRecord): RoleProfile | undefined {
	if (!task.role_profile_ref) return undefined;
	const role =
		state.role_profiles.find((candidate) => candidate.id === task.role_profile_ref) ??
		DEFAULT_ROLE_PROFILES.find((candidate) => candidate.id === task.role_profile_ref);
	if (!role) throw new Error(`task role profile is not registered: ${task.role_profile_ref}`);
	return structuredClone(role);
}

function resolveCanonicalBinding(store: PersistentStateStore, taskId: string): CanonicalDeliveryBinding {
	const state = store.read();
	const task = state.tasks.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);
	if (task.state !== "DONE") throw new Error(`git delivery requires accepted DONE task: ${taskId}`);
	const ledgerBindings = state.task_ledger.filter((candidate) => candidate.pph_task_id === taskId);
	if (ledgerBindings.length !== 1) throw new Error(`task must have exactly one registered project binding: ${taskId}`);
	const ledgerBinding = ledgerBindings[0];
	if (!ledgerBinding) throw new Error(`task project binding disappeared: ${taskId}`);
	const project = state.projects.find((candidate) => candidate.project_id === ledgerBinding.project_id);
	if (!project) throw new Error(`task project binding references unknown project: ${ledgerBinding.project_id}`);
	const acceptance = state.acceptances.find(
		(candidate) => candidate.task_id === task.id && candidate.task_revision === task.task_revision,
	);
	if (!acceptance) throw new Error(`task is missing current Acceptance: ${task.id}@${task.task_revision}`);
	if (!acceptance.evidence_id) throw new Error(`Acceptance is missing Evidence binding: ${acceptance.id}`);
	const evidence = state.evidence.find((candidate) => candidate.id === acceptance.evidence_id);
	if (!evidence || evidence.task_id !== task.id || evidence.run_id !== acceptance.run_id)
		throw new Error(`Acceptance Evidence binding is invalid: ${acceptance.id}`);
	const packageValidation = validateDeliveryEvidencePackage(evidence.delivery_evidence_package);
	if (!packageValidation.valid || !packageValidation.value)
		throw new Error(`Acceptance is missing valid standardized Evidence package: ${acceptance.id}`);
	const deliveryPackage = packageValidation.value;
	const packageDigest = deliveryEvidencePackageDigest(deliveryPackage);
	const verification = state.verifications.find((candidate) => candidate.id === acceptance.verification_id);
	if (
		!verification ||
		verification.task_id !== task.id ||
		verification.task_revision !== task.task_revision ||
		verification.status !== "PASS" ||
		verification.evidence_id !== evidence.id ||
		verification.delivery_evidence_package_digest !== packageDigest
	)
		throw new Error(`Acceptance is not backed by canonical Verification PASS: ${acceptance.id}`);
	const verificationSnapshot: WorkspaceSnapshot = {
		commit_hash: verification.commit_hash,
		diff_digest: verification.diff_digest,
		artifact_digest: verification.artifact_digest,
	};
	if (
		deliveryPackage.task_revision !== task.task_revision ||
		deliveryPackage.actual_diff.digest !== verification.diff_digest ||
		deliveryPackage.artifact_digest !== verification.artifact_digest ||
		deliveryPackage.workspace_snapshot_ref !== workspaceSnapshotRef(verificationSnapshot)
	)
		throw new Error(`standardized Evidence package snapshot binding is stale: ${evidence.id}`);
	if (deliveryPackage.baseline_commit !== project.baseline_commit)
		throw new Error(`standardized Evidence package baseline does not match registered project: ${evidence.id}`);
	if (acceptance.provider_mode !== deliveryPackage.provider_mode)
		throw new Error(`Acceptance provider_mode does not match standardized Evidence: ${acceptance.id}`);
	return {
		task: structuredClone(task),
		acceptance: structuredClone(acceptance),
		evidence: structuredClone(evidence),
		delivery_package: structuredClone(deliveryPackage),
		package_digest: packageDigest,
		verification: structuredClone(verification),
		project: structuredClone(project),
		role: roleProfile(state, task),
	};
}

function permissionFailure(binding: CanonicalDeliveryBinding, action: HumanApprovalAction): string | undefined {
	const decision = evaluateTaskPermissions(binding.task, { git: [action] }, binding.role);
	return decision.allowed ? undefined : decision.reasons.join("; ");
}

function approvalFor(
	store: PersistentStateStore,
	binding: CanonicalDeliveryBinding,
	approvalId: string,
	action: HumanApprovalAction,
	actionDigest: string,
	now: string,
): HumanApprovalRecord {
	const approval = store.getHumanApproval(approvalId);
	if (!approval) throw new Error(`unknown human approval: ${approvalId}`);
	assertHumanApprovalAuthorizes(approval, {
		task_id: binding.task.id,
		task_revision: binding.task.task_revision,
		action,
		action_digest: actionDigest,
		now,
	});
	if (store.listDeliveryActions().some((record) => record.approval_id === approval.id))
		throw new Error(`human approval has already been consumed: ${approval.id}`);
	return approval;
}

export class GitDeliveryExecutor {
	private readonly store: PersistentStateStore;
	private readonly gitRunner: GitCommandRunner;
	private readonly publisher?: DeliveryPublisher;
	private readonly clock: () => string;

	constructor(options: GitDeliveryExecutorOptions) {
		this.store = options.state_store;
		this.gitRunner = options.git_runner ?? defaultGitRunner;
		this.publisher = options.publisher;
		this.clock = options.now ?? (() => new Date().toISOString());
	}

	expectedCommitActionDigest(taskId: string, message: string): string {
		const binding = resolveCanonicalBinding(this.store, taskId);
		return createCommitActionDigest({
			...digestBinding(binding),
			repo_path: binding.project.repo_path,
			parent_sha: binding.verification.commit_hash,
			scope_files: normalizedScope(binding.task.scope.files),
			message: nonEmpty(message, "commit message"),
		});
	}

	expectedPushActionDigest(taskId: string, commitSha: string, remote: string, refspec: string): string {
		const binding = resolveCanonicalBinding(this.store, taskId);
		return createPushActionDigest({
			...digestBinding(binding),
			repo_path: binding.project.repo_path,
			commit_sha: nonEmpty(commitSha, "push commit_sha"),
			remote: nonEmpty(remote, "push remote"),
			refspec: nonEmpty(refspec, "push refspec"),
		});
	}

	expectedPublishActionDigest(
		taskId: string,
		commitSha: string,
		packageName: string,
		version: string,
		registry: string,
	): string {
		const binding = resolveCanonicalBinding(this.store, taskId);
		return createPublishActionDigest({
			...digestBinding(binding),
			commit_sha: nonEmpty(commitSha, "publish commit_sha"),
			package_name: nonEmpty(packageName, "publish package_name"),
			version: nonEmpty(version, "publish version"),
			registry: nonEmpty(registry, "publish registry"),
		});
	}

	async executeCommit(request: ExecuteCommitRequest): Promise<DeliveryActionRecord> {
		const binding = resolveCanonicalBinding(this.store, request.task_id);
		const scopeFiles = normalizedScope(binding.task.scope.files);
		const message = nonEmpty(request.message, "commit message");
		const actionDigest = createCommitActionDigest({
			...digestBinding(binding),
			repo_path: binding.project.repo_path,
			parent_sha: binding.verification.commit_hash,
			scope_files: scopeFiles,
			message,
		});
		const now = this.clock();
		const approval = approvalFor(this.store, binding, request.approval_id, "commit", actionDigest, now);
		const base = {
			task_id: binding.task.id,
			task_revision: binding.task.task_revision,
			action: "commit" as const,
			approval_id: approval.id,
			action_digest: actionDigest,
			acceptance_id: binding.acceptance.id,
			evidence_id: binding.evidence.id,
			delivery_evidence_package_digest: binding.package_digest,
			attempted_at: now,
			repo_path: binding.project.repo_path,
			scope_files: scopeFiles,
			parent_sha: binding.verification.commit_hash,
		};
		const denied = permissionFailure(binding, "commit");
		if (denied) return this.saveCommit({ ...base, status: "BLOCKED", detail: `permission denied: ${denied}` });
		try {
			await this.assertRepositoryBinding(binding.project);
			const snapshotFailure = await this.commitSnapshotFailure(binding);
			if (snapshotFailure) return this.saveCommit({ ...base, status: "BLOCKED", detail: snapshotFailure });
			const preStagedFailure = await this.stagedScopeFailure(binding.project.repo_path, scopeFiles);
			if (preStagedFailure) return this.saveCommit({ ...base, status: "BLOCKED", detail: preStagedFailure });
			const add = await this.runGit(binding.project.repo_path, ["add", "--", ...scopeFiles]);
			if (add.exit_code !== 0)
				return this.saveCommit({
					...base,
					status: "FAILED",
					detail: `git add failed: ${this.commandDetail(add)}`,
				});
			const postStagedFailure = await this.stagedScopeFailure(binding.project.repo_path, scopeFiles);
			if (postStagedFailure) return this.saveCommit({ ...base, status: "BLOCKED", detail: postStagedFailure });
			const staged = await this.stagedPaths(binding.project.repo_path);
			if (staged.length === 0)
				return this.saveCommit({
					...base,
					status: "BLOCKED",
					detail: "no Task-scoped changes are staged for commit",
				});
			const commit = await this.runGit(binding.project.repo_path, ["commit", "-m", message]);
			if (commit.exit_code !== 0)
				return this.saveCommit({
					...base,
					status: "FAILED",
					detail: `git commit failed: ${this.commandDetail(commit)}`,
				});
			const commitSha = await this.gitValue(binding.project.repo_path, ["rev-parse", "HEAD"], "commit result SHA");
			const parentSha = await this.gitValue(
				binding.project.repo_path,
				["rev-parse", `${commitSha}^`],
				"commit parent SHA",
			);
			if (parentSha !== binding.verification.commit_hash)
				return this.saveCommit({
					...base,
					parent_sha: parentSha,
					status: "FAILED",
					commit_sha: commitSha,
					detail: `commit parent changed during delivery: expected ${binding.verification.commit_hash}, got ${parentSha}`,
				});
			return this.saveCommit({
				...base,
				status: "COMMITTED",
				commit_sha: commitSha,
				detail: "Task-scoped commit completed",
			});
		} catch (error) {
			return this.saveCommit({ ...base, status: "FAILED", detail: this.errorDetail(error) });
		}
	}

	async executePush(request: ExecutePushRequest): Promise<DeliveryActionRecord> {
		const binding = resolveCanonicalBinding(this.store, request.task_id);
		const commitSha = nonEmpty(request.commit_sha, "push commit_sha");
		const remote = nonEmpty(request.remote, "push remote");
		const refspec = nonEmpty(request.refspec, "push refspec");
		const actionDigest = createPushActionDigest({
			...digestBinding(binding),
			repo_path: binding.project.repo_path,
			commit_sha: commitSha,
			remote,
			refspec,
		});
		const now = this.clock();
		const approval = approvalFor(this.store, binding, request.approval_id, "push", actionDigest, now);
		const base = {
			task_id: binding.task.id,
			task_revision: binding.task.task_revision,
			action: "push" as const,
			approval_id: approval.id,
			action_digest: actionDigest,
			acceptance_id: binding.acceptance.id,
			evidence_id: binding.evidence.id,
			delivery_evidence_package_digest: binding.package_digest,
			attempted_at: now,
			repo_path: binding.project.repo_path,
			commit_sha: commitSha,
			remote,
			refspec,
		};
		const denied = permissionFailure(binding, "push");
		if (denied) return this.saveAction({ ...base, status: "BLOCKED", detail: `permission denied: ${denied}` });
		try {
			await this.assertRepositoryBinding(binding.project);
			const commitFailure = await this.deliveryCommitFailure(binding, commitSha);
			if (commitFailure) return this.saveAction({ ...base, status: "BLOCKED", detail: commitFailure });
			const pushed = await this.runGit(binding.project.repo_path, ["push", "--", remote, refspec]);
			return this.saveAction({
				...base,
				status: pushed.exit_code === 0 ? "PUSHED" : "FAILED",
				detail:
					pushed.exit_code === 0
						? "exact commit/refspec push completed"
						: `git push failed: ${this.commandDetail(pushed)}`,
			});
		} catch (error) {
			return this.saveAction({ ...base, status: "FAILED", detail: this.errorDetail(error) });
		}
	}

	async executePublish(request: ExecutePublishRequest): Promise<DeliveryActionRecord> {
		const binding = resolveCanonicalBinding(this.store, request.task_id);
		const commitSha = nonEmpty(request.commit_sha, "publish commit_sha");
		const packageName = nonEmpty(request.package_name, "publish package_name");
		const version = nonEmpty(request.version, "publish version");
		const registry = nonEmpty(request.registry, "publish registry");
		const actionDigest = createPublishActionDigest({
			...digestBinding(binding),
			commit_sha: commitSha,
			package_name: packageName,
			version,
			registry,
		});
		const now = this.clock();
		const approval = approvalFor(this.store, binding, request.approval_id, "publish", actionDigest, now);
		const base = {
			task_id: binding.task.id,
			task_revision: binding.task.task_revision,
			action: "publish" as const,
			approval_id: approval.id,
			action_digest: actionDigest,
			acceptance_id: binding.acceptance.id,
			evidence_id: binding.evidence.id,
			delivery_evidence_package_digest: binding.package_digest,
			attempted_at: now,
			commit_sha: commitSha,
			package_name: packageName,
			version,
			registry,
		};
		const denied = permissionFailure(binding, "publish");
		if (denied) return this.saveAction({ ...base, status: "BLOCKED", detail: `permission denied: ${denied}` });
		try {
			await this.assertRepositoryBinding(binding.project);
			const commitFailure = await this.deliveryCommitFailure(binding, commitSha);
			if (commitFailure) return this.saveAction({ ...base, status: "BLOCKED", detail: commitFailure });
			if (!this.publisher)
				return this.saveAction({ ...base, status: "BLOCKED", detail: "publish runner is not configured" });
			const published = await this.publisher({
				repo_path: binding.project.repo_path,
				commit_sha: commitSha,
				package_name: packageName,
				version,
				registry,
			});
			return this.saveAction({
				...base,
				status: published.ok ? "PUBLISHED" : "FAILED",
				detail: published.ok
					? (published.detail ?? "exact package publish completed")
					: (published.detail ?? "publish failed"),
			});
		} catch (error) {
			return this.saveAction({ ...base, status: "FAILED", detail: this.errorDetail(error) });
		}
	}

	private async assertRepositoryBinding(project: ProjectRecord): Promise<void> {
		let realProjectPath: string;
		try {
			realProjectPath = realpathSync(project.repo_path);
		} catch (error) {
			throw new Error(`registered project repo is unavailable: ${this.errorDetail(error)}`);
		}
		const gitRoot = await this.gitValue(realProjectPath, ["rev-parse", "--show-toplevel"], "git repository root");
		if (realpathSync(gitRoot) !== realProjectPath)
			throw new Error(`registered project repo does not match git root: ${project.repo_path}`);
	}

	private async commitSnapshotFailure(binding: CanonicalDeliveryBinding): Promise<string | undefined> {
		const head = await this.gitValue(binding.project.repo_path, ["rev-parse", "HEAD"], "current HEAD");
		const status = await this.runGit(binding.project.repo_path, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]);
		if (status.exit_code !== 0) throw new Error(`git status failed: ${this.commandDetail(status)}`);
		const changedFiles = status.stdout
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.slice(3))
			.sort();
		const snapshot = captureWorkspaceSnapshot(head, changedFiles, binding.evidence.artifacts);
		if (head !== binding.verification.commit_hash)
			return "workspace HEAD no longer matches accepted Verification snapshot";
		if (workspaceSnapshotRef(snapshot) !== binding.delivery_package.workspace_snapshot_ref)
			return "workspace snapshot no longer matches accepted delivery Evidence package";
		return undefined;
	}

	private async deliveryCommitFailure(
		binding: CanonicalDeliveryBinding,
		commitSha: string,
	): Promise<string | undefined> {
		const committed = this.store
			.listDeliveryActions(binding.task.id, "commit")
			.find(
				(record) =>
					record.action === "commit" &&
					record.status === "COMMITTED" &&
					record.commit_sha === commitSha &&
					record.acceptance_id === binding.acceptance.id &&
					record.evidence_id === binding.evidence.id &&
					record.delivery_evidence_package_digest === binding.package_digest &&
					record.repo_path === binding.project.repo_path,
			);
		if (!committed || committed.action !== "commit" || committed.status !== "COMMITTED")
			return `commit ${commitSha} is not a canonical COMMITTED delivery for this Acceptance`;
		const head = await this.gitValue(binding.project.repo_path, ["rev-parse", "HEAD"], "current HEAD");
		if (head !== commitSha) return `current HEAD does not match approved delivery commit ${commitSha}`;
		const parent = await this.gitValue(
			binding.project.repo_path,
			["rev-parse", `${commitSha}^`],
			"delivery commit parent",
		);
		if (parent !== binding.verification.commit_hash || committed.parent_sha !== binding.verification.commit_hash)
			return `delivery commit ${commitSha} is not based on the accepted Verification snapshot`;
		return undefined;
	}

	private async stagedScopeFailure(repoPath: string, scopeFiles: readonly string[]): Promise<string | undefined> {
		const staged = await this.stagedPaths(repoPath);
		if (staged.length === 0) return undefined;
		const scoped = await this.gitPaths(repoPath, ["diff", "--cached", "--name-only", "-z", "--", ...scopeFiles]);
		const scopedSet = new Set(scoped);
		const outside = staged.filter((path) => !scopedSet.has(path));
		return outside.length > 0 ? `out-of-scope paths are already staged: ${outside.join(", ")}` : undefined;
	}

	private async stagedPaths(repoPath: string): Promise<string[]> {
		return await this.gitPaths(repoPath, ["diff", "--cached", "--name-only", "-z"]);
	}

	private async gitPaths(repoPath: string, args: string[]): Promise<string[]> {
		const result = await this.runGit(repoPath, args);
		if (result.exit_code !== 0) throw new Error(`git ${args[0] ?? "command"} failed: ${this.commandDetail(result)}`);
		return result.stdout.split("\0").filter(Boolean).sort();
	}

	private async gitValue(repoPath: string, args: string[], field: string): Promise<string> {
		const result = await this.runGit(repoPath, args);
		if (result.exit_code !== 0) throw new Error(`${field} unavailable: ${this.commandDetail(result)}`);
		const value = result.stdout.trim();
		if (!value) throw new Error(`${field} must not be empty`);
		return value;
	}

	private async runGit(repoPath: string, args: string[]): Promise<GitCommandResult> {
		return await this.gitRunner({ cwd: repoPath, args: [...args] });
	}

	private commandDetail(result: GitCommandResult): string {
		return (result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(0, 512);
	}

	private errorDetail(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).trim().slice(0, 512) || "delivery action failed";
	}

	private saveCommit(input: CommitDeliveryActionInput): DeliveryActionRecord {
		return this.store.saveDeliveryAction(createDeliveryActionRecord(input));
	}

	private saveAction(input: NonCommitDeliveryActionInput): DeliveryActionRecord {
		return this.store.saveDeliveryAction(createDeliveryActionRecord(input));
	}
}
