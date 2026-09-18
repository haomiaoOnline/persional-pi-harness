import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ContextResolver,
	ContextStore,
	captureWorkspaceSnapshot,
	createPlanApproval,
	deliveryEvidencePackageDigest,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	ReferenceArchitecturePlaybook,
	type TaskContract,
	type WorkerAdapter,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];
const AVAILABLE_WORKER_STATUS = {
	worker_capability: "available" as const,
	execution_mode: "normal" as const,
	delivery_status: "normal" as const,
};
const UNAVAILABLE_WORKER_STATUS = {
	worker_capability: "unavailable" as const,
	execution_mode: "root_only" as const,
	delivery_status: "degraded" as const,
};

function makeTask(id: string, objective = "Return a verified result"): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Pipeline task",
		objective,
		requirements: ["Produce the requested result"],
		constraints: [],
		scope: { files: ["packages/personal-pi/src/index.ts"] },
		inputs: {},
		data_sources: ["local repository"],
		data_references: [],
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
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["verified result"],
		acceptance_criteria: ["independent verification passes"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: {
			max_attempts: 2,
			max_model_calls: 2,
			max_tool_calls: 4,
			max_handoffs: 1,
			max_elapsed_ms: 60000,
			max_input_tokens: 4000,
			max_output_tokens: 4000,
			max_cost_usd: 1,
			max_state_growth_bytes: 10000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

function requirement() {
	return {
		user: "Personal PI owner",
		data_sources: ["repository"],
		permission_location: ["task contract"],
		delivery: "verified local result",
		acceptance: ["result is independently verified"],
		constraints: ["no network"],
		unknowns: [],
		sustainability: ["replayable evidence"],
		non_functional: ["deterministic"],
		commercialization: ["internal core"],
	};
}

function planFor(task: TaskContract) {
	const assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "contract based",
		testability: "automated",
		business_viability: "internal",
		confidence: 0.9,
		open_risks: [],
		playbook_refs: ["core-cli"],
	};
	return {
		provider_mode: "mock" as const,
		baseline_commit: "pipeline-test-baseline",
		plan_assessment: assessment,
		plan_checklist: {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		},
		plan_approval: createPlanApproval(assessment, "owner"),
		playbook: new ReferenceArchitecturePlaybook([
			{ id: "core-cli", task_types: [task.type], clauses: ["bounded local execution"] },
		]),
	};
}

function legalNoOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "verification-only task produced no file or artifact",
		evidence_refs: ["worker_result"],
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T7.1 complete Personal PI pipeline", () => {
	test("runs three different small requirements through DONE with persisted evidence", async () => {
		const store = new PersistentStateStore();
		const pipeline = new PersonalPiPipeline({ state_store: store });

		for (const [index, objective] of ["verify docs", "verify tests", "verify package"].entries()) {
			const task = makeTask(`e2e-${index + 1}`, objective);
			const worker = new PiWorker(`pi-${index + 1}`, (_input) => ({
				status: "success" as const,
				summary: `${objective} passed`,
				evidence: ["worker_result"],
				changed_files: [],
				work_receipt: legalNoOpReceipt(),
			}));
			const execution = await pipeline.execute({
				...planFor(task),
				requirement: requirement(),
				task,
				worker,
				worker_status: AVAILABLE_WORKER_STATUS,
				snapshot: captureWorkspaceSnapshot("e2e-commit", [], []),
				at: `2026-09-13T10:0${index}:00.000Z`,
			});

			expect(execution.task.state).toBe("DONE");
			expect(execution.result.status).toBe("success");
			expect(execution.verification.status).toBe("PASS");
			expect(execution.evidence.evidence_types).toEqual(["worker_result"]);
			expect(execution.evidence.delivery_evidence_package).toMatchObject({
				baseline_commit: "pipeline-test-baseline",
				task_revision: task.task_revision,
				provider_mode: "mock",
			});
			expect(execution.verification.evidence_id).toBe(execution.evidence.id);
			const acceptance = store.read().acceptances.find((entry) => entry.task_id === task.id);
			expect(acceptance).toMatchObject({
				evidence_id: execution.evidence.id,
				provider_mode: "mock",
			});
		}

		expect(store.listTasks().map((task) => task.state)).toEqual(["DONE", "DONE", "DONE"]);
		expect(store.read().runs).toHaveLength(3);
		expect(store.read().evidence).toHaveLength(3);
		expect(store.read().verifications).toHaveLength(3);
		expect(store.read().decisions.filter((decision) => decision.decision_type === "dispatch_policy")).toHaveLength(3);
		expect(() =>
			store.transact((state) => {
				const deliveryPackage = state.evidence[0]?.delivery_evidence_package;
				if (deliveryPackage) deliveryPackage.provider_mode = "real";
			}),
		).toThrow("delivery Evidence digest mismatch");
		expect(() =>
			store.transact((state) => {
				const evidence = state.evidence[0];
				const deliveryPackage = evidence?.delivery_evidence_package;
				if (!evidence || !deliveryPackage) return;
				deliveryPackage.provider_mode = "real";
				const verification = state.verifications.find((entry) => entry.evidence_id === evidence.id);
				if (verification)
					verification.delivery_evidence_package_digest = deliveryEvidencePackageDigest(deliveryPackage);
				const acceptance = state.acceptances.find((entry) => entry.evidence_id === evidence.id);
				if (acceptance) acceptance.provider_mode = "real";
			}),
		).toThrow("canonical evidence record is immutable");
	});

	test("projects resolved context into the Worker without putting protocol metadata in it", async () => {
		const contextStore = new ContextStore();
		const reference = contextStore.put("authoritative project fact");
		const contextResolver = new ContextResolver(contextStore);
		const task = makeTask("e2e-context");
		task.context = {
			required: [reference.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 50 },
		};
		const seen: string[] = [];
		const worker = new PiWorker("pi-context", (input) => {
			seen.push(input.resolved_context?.text ?? "");
			return {
				status: "success",
				summary: "context consumed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			};
		});
		const execution = await new PersonalPiPipeline().execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			worker_status: AVAILABLE_WORKER_STATUS,
			context_resolver: contextResolver,
			snapshot: captureWorkspaceSnapshot("context-commit", [], []),
		});

		expect(execution.task.state).toBe("DONE");
		expect(seen).toEqual(["authoritative project fact"]);
	});

	test("records browser/container verification refs in the standardized delivery package", async () => {
		const task = makeTask("e2e-browser-evidence");
		const execution = await new PersonalPiPipeline().execute({
			...planFor(task),
			requirement: requirement(),
			task,
			baseline_commit: "browser-baseline",
			worker: new PiWorker("pi-browser-evidence", () => ({
				status: "success",
				summary: "browser evidence captured",
				evidence: ["worker_result", "browser_e2e", "screenshot", "request_trace"],
				artifacts: ["artifact://browser/screenshot-1", "artifact://browser/request-trace-1"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("browser-commit", [], []),
		});
		expect(execution.evidence.delivery_evidence_package).toMatchObject({
			baseline_commit: "browser-baseline",
			provider_mode: "mock",
			browser_or_container_verification: ["artifact://browser/screenshot-1", "artifact://browser/request-trace-1"],
		});
	});

	test("blocks a green Worker result that has no work receipt explanation", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("e2e-work-receipt-anomaly");
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker: new PiWorker("pi-anomaly", () => ({
				status: "success",
				summary: "claims success without doing work",
				evidence: ["worker_result"],
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("anomaly-commit", [], []),
		});

		expect(execution.task.state).toBe("BLOCKED");
		expect(execution.trace.events.at(-1)?.detail).toBe("work receipt anomaly requires human review");
		expect(store.read().regressions[0]?.category).toBe("pipeline_failure");
	});

	test("converts a well-shaped result from another execution into a bound failure", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("e2e-result-identity");
		const worker: WorkerAdapter = {
			worker_id: "pi-identity",
			execute: async (request) => ({
				task_id: "other-task",
				run_id: "other-run",
				worker_id: "other-worker",
				lease_epoch: request.protocol.lease_epoch + 1,
				status: "success",
				summary: "cross-execution result",
				changed_files: [],
				artifacts: [],
				evidence: ["worker_result"],
				errors: [],
				model_identity: {
					requested_model: "forged-request",
					platform_accepted_model: "forged-platform",
					observed_runtime_model: "forged-runtime",
				},
			}),
		};

		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("identity-commit", [], []),
		});

		expect(execution.task.state).toBe("FAILED");
		expect(execution.result.summary).toBe("worker result identity mismatch");
		expect(execution.result.task_id).toBe(task.id);
		expect(execution.result.run_id).toBe(execution.run.id);
		expect(execution.result.worker_id).toBe(worker.worker_id);
		expect(execution.result.model_identity).toEqual({
			requested_model: "unknown",
			platform_accepted_model: "unknown",
			observed_runtime_model: "unknown",
		});
		expect(store.read().results).toHaveLength(1);
		expect(store.read().results[0]?.run_id).toBe(execution.run.id);
	});

	test("bounds additional Worker model calls through execution controls", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("e2e-model-call-bound");
		let callbackCalls = 0;
		const execution = new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker: new PiWorker("pi-model-loop", ({ loop_budget }) => {
				loop_budget?.beforeModelCall();
				callbackCalls += 1;
				loop_budget?.beforeModelCall();
				callbackCalls += 1;
				return { status: "success", summary: "unreachable", evidence: ["worker_result"] };
			}),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("model-call-bound", [], []),
		});

		await expect(execution).rejects.toThrow("max_model_calls");
		expect(store.getTask(task.id)?.state).toBe("BLOCKED");
		expect(callbackCalls).toBe(1);
		expect(store.getLoopUsage(task.id)).toMatchObject({ attempts: 1, model_calls: 2 });
		expect(store.read().results[0]?.errors.join(" ")).toContain("max_model_calls");
	});
});

