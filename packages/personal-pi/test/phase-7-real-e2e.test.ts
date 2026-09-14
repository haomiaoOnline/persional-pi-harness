import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CommandEvidence,
	captureWorkspaceSnapshot,
	PersistentStateStore,
	PersonalPiPipeline,
	replayExecutionTrace,
	type TaskContract,
	type WorkerAdapter,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task, planFor, requirementFor } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];
const workerScript = fileURLToPath(new URL("../scripts/local-e2e-worker.mjs", import.meta.url));
const verifierScript = fileURLToPath(new URL("../scripts/local-e2e-verifier.mjs", import.meta.url));

class LocalProcessWorker implements WorkerAdapter {
	readonly worker_id: string;
	private readonly action: string;
	private readonly target: string;

	constructor(workerId: string, action: string, target: string) {
		this.worker_id = workerId;
		this.action = action;
		this.target = target;
	}

	async execute(_request: WorkerProtocolRequest) {
		try {
			const stdout = execFileSync(process.execPath, [workerScript, this.action, this.target], { encoding: "utf8" });
			return {
				task_id: _request.task.id,
				run_id: _request.run_id ?? "missing-run",
				worker_id: this.worker_id,
				lease_epoch: _request.protocol.lease_epoch,
				status: "success" as const,
				summary: `local Worker process: ${stdout}`,
				changed_files: [this.target],
				artifacts: [this.target],
				evidence: ["worker_process", "artifact"],
				errors: [],
				work_receipt: {
					work_attempted: true,
					effects_count: 1,
					artifacts_created: [this.target],
					state_changed: true,
					no_op: false,
					evidence_refs: ["worker_process", "artifact"],
				},
			};
		} catch (error) {
			return {
				task_id: _request.task.id,
				run_id: _request.run_id ?? "missing-run",
				worker_id: this.worker_id,
				lease_epoch: _request.protocol.lease_epoch,
				status: "failure" as const,
				summary: "local Worker process failed",
				changed_files: [],
				artifacts: [],
				evidence: ["worker_process"],
				errors: [error instanceof Error ? error.message : String(error)],
			};
		}
	}
}

function commandEvidence(action: string, target: string, command: string): CommandEvidence {
	try {
		const stdout = execFileSync(process.execPath, [verifierScript, action, target], { encoding: "utf8" });
		return { command, exit_code: 0, stdout, stderr: "" };
	} catch (error) {
		return {
			command,
			exit_code: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

function taskFor(id: string, action: string, target: string): TaskContract {
	return makeV3Task(id, {
		title: `Run ${action} in a real local Worker process`,
		objective: `Execute ${action} and verify the resulting artifact`,
		scope: { files: [target] },
		permissions: {
			filesystem: { read: [target], write: [target] },
			shell: { allowed: [`verify:${action}`] },
			network: "deny",
			credentials: "deny",
		},
		verification: {
			strategy: "automated",
			commands: [`verify:${action}`],
			checks: ["independent verifier exits zero"],
			evidence_required: ["independent_command"],
			strength: "strong",
		},
	});
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T7.1 real local E2E", () => {
	test("completes three distinct requirements through independent verification and persistent trace", async () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-real-e2e-"));
		temporaryDirectories.push(directory);
		const store = new PersistentStateStore(join(directory, "state.json"));
		const pipeline = new PersonalPiPipeline({ state_store: store });
		const cases = [
			["real-markdown", "write-markdown"],
			["real-json", "write-json"],
			["real-report", "write-report"],
		] as const;

		for (const [id, action] of cases) {
			const target = join(directory, `${id}.out`);
			const task = taskFor(id, action, target);
			const command = `verify:${action}`;
			const execution = await pipeline.execute({
				...planFor(task),
				requirement: requirementFor(`verified ${action} artifact`),
				task,
				worker: new LocalProcessWorker(`process-${id}`, action, target),
				command_runner: () => commandEvidence(action, target, command),
				snapshot: captureWorkspaceSnapshot(`real-${id}`, [target], [target]),
				current_snapshot: captureWorkspaceSnapshot(`real-${id}`, [target], [target]),
			});

			expect(execution.task.state).toBe("DONE");
			expect(execution.verification.status).toBe("PASS");
			expect(execution.evidence.commands[0]?.exit_code).toBe(0);
			expect(execution.evidence.evidence_types).toContain("independent_command");
			expect(readFileSync(target, "utf8").length).toBeGreaterThan(0);
			expect(replayExecutionTrace(execution.trace).complete).toBe(true);
			expect(store.getTrace(execution.trace.trace_id)?.task_id).toBe(id);
		}

		expect(store.read().tasks.map((task) => task.state)).toEqual(["DONE", "DONE", "DONE"]);
		expect(store.read().runs).toHaveLength(3);
		expect(store.read().evidence).toHaveLength(3);
		expect(store.read().verifications).toHaveLength(3);
		expect(store.read().traces).toHaveLength(3);
	});
});
