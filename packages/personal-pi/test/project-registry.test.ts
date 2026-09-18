import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PersistentStateStore, type ProjectRegistrationInput, ProjectRegistry } from "../src/index.ts";

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

function project(repoPath: string, baselineCommit: string): ProjectRegistrationInput {
	return {
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
	test("validates coordinates, generates project_id, and rejects duplicate identity or repo_path", () => {
		const registry = new ProjectRegistry(new PersistentStateStore(), { baseline_resolver: (_repoPath, ref) => ref });
		const base = project(temporaryDirectory("personal-pi-project-coordinates-"), "baseline-a");
		const fields: (keyof ProjectRegistrationInput)[] = [
			"repo_path",
			"baseline_commit",
			"architecture_doc_ref",
			"task_ledger_ref",
		];
		for (const field of fields)
			expect(() => registry.register({ ...base, [field]: "   " })).toThrow(`${field} must not be empty`);

		const registered = registry.register(base);
		expect(registered.project_id).toMatch(/^project-[0-9a-f]{24}$/);
		expect(() => registry.register({ ...base, task_ledger_ref: "docs/other-ledger.md" })).toThrow(
			"project_id already registered",
		);
		expect(() => registry.register({ ...base, architecture_doc_ref: "docs/architecture-v2.md" })).toThrow(
			"repo_path already registered",
		);
		expect(() => registry.register({ ...base, repo_path: join(base.repo_path, "missing") })).toThrow(
			"repo_path does not exist",
		);
	});

	test("generates the same id for the same canonical identity and excludes task_ledger_ref from identity", () => {
		const repoPath = temporaryDirectory("personal-pi-project-identity-");
		const baselineResolver = (_repoPath: string, ref: string) => ref;
		const base = project(repoPath, "baseline-a");
		const first = new ProjectRegistry(new PersistentStateStore(), { baseline_resolver: baselineResolver }).register(
			base,
		);
		const second = new ProjectRegistry(new PersistentStateStore(), { baseline_resolver: baselineResolver }).register({
			...base,
			task_ledger_ref: "docs/relocated-ledger.md",
		});
		const third = new ProjectRegistry(new PersistentStateStore(), { baseline_resolver: baselineResolver }).register({
			...base,
			architecture_doc_ref: "docs/architecture-v2.md",
		});

		expect(second.project_id).toBe(first.project_id);
		expect(third.project_id).not.toBe(first.project_id);
	});

	test("resolves mutable baseline refs to immutable commit ids before generating project identity", () => {
		const repository = createGitRepository("symbolic-baseline");
		const fromHead = new ProjectRegistry(new PersistentStateStore()).register(project(repository.path, "HEAD"));
		const fromOid = new ProjectRegistry(new PersistentStateStore()).register(
			project(repository.path, repository.baseline),
		);

		expect(fromHead.baseline_commit).toBe(repository.baseline);
		expect(fromHead.project_id).toBe(fromOid.project_id);
	});

	test("verifies baseline existence on registration and lookup through an injectable resolver", () => {
		let baselineAvailable = true;
		let checks = 0;
		const registry = new ProjectRegistry(new PersistentStateStore(), {
			baseline_resolver: (_repoPath, ref) => {
				checks += 1;
				return baselineAvailable ? ref : undefined;
			},
		});
		const record = project(temporaryDirectory("personal-pi-project-injected-"), "baseline-a");
		const registered = registry.register(record);
		expect(registered.baseline_commit).toBe("baseline-a");
		expect(checks).toBe(1);
		expect(registry.resolve(registered.project_id).baseline_commit).toBe("baseline-a");
		expect(checks).toBe(2);

		baselineAvailable = false;
		expect(() => registry.resolve(registered.project_id)).toThrow("baseline_commit does not exist in repo");
		expect(checks).toBe(3);
	});

	test("persists two distinct real git repositories without crossing project coordinates", () => {
		const repositoryA = createGitRepository("a");
		const repositoryB = createGitRepository("b");
		const statePath = join(temporaryDirectory("personal-pi-project-state-"), "state.json");
		const registry = new ProjectRegistry(new PersistentStateStore(statePath));
		const projectA = registry.register(project(repositoryA.path, repositoryA.baseline));
		const projectB = registry.register(project(repositoryB.path, repositoryB.baseline));

		expect(projectA.repo_path).toBe(realpathSync(repositoryA.path));
		expect(projectB.repo_path).toBe(realpathSync(repositoryB.path));
		expect(projectA.baseline_commit).not.toBe(projectB.baseline_commit);
		expect(projectA.project_id).not.toBe(projectB.project_id);

		const restarted = new ProjectRegistry(new PersistentStateStore(statePath));
		expect(restarted.resolve(projectA.project_id)).toEqual(projectA);
		expect(restarted.resolve(projectB.project_id)).toEqual(projectB);
		expect(restarted.resolve(projectA.project_id).repo_path).not.toBe(
			restarted.resolve(projectB.project_id).repo_path,
		);
	});

	test("rejects a baseline commit that is absent from the registered repository", () => {
		const repository = createGitRepository("missing-baseline");
		const registry = new ProjectRegistry(new PersistentStateStore());
		expect(() => registry.register(project(repository.path, "0000000000000000000000000000000000000000"))).toThrow(
			"baseline_commit does not exist in repo",
		);
	});
});