describe("T7.2 self-development", () => {
	test("lets a contracted Worker modify a small self-owned function and verifies it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-self-development-"));
		temporaryDirectories.push(directory);
		const target = join(directory, "self-owned-function.ts");
		writeFileSync(target, "export function value(): string { return 'old'; }\n", "utf8");
		const task = makeTask("self-development", "update the self-owned function");
		task.scope = { files: [target] };
		const worker = new PiWorker("pi-self", (_input) => {
			writeFileSync(target, "export function value(): string { return 'new'; }\n", "utf8");
			return {
				status: "success",
				summary: "self-owned function updated",
				changed_files: [target],
				evidence: ["worker_result"],
			};
		});
		const execution = await new PersonalPiPipeline().execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("self-commit", [target], []),
			current_snapshot: captureWorkspaceSnapshot("self-commit", [target], []),
		});

		expect(execution.task.state).toBe("DONE");
		expect(readFileSync(target, "utf8")).toContain("return 'new'");
	});

	test("fails closed before Lease/Run/adapter execution when Worker capability is unavailable", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("worker-unavailable");
		let executions = 0;
		const worker = new PiWorker("pi-unavailable", () => {
			executions += 1;
			return { status: "success", summary: "must not execute" };
		});
		const attempt = new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			worker_status: UNAVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("unavailable", [], []),
		});

		await expect(attempt).rejects.toThrow("Worker capability unavailable");
		expect(executions).toBe(0);
		expect(store.getTask(task.id)?.state).toBe("BLOCKED");
		expect(store.read().runs).toEqual([]);
		expect(store.read().leases).toEqual({});
		expect(store.getLoopUsage(task.id).attempts).toBe(0);
		expect(store.read().dispatches).toEqual([
			expect.objectContaining({
				worker_id: "pi-unavailable",
				worker_status: UNAVAILABLE_WORKER_STATUS,
				requested_model: "unknown",
			}),
		]);
		expect(store.read().dispatches[0]).not.toHaveProperty("lease_epoch");
	});

	test("rejects a missing WorkerStatus before creating Task/Lease/Run", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("worker-status-missing");
		let executions = 0;
		const worker = new PiWorker("pi-status-missing", () => {
			executions += 1;
			return { status: "success", summary: "must not execute" };
		});
		const request = {
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			snapshot: captureWorkspaceSnapshot("missing-status", [], []),
		};

		await expect(new PersonalPiPipeline({ state_store: store }).execute(request as never)).rejects.toThrow(
			"invalid WorkerStatus",
		);
		expect(executions).toBe(0);
		expect(store.listTasks()).toEqual([]);
		expect(store.read().runs).toEqual([]);
		expect(store.read().leases).toEqual({});
	});
});
