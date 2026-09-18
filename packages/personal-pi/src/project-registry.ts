import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { PersistentStateStore } from "./persistence.ts";
import type { ProjectRecord } from "./types.ts";

export type ProjectRegistrationInput = Omit<ProjectRecord, "project_id">;
export type ProjectBaselineResolver = (repoPath: string, baselineCommit: string) => string | undefined;

export interface ProjectRegistryOptions {
	baseline_resolver?: ProjectBaselineResolver;
}

export class ProjectRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectRegistryError";
	}
}

export const gitProjectBaselineResolver: ProjectBaselineResolver = (repoPath, baselineCommit) => {
	const result = spawnSync(
		"git",
		["-C", repoPath, "rev-parse", "--verify", "--quiet", "--end-of-options", `${baselineCommit}^{commit}`],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) return undefined;
	const resolvedCommit = result.stdout.trim();
	return resolvedCommit.length > 0 ? resolvedCommit : undefined;
};

function requiredField(value: string, field: keyof ProjectRecord): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new ProjectRegistryError(`${field} must not be empty`);
	return normalized;
}

function normalizeRegistration(project: ProjectRegistrationInput): ProjectRegistrationInput {
	const requestedRepoPath = resolve(requiredField(project.repo_path, "repo_path"));
	let repoPath: string;
	try {
		repoPath = realpathSync(requestedRepoPath);
	} catch {
		throw new ProjectRegistryError(`repo_path does not exist: ${requestedRepoPath}`);
	}
	return {
		repo_path: repoPath,
		baseline_commit: requiredField(project.baseline_commit, "baseline_commit"),
		architecture_doc_ref: requiredField(project.architecture_doc_ref, "architecture_doc_ref"),
		task_ledger_ref: requiredField(project.task_ledger_ref, "task_ledger_ref"),
	};
}

function generateProjectId(project: ProjectRegistrationInput): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([project.repo_path, project.baseline_commit, project.architecture_doc_ref]))
		.digest("hex");
	return `project-${digest.slice(0, 24)}`;
}

export class ProjectRegistry {
	private readonly store: PersistentStateStore;
	private readonly baselineResolver: ProjectBaselineResolver;

	constructor(store: PersistentStateStore, options: ProjectRegistryOptions = {}) {
		this.store = store;
		this.baselineResolver = options.baseline_resolver ?? gitProjectBaselineResolver;
	}

	register(project: ProjectRegistrationInput): ProjectRecord {
		const normalized = normalizeRegistration(project);
		const resolvedBaseline = this.baselineResolver(normalized.repo_path, normalized.baseline_commit);
		if (!resolvedBaseline)
			throw new ProjectRegistryError(
				`baseline_commit does not exist in repo: ${normalized.repo_path} (${normalized.baseline_commit})`,
			);
		const record: ProjectRecord = {
			...normalized,
			baseline_commit: resolvedBaseline,
			project_id: generateProjectId({ ...normalized, baseline_commit: resolvedBaseline }),
		};
		if (this.store.getProject(record.project_id))
			throw new ProjectRegistryError(`project_id already registered: ${record.project_id}`);
		if (this.store.listProjects().some((candidate) => candidate.repo_path === record.repo_path))
			throw new ProjectRegistryError(`repo_path already registered: ${record.repo_path}`);
		return this.store.addProject(record);
	}

	resolve(projectId: string): ProjectRecord {
		const normalizedId = requiredField(projectId, "project_id");
		const project = this.store.getProject(normalizedId);
		if (!project) throw new ProjectRegistryError(`unknown project_id: ${normalizedId}`);
		this.assertBaselineExists(project);
		return project;
	}

	private assertBaselineExists(project: ProjectRecord): void {
		if (this.baselineResolver(project.repo_path, project.baseline_commit) === project.baseline_commit) return;
		throw new ProjectRegistryError(
			`baseline_commit does not exist in repo: ${project.project_id} (${project.baseline_commit})`,
		);
	}
}
