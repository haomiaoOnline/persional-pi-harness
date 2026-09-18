import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { PersistentStateStore } from "./persistence.ts";
import type { ProjectRecord } from "./types.ts";

export type ProjectBaselineVerifier = (repoPath: string, baselineCommit: string) => boolean;

export interface ProjectRegistryOptions {
	baseline_verifier?: ProjectBaselineVerifier;
}

export class ProjectRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectRegistryError";
	}
}

export const gitProjectBaselineVerifier: ProjectBaselineVerifier = (repoPath, baselineCommit) => {
	const result = spawnSync(
		"git",
		["-C", repoPath, "rev-parse", "--verify", "--quiet", "--end-of-options", `${baselineCommit}^{commit}`],
		{ stdio: "ignore" },
	);
	return result.status === 0;
};

function requiredField(value: string, field: keyof ProjectRecord): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new ProjectRegistryError(`${field} must not be empty`);
	return normalized;
}

function normalizeProject(project: ProjectRecord): ProjectRecord {
	return {
		project_id: requiredField(project.project_id, "project_id"),
		repo_path: resolve(requiredField(project.repo_path, "repo_path")),
		baseline_commit: requiredField(project.baseline_commit, "baseline_commit"),
		architecture_doc_ref: requiredField(project.architecture_doc_ref, "architecture_doc_ref"),
		task_ledger_ref: requiredField(project.task_ledger_ref, "task_ledger_ref"),
	};
}

export class ProjectRegistry {
	private readonly store: PersistentStateStore;
	private readonly baselineVerifier: ProjectBaselineVerifier;

	constructor(store: PersistentStateStore, options: ProjectRegistryOptions = {}) {
		this.store = store;
		this.baselineVerifier = options.baseline_verifier ?? gitProjectBaselineVerifier;
	}

	register(project: ProjectRecord): ProjectRecord {
		const normalized = normalizeProject(project);
		if (this.store.getProject(normalized.project_id))
			throw new ProjectRegistryError(`project_id already registered: ${normalized.project_id}`);
		if (this.store.listProjects().some((candidate) => candidate.repo_path === normalized.repo_path))
			throw new ProjectRegistryError(`repo_path already registered: ${normalized.repo_path}`);
		this.assertBaselineExists(normalized);
		return this.store.addProject(normalized);
	}

	resolve(projectId: string): ProjectRecord {
		const normalizedId = requiredField(projectId, "project_id");
		const project = this.store.getProject(normalizedId);
		if (!project) throw new ProjectRegistryError(`unknown project_id: ${normalizedId}`);
		this.assertBaselineExists(project);
		return project;
	}

	private assertBaselineExists(project: ProjectRecord): void {
		if (this.baselineVerifier(project.repo_path, project.baseline_commit)) return;
		throw new ProjectRegistryError(
			`baseline_commit does not exist in repo: ${project.project_id} (${project.baseline_commit})`,
		);
	}
}
