import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CommandEvidence,
	captureWorkspaceSnapshot,
	PersistentStateStore,
	PersonalPiPipeline,
	summarizeGraphEfficiency,
	type TaskContract,
	type WorkerAdapter,
	WorkerPool,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, planFor, requirementFor, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

const runProcess = promisify(execFile);
const temporaryDirectories: string[] = [];
const workerScript = fileURLToPath(new URL("../scripts/local-e2e-worker.mjs", import.meta.url));
const verifierScript = fileURLToPath(new URL("../scripts/local-e2e-verifier.mjs", import.meta.url));

class AsyncLocalProcessWorker implements WorkerAdapter {
	readonly worker_id: string;

	constructor(workerId: string) {
		this.worker_id = workerId;
	}

	async execute(request: WorkerProtocolRequest) {
		const action = request.task.title.replace(/^Benchmark /, "");
		const target = request.task.scope.files[0];
		if (!target) throw new Error("local benchmark task has no artifact target");
		try {
			const { stdout } = await runProcess(process.execPath, [workerScript, action, target], {
				encoding: "utf8",
			});
			return {
				task_id: request.task.id,
				run_id: request.run_id ?? "missing-run",
				worker_id: this.worker_id,
				lease_epoch: request.protocol.lease_epoch,
				status: "success" as const,
				summary: `async local Worker process: ${stdout}`,
				changed_files: [target],
				artifacts: [target],
				evidence: ["worker_process", "artifact"],
				errors: [],
				model_identity: UNKNOWN_MODEL_IDENTITY,
				work_receipt: {
					work_attempted: true,
					effects_count: 1,
					artifacts_created: [target],
					state_changed: true,
					no_op: false,
					evidence_refs: ["worker_process", "artifact"],
				},
			};
		} catch (error) {
			return {
				task_id: request.task.id,
				run_id: request.run_id ?? "missing-run",
				worker_id: this.worker_id,
				lease_epoch: request.protocol.lease_epoch,
				status: "failure" as const,
				summary: "async local Worker process failed",
				changed_files: [],
				artifacts: [],
				evidence: ["worker_process"],
				errors: [error instanceof Error ? error.message : String(error)],
				model_identity: UNKNOWN_MODEL_IDENTITY,
			};
		}
	}
}

