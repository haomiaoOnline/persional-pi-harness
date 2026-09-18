import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ArtifactStore,
	CommandRiskClassifier,
	captureWorkspaceSnapshot,
	LifecycleHookManager,
	PersonalPiPipeline,
	PiWorker,
	type TaskContract,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, planFor, requirementFor } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

function fileBackedPipeline(): PersonalPiPipeline {
	const root = mkdtempSync(join(tmpdir(), "personal-pi-controls-"));
	temporaryDirectories.push(root);
	return new PersonalPiPipeline({ artifact_store: new ArtifactStore(root) });
}

function legalNoOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "verification-only control-path test",
		evidence_refs: ["worker_result"],
	};
}

function controlTask(id: string, command: string): TaskContract {
	return makeV3Task(id, {
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [command] },
			network: "deny",
			credentials: "deny",
		},
		verification: {
			strategy: "automated",
			commands: [command],
			checks: ["independent command"],
			evidence_required: ["independent_command"],
			strength: "strong",
		},
	});
}

describe("v3.1 pipeline control integration", () => {
	test("runs risk classification and deterministic hooks around a verification tool", async () => {
		const task = controlTask("pipeline-controls-pass", "node --test");
		const calls: string[] = [];
		const snapshot = captureWorkspaceSnapshot("controls-pass", [], []);
		const execution = await fileBackedPipeline().execute({
			...planFor(task),
			requirement: requirementFor("verified control path"),
			task,
			worker: new PiWorker("pi-controls", () => ({
				status: "success",
				summary: "control path worker passed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: (command) => {
				calls.push(`run:${command}`);
				return { command, exit_code: 0, stdout: "ok", stderr: "" };
			},
			command_risk_classifier: new CommandRiskClassifier(),
			lifecycle_hooks: new LifecycleHookManager({
				reload_scoped_rules: (cwd) => {
					calls.push(`reload:${cwd}`);
					return ["scoped-rule"];
				},
				hooks: [
					{
						id: "start",
						event: "on_start",
						kind: "static_check",
						run: () => {
							calls.push("start");
							return undefined;
						},
					},
					{
						id: "pre",
						event: "pre_tool_use",
						kind: "static_check",
						run: () => {
							calls.push("pre");
							return undefined;
						},
					},
					{
						id: "post",
						event: "post_tool_use",
						kind: "static_check",
						run: () => {
							calls.push("post");
							return undefined;
						},
					},
				],
			}),
			previous_working_directory: "/previous",
			snapshot,
			current_snapshot: snapshot,
		});

		expect(execution.task.state).toBe("DONE");
		expect(calls).toEqual(["start", "reload:.", "pre", "run:node --test", "post"]);
		expect(execution.evidence.evidence_types).toContain("command-risk:safe:auto_run");
	});

	test("does not execute an unapproved risky verification command", async () => {
		const task = controlTask("pipeline-controls-approval", "npm publish");
		let calls = 0;
		const execution = await fileBackedPipeline().execute({
			...planFor(task),
			requirement: requirementFor("blocked risky control path"),
			task,
			worker: new PiWorker("pi-controls-risky", () => ({
				status: "success",
				summary: "worker completed before verification gate",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: () => {
				calls += 1;
				return { command: "npm publish", exit_code: 0, stdout: "unexpected", stderr: "" };
			},
			command_risk_classifier: new CommandRiskClassifier(),
			snapshot: captureWorkspaceSnapshot("controls-risky", [], []),
		});

		expect(calls).toBe(0);
		expect(execution.task.state).toBe("FAILED");
		expect(execution.evidence.commands[0]?.exit_code).toBe(125);
		expect(execution.evidence.evidence_types).toContain("command-risk:risky:ask_user");
	});

	test("turns a deterministic pre-tool rejection into failed command evidence without running it", async () => {
		const task = controlTask("pipeline-controls-hook", "node --test");
		let calls = 0;
		const execution = await fileBackedPipeline().execute({
			...planFor(task),
			requirement: requirementFor("blocked hook control path"),
			task,
			worker: new PiWorker("pi-controls-hook", () => ({
				status: "success",
				summary: "worker completed before hook gate",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: () => {
				calls += 1;
				return { command: "node --test", exit_code: 0, stdout: "unexpected", stderr: "" };
			},
			command_risk_classifier: new CommandRiskClassifier(),
			lifecycle_hooks: new LifecycleHookManager({
				hooks: [
					{
						id: "deny-tool",
						event: "pre_tool_use",
						kind: "static_check",
						run: () => ({ passed: false, detail: "static checker rejected command" }),
					},
				],
			}),
			snapshot: captureWorkspaceSnapshot("controls-hook", [], []),
		});

		expect(calls).toBe(0);
		expect(execution.task.state).toBe("FAILED");
		expect(execution.evidence.commands[0]?.exit_code).toBe(126);
		expect(execution.evidence.evidence_types).toContain("hook:deny-tool:failed");
	});

	test("persists a missing post-tool checker warning as Evidence while allowing the Run", async () => {
		const task = controlTask("pipeline-controls-missing-checker", "node --test");
		const changedFile = "tmp/pipeline-controls-missing-checker.txt";
		const snapshot = captureWorkspaceSnapshot("controls-missing-checker", [changedFile], [changedFile]);
		const execution = await fileBackedPipeline().execute({
			...planFor(task),
			requirement: requirementFor("checker warning control path"),
			task,
			worker: new PiWorker("pi-controls-missing-checker", () => ({
				status: "success",
				summary: "worker changed a bounded file",
				changed_files: [changedFile],
				artifacts: [changedFile],
				evidence: ["worker_result"],
				work_receipt: {
					work_attempted: true,
					effects_count: 1,
					artifacts_created: [changedFile],
					state_changed: true,
					no_op: false,
					evidence_refs: ["worker_result"],
				},
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: (command) => ({ command, exit_code: 0, stdout: "ok", stderr: "" }),
			command_risk_classifier: new CommandRiskClassifier(),
			lifecycle_hooks: new LifecycleHookManager(),
			snapshot,
			current_snapshot: snapshot,
		});

		expect(execution.task.state).toBe("DONE");
		expect(execution.evidence.evidence_types).toContain("hook-checker-missing:post_tool_use");
		expect(execution.evidence.evidence_types.some((entry) => entry.startsWith("hook-warning:"))).toBe(true);
	});
});
