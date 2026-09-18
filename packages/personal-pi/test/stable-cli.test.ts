import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	PersistentStateStore,
	runPersonalPiStableCli,
	TaskStateMachine,
	type WorkerAdapter,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "personal-pi-stable-cli-"));
	temporaryDirectories.push(path);
	return path;
}

function gitRepository(root: string): { path: string; baseline: string } {
	const path = join(root, "project");
	execFileSync("mkdir", ["-p", path]);
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.email", "stable-cli@example.com"]);
	execFileSync("git", ["-C", path, "config", "user.name", "Stable CLI Test"]);
	writeFileSync(join(path, "README.md"), "stable cli\n", "utf8");
	execFileSync("git", ["-C", path, "add", "README.md"]);
	execFileSync("git", ["-C", path, "commit", "-q", "-m", "initial"]);
	return { path, baseline: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

function parsed(result: Awaited<ReturnType<typeof runPersonalPiStableCli>>): Record<string, unknown> {
	expect(result.handled).toBe(true);
	expect(result.exit_code).toBe(0);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

function noOpWorker(): WorkerAdapter {
	return {
		worker_id: "stable-cli-test-worker",
		async execute(request: WorkerProtocolRequest) {
			return {
				task_id: request.task.id,
				run_id: request.run_id ?? "missing-run",
				worker_id: "stable-cli-test-worker",
				lease_epoch: request.protocol.lease_epoch,
				status: "success" as const,
				summary: "verified no-op",
				changed_files: [],
				artifacts: [],
				evidence: [],
				errors: [],
				work_receipt: {
					work_attempted: true,
					effects_count: 0,
					artifacts_created: [],
					state_changed: false,
					no_op: true,
					no_op_reason: "task required no workspace change",
					evidence_refs: [],
				},
			};
		},
	};
}

function taskSpec(path: string): void {
	const {
		id: _id,
		schema_version: _schemaVersion,
		...spec
	} = makeV3Task("external-spec", {
		role_profile_ref: "backend-engineer",
		execution: { ...makeV3Task("external-spec").execution, allowed_tools: [] },
		verification: {
			strategy: "automated",
			commands: [],
			checks: [],
			evidence_required: [],
			strength: "strong",
		},
	});
	writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("T2.7-C stable CLI", () => {
	test("serves all six command families through governed state and pipeline paths", async () => {
		const root = temporaryDirectory();
		const repository = gitRepository(root);
		const statePath = join(root, "state.json");
		const specPath = join(root, "task.json");
		taskSpec(specPath);
		const options = {
			cwd: root,
			state_path: statePath,
			task_id_factory: () => "pph-stable-1",
			worker_factory: () => noOpWorker(),
		};

		const registered = parsed(
			await runPersonalPiStableCli(
				[
					"project",
					"register",
					"--repo",
					repository.path,
					"--baseline",
					repository.baseline,
					"--architecture",
					"ARCHITECTURE.md",
					"--ledger",
					"TASKS.md",
				],
				options,
			),
		);
		const projectId = registered.project_id as string;
		expect(projectId).toMatch(/^project-/);

		const created = parsed(
			await runPersonalPiStableCli(
				["task", "create", "--project", projectId, "--project-task", "T1.01", "--phase", "P0", "--spec", specPath],
				options,
			),
		);
		const createdTask = created.task as Record<string, unknown>;
		expect(createdTask.id).toBe("pph-stable-1");
		expect(createdTask.state).toBe("DRAFT");
		expect((createdTask.execution as Record<string, unknown>).working_directory).toBe(realpathSync(repository.path));

		const run = parsed(
			await runPersonalPiStableCli(
				["task", "run", "--task", "pph-stable-1", "--provider", "test", "--model", "test-model"],
				options,
			),
		);
		expect((run.task as Record<string, unknown>).state).toBe("DONE");
		const persisted = new PersistentStateStore(statePath).read();
		expect(persisted.dispatches).toHaveLength(1);
		expect(persisted.runs).toHaveLength(1);
		expect(persisted.loop_usage["pph-stable-1"]?.attempts).toBe(1);
		expect(persisted.acceptances).toHaveLength(1);

		const verified = parsed(await runPersonalPiStableCli(["task", "verify", "--task", "pph-stable-1"], options));
		expect((verified.verification as Record<string, unknown>).status).toBe("PASS");
		expect((verified.task as Record<string, unknown>).state).toBe("DONE");

		const inspected = parsed(await runPersonalPiStableCli(["task", "inspect", "--task", "pph-stable-1"], options));
		expect((inspected.task as Record<string, unknown>).id).toBe("pph-stable-1");
		const gate = parsed(await runPersonalPiStableCli(["gate", "status", "--task", "pph-stable-1"], options));
		expect(gate.gate_status).toBe("PASS");
	});

	test("inspect and gate status are physically read-only and stable across repeated calls", async () => {
		const root = temporaryDirectory();
		const repository = gitRepository(root);
		const statePath = join(root, "state.json");
		const store = new PersistentStateStore(statePath);
		store.addProject({
			project_id: "project-readonly",
			repo_path: repository.path,
			baseline_commit: repository.baseline,
			architecture_doc_ref: "ARCHITECTURE.md",
			task_ledger_ref: "TASKS.md",
		});
		const contract = makeV3Task("readonly-task", { role_profile_ref: "backend-engineer" });
		store.createTaskWithLedgerBinding(contract, {
			project_id: "project-readonly",
			project_task_id: "T1.02",
			pph_task_id: contract.id,
			phase: "P0",
			unknowns: [],
		});
		const before = readFileSync(statePath);
		const beforeStat = statSync(statePath, { bigint: true });
		chmodSync(statePath, 0o444);
		try {
			for (let iteration = 0; iteration < 3; iteration += 1) {
				parsed(
					await runPersonalPiStableCli(["task", "inspect", "--task", contract.id], {
						cwd: root,
						state_path: statePath,
					}),
				);
				parsed(
					await runPersonalPiStableCli(["gate", "status", "--task", contract.id], {
						cwd: root,
						state_path: statePath,
					}),
				);
			}
		} finally {
			chmodSync(statePath, 0o644);
		}
		const after = readFileSync(statePath);
		const afterStat = statSync(statePath, { bigint: true });
		expect(after).toEqual(before);
		expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);

		const readonlySource = readFileSync(join(process.cwd(), "src", "stable-cli-readonly.ts"), "utf8");
		expect(readonlySource).not.toMatch(/PersistentStateStore|transact|updateTask|acceptTask|probeWriteCapability/);
		const stateSource = readFileSync(join(process.cwd(), "src", "readonly-state.ts"), "utf8");
		expect(stateSource).not.toMatch(/writeFile|rename|mkdir|PersistentStateStore/);
	});

	test("explicit --accept is the only verify command path that can complete a VERIFYING task", async () => {
		const root = temporaryDirectory();
		const repository = gitRepository(root);
		const statePath = join(root, "state.json");
		const store = new PersistentStateStore(statePath);
		store.addProject({
			project_id: "project-accept",
			repo_path: repository.path,
			baseline_commit: repository.baseline,
			architecture_doc_ref: "ARCHITECTURE.md",
			task_ledger_ref: "TASKS.md",
		});
		let task = store.createTaskWithLedgerBinding(
			makeV3Task("verify-accept", {
				role_profile_ref: "backend-engineer",
				execution: { ...makeV3Task("verify-accept").execution, working_directory: repository.path },
				verification: {
					strategy: "automated",
					commands: [],
					checks: [],
					evidence_required: [],
					strength: "strong",
				},
			}),
			{
				project_id: "project-accept",
				project_task_id: "T1.03",
				pph_task_id: "verify-accept",
				phase: "P0",
				unknowns: [],
			},
		);
		const machine = new TaskStateMachine();
		task = store.updateTask(machine.transition(task, "READY"));
		task = store.updateTask(machine.transition(task, "RUNNING"));
		const run = store.createRun(task.id, "worker", 1);
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
			work_receipt: {
				work_attempted: true,
				effects_count: 0,
				artifacts_created: [],
				state_changed: false,
				no_op: true,
				no_op_reason: "nothing changed",
				evidence_refs: [],
			},
		});
		store.saveEvidence({
			id: "evidence-verify-accept",
			task_id: task.id,
			run_id: run.id,
			captured_at: new Date().toISOString(),
			diff: { files: [], digest: "ignored-by-verifier" },
			commands: [],
			stdout: "",
			stderr: "",
			artifacts: [],
			evidence_types: [],
		});
		store.updateTask(machine.transition(task, "VERIFYING"));

		const checked = parsed(
			await runPersonalPiStableCli(["task", "verify", "--task", task.id], { cwd: root, state_path: statePath }),
		);
		expect((checked.task as Record<string, unknown>).state).toBe("VERIFYING");
		const accepted = parsed(
			await runPersonalPiStableCli(["task", "verify", "--task", task.id, "--accept"], {
				cwd: root,
				state_path: statePath,
			}),
		);
		expect((accepted.task as Record<string, unknown>).state).toBe("DONE");
		expect(new PersistentStateStore(statePath).read().acceptances).toHaveLength(1);
	});

	test("management command errors never fall through to coding-agent prompt mode", async () => {
		const unknown = await runPersonalPiStableCli(["task", "repair"]);
		expect(unknown.handled).toBe(true);
		expect(unknown.exit_code).toBe(2);
		expect(unknown.stderr).toContain("unknown pph management command");

		for (const command of [
			["project", "register"],
			["task", "create"],
			["task", "run"],
			["task", "inspect"],
			["task", "verify"],
			["gate", "status"],
		] as const) {
			const missing = await runPersonalPiStableCli(command);
			expect(missing.handled, command.join(" ")).toBe(true);
			expect(missing.exit_code, command.join(" ")).toBe(2);
			expect(missing.stderr.length, command.join(" ")).toBeGreaterThan(0);
		}

		const ordinary = await runPersonalPiStableCli(["-p", "hello"]);
		expect(ordinary.handled).toBe(false);
	});
});
