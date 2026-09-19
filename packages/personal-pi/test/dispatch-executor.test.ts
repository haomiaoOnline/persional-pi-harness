import { describe, expect, test } from "vitest";
import {
	ArtifactStore,
	captureWorkspaceSnapshot,
	DispatchExecutor,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	WorkerPool,
} from "../src/index.ts";
import { makeV3Task, planFor, requirementFor } from "./v3-fixtures.ts";

function legalNoOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "read-only dispatch fixture",
		evidence_refs: ["worker_result"],
	};
}

function task(id: string) {
	return makeV3Task(id, {
		objective: `Research independent unit ${id}`,
		scope: { files: ["."] },
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "cheap",
			reasoning_depth: "low",
			capability_tags: ["research"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
	});
}

function worker(id: string, delayMs: number) {
	return new PiWorker(
		id,
		async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return {
				status: "success" as const,
				summary: `${id} completed`,
				evidence: ["worker_result"],
				changed_files: [],
				work_receipt: legalNoOpReceipt(),
			};
		},
		"mock-model",
	);
}

function job(taskId: string) {
	const contract = task(taskId);
	return {
		request: {
			...planFor(contract),
			requirement: requirementFor(`research ${taskId}`),
			task: contract,
			snapshot: captureWorkspaceSnapshot("dispatch-fixture", [], []),
		},
	};
}

describe("T12.4-A production Dispatch Executor", () => {
	test("upgrades requested parallel to effective parallel only after real Worker overlap", async () => {
		const store = new PersistentStateStore();
		const pipeline = new PersonalPiPipeline({ state_store: store });
		const pool = new WorkerPool();
		pool.register({ worker_id: "research-a", kind: "local_process_worker", adapter: worker("research-a", 30) });
		pool.register({ worker_id: "research-b", kind: "local_process_worker", adapter: worker("research-b", 30) });
		pool.warmAll();
		const artifacts = new ArtifactStore();
		const executor = new DispatchExecutor({ pipeline, worker_pool: pool, artifact_store: artifacts });

		const wave = await executor.executeParallelWave([job("research-a-task"), job("research-b-task")]);

		expect(wave.effective_mode).toBe("parallel");
		expect(wave.effective_worker_count).toBeGreaterThanOrEqual(2);
		expect(wave.overlap_proof_ref).toMatch(/^[a-f0-9]{64}$/);
		expect(artifacts.get(wave.overlap_proof_ref ?? "")?.type).toBe("dispatch_overlap_proof");
		expect(wave.executions).toHaveLength(2);
		for (const execution of wave.executions) {
			expect(execution.task.state).toBe("DONE");
			expect(execution.dispatch_record).toMatchObject({
				requested_mode: "parallel",
				effective_mode: "parallel",
				executor_kind: "worker_pool",
				effective_worker_count: expect.any(Number),
				overlap_proof_ref: wave.overlap_proof_ref,
			});
			expect(execution.trace.metrics.graph_efficiency?.peak_active_workers).toBeGreaterThanOrEqual(2);
		}
	});

	test("records explicit degradation when only one Worker is available", async () => {
		const store = new PersistentStateStore();
		const pipeline = new PersonalPiPipeline({ state_store: store });
		const pool = new WorkerPool();
		pool.register({ worker_id: "only-worker", kind: "local_process_worker", adapter: worker("only-worker", 1) });
		pool.warmAll();
		const executor = new DispatchExecutor({ pipeline, worker_pool: pool });

		const wave = await executor.executeParallelWave([job("serial-a"), job("serial-b")]);

		expect(wave.effective_mode).toBe("single");
		expect(wave.effective_worker_count).toBe(1);
		expect(wave.degrade_reason).toContain("resource ceiling is not configured");
		expect(wave.overlap_proof_ref).toBeUndefined();
		for (const execution of wave.executions) {
			expect(execution.dispatch_record).toMatchObject({
				requested_mode: "parallel",
				effective_mode: "single",
				executor_kind: "worker_pool",
				effective_worker_count: 1,
			});
			expect(execution.dispatch_record.degrade_reason).toBeTruthy();
		}
	});
});