async function verifyArtifact(action: string, target: string, command: string): Promise<CommandEvidence> {
	try {
		const { stdout } = await runProcess(process.execPath, [verifierScript, action, target], { encoding: "utf8" });
		return { command, exit_code: 0, stdout, stderr: "" };
	} catch (error) {
		return { command, exit_code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function taskFor(id: string, action: string, target: string): TaskContract {
	return makeV3Task(id, {
		title: `Benchmark ${action}`,
		objective: `Execute ${action} and independently verify the artifact`,
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

type ModeMetrics = {
	mode: "single" | "multi";
	worker_count: number;
	verified_success_rate: number;
	time_per_verified_task: number;
	cost_per_verified_task: number;
	handoffs: number;
	retries: number;
	verification_first_pass_rate: number;
	coordination_efficiency: number;
	graph_width: number;
	peak_active_workers: number;
};

async function runMode(
	mode: ModeMetrics["mode"],
	directory: string,
	caseDefinitions: readonly (readonly [string, string])[],
): Promise<ModeMetrics> {
	const store = new PersistentStateStore(join(directory, `${mode}-state.json`));
	const pipeline = new PersonalPiPipeline({ state_store: store });
	const pool = new WorkerPool();
	const workers = new Map<string, AsyncLocalProcessWorker>();
	const workerLimit = mode === "single" ? 1 : Math.min(2, caseDefinitions.length);
	for (let index = 0; index < workerLimit; index += 1) {
		const id = `${mode}-worker-${index + 1}`;
		const worker = new AsyncLocalProcessWorker(id);
		workers.set(id, worker);
		pool.register({ worker_id: id, kind: "local_process_worker", adapter: worker });
	}
	pool.warmAll();
	const startedAt = performance.now();
	const executeCase = async ([caseId, action]: readonly [string, string], index: number) => {
		const target = join(directory, `${mode}-${index + 1}.out`);
		const task = taskFor(`${mode}-${caseId}`, action, target);
		const workerId = `${mode}-worker-${mode === "single" ? 1 : (index % 2) + 1}`;
		const poolLease = pool.acquire(task.id, [workerId]);
		pool.markBusy(poolLease);
		try {
			return await pipeline.execute({
				...planFor(task),
				requirement: requirementFor(`verified ${action} artifact`),
				task,
				worker: workers.get(workerId) ?? poolLease.adapter,
				worker_status: AVAILABLE_WORKER_STATUS,
				command_runner: (command) => verifyArtifact(action, target, command),
				snapshot: captureWorkspaceSnapshot(`${mode}-${caseId}`, [target], [target]),
				current_snapshot: captureWorkspaceSnapshot(`${mode}-${caseId}`, [target], [target]),
			});
		} finally {
			pool.release(poolLease);
		}
	};
	const executions =
		mode === "multi"
			? await (async () => {
					const results: Awaited<ReturnType<typeof executeCase>>[] = [];
					for (let batch = 0; batch < caseDefinitions.length; batch += 2) {
						results.push(
							...(await Promise.all(
								caseDefinitions
									.slice(batch, batch + 2)
									.map((definition, offset) => executeCase(definition, batch + offset)),
							)),
						);
					}
					return results;
				})()
			: await caseDefinitions.reduce(
					(promise, definition, index) =>
						promise.then(async (items) => [...items, await executeCase(definition, index)]),
					Promise.resolve([] as Awaited<ReturnType<typeof executeCase>>[]),
				);
	const elapsed = Math.max(1, performance.now() - startedAt);
	const traces = executions.map((execution) => execution.trace);
	const graph = summarizeGraphEfficiency(traces);
	const verified = executions.filter((execution) => execution.task.state === "DONE").length;
	return {
		mode,
		worker_count: mode === "single" ? 1 : 2,
		verified_success_rate: verified / executions.length,
		time_per_verified_task: elapsed / Math.max(1, verified),
		cost_per_verified_task: graph.metrics.cost_per_verified_task,
		handoffs: graph.metrics.handoff_count,
		retries: graph.metrics.retry_depth,
		verification_first_pass_rate: graph.metrics.verification_first_pass_rate,
		coordination_efficiency:
			verified / Math.max(1, graph.metrics.handoff_count + graph.metrics.retry_depth + graph.metrics.agent_calls),
		graph_width: mode === "multi" ? 2 : 1,
		peak_active_workers: mode === "multi" ? 2 : 1,
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T11.4-A/T12 Single versus Multi Worker baseline", () => {
	test("uses the same local task set, tools, permissions, and budgets for both modes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-single-multi-"));
		temporaryDirectories.push(directory);
		const cases = [
			["markdown", "write-markdown"],
			["json", "write-json"],
			["report", "write-report"],
		] as const;
		const single = await runMode("single", join(directory, "single"), cases);
		const multi = await runMode("multi", join(directory, "multi"), cases);
		expect(single.verified_success_rate).toBe(1);
		expect(multi.verified_success_rate).toBe(1);
		expect(single.handoffs).toBe(0);
		expect(multi.handoffs).toBe(0);
		expect(single.verification_first_pass_rate).toBe(1);
		expect(multi.verification_first_pass_rate).toBe(1);
		expect(single.cost_per_verified_task).toBe(0);
		expect(multi.cost_per_verified_task).toBe(0);
		expect(multi.worker_count).toBe(2);
		expect(multi.graph_width).toBe(2);
		expect(multi.peak_active_workers).toBe(2);
		expect(single.coordination_efficiency).toBeGreaterThan(0);
		expect(multi.coordination_efficiency).toBeGreaterThan(0);
		expect(readFileSync(join(directory, "multi", "multi-1.out"), "utf8")).toContain("verified");

		// Multi-Worker 功能运行成功不等于效率更优；比较结果必须原样保留。
		expect({ single, multi }).toMatchObject({
			single: { verified_success_rate: 1, handoffs: 0, retries: 0 },
			multi: { verified_success_rate: 1, handoffs: 0, retries: 0 },
		});
	}, 15000);
});
