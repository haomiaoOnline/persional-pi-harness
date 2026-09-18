import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PersistentStateStore, type ProjectRecord, ProjectRegistry } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function createGitRepository(label: string): { path: string; baseline: string } {
	const path = temporaryDirectory(`personal-pi-project-${label}-`);
	execFileSync("git", ["init", "-q"], { cwd: path });
	writeFileSync(join(path, "README.md"), `${label}\n`, "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: path });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Personal PI Test",
			"-c",
			"user.email=personal-pi-test@localhost",
			"commit",
			"-q",
			"-m",
			`baseline ${label}`,
		],
		{ cwd: path },
	);
	const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
	return { path, baseline };
}

function project(projectId: string, repoPath: string, baselineCommit: string): ProjectRecord {
	return {
		project_id: projectId,
		repo_path: repoPath,
		baseline_commit: baselineCommit,
		architecture_doc_ref: "docs/architecture.md",
		task_ledger_ref: "docs/task-ledger.md",
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T2.7-A Project Registry", () => {
	test("validates coordinates and rejects duplicate project_id or repo_path", () => {
		const registry = new ProjectRegistry(new PersistentStateStore(), { baseline_verifier: () => true });
		const base = project("project-a", temporaryDirectory("personal-pi-project-coordinates-"), "baseline-a");
		const fields: (keyof ProjectRecord)[] = [
			"project_id",
			"repo_path",
			"baseline_commit",
			"architecture_doc_ref",
			"task_ledger_ref",
		];
		for (const field of fields)
			expect(() => registry.register({ ...base, [field]: "   " })).toThrow(`${field} must not be empty`);

		const registered = registry.register(base);
		expect(registered.project_id).toBe("project-a");
		expect(() =>
			registry.register({ ...base, repo_path: temporaryDirectory("personal-pi-project-duplicate-id-") }),
		).toThrow("project_id already registered");
		expect(() => registry.register({ ...base, project_id: "project-b" })).toThrow("repo_path already registered");
	});

	test("verifies baseline existence on registration and lookup through an injectable verifier", () => {
		let baselineAvailable = true;
		let checks = 0;
		const registry = new ProjectRegistry(new PersistentStateStore(), {
			baseline_verifier: () => {
				checks += 1;
				return baselineAvailable;
			},
		});
		const record = project("project-a", temporaryDirectory("personal-pi-project-injected-"), "baseline-a");
		expect(registry.register(record).project_id).toBe("project-a");
		expect(checks).toBe(1);
		expect(registry.resolve("project-a").baseline_commit).toBe("baseline-a");
		expect(checks).toBe(2);

		baselineAvailable = false;
		expect(() => registry.resolve("project-a")).toThrow("baseline_commit does not exist in repo");
		expect(checks).toBe(3);
	});

	test("persists two distinct real git repositories without crossing project coordinates", () => {
		const repositoryA = createGitRepository("a");
		const repositoryB = createGitRepository("b");
		const statePath = join(temporaryDirectory("personal-pi-project-state-"), "state.json");
		const registry = new ProjectRegistry(new PersistentStateStore(statePath));
		const projectA = registry.register(project("project-a", repositoryA.path, repositoryA.baseline));
		const projectB = registry.register(project("project-b", repositoryB.path, repositoryB.baseline));

		expect(projectA.repo_path).toBe(repositoryA.path);
		expect(projectB.repo_path).toBe(repositoryB.path);
		expect(projectA.baseline_commit).not.toBe(projectB.baseline_commit);

		const restarted = new ProjectRegistry(new PersistentStateStore(statePath));
		expect(restarted.resolve("project-a")).toEqual(projectA);
		expect(restarted.resolve("project-b")).toEqual(projectB);
		expect(restarted.resolve("project-a").repo_path).not.toBe(restarted.resolve("project-b").repo_path);
	});

	test("rejects a baseline commit that is absent from the registered repository", () => {
		const repository = createGitRepository("missing-baseline");
		const registry = new ProjectRegistry(new PersistentStateStore());
		expect(() =>
			registry.register(project("project-a", repository.path, "0000000000000000000000000000000000000000")),
		).toThrow("baseline_commit does not exist in repo");
	});
});
