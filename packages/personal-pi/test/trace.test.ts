import { describe, expect, test } from "vitest";
import {
	assertEvalIsolation,
	baselineReportsStable,
	buildGraphEfficiencyBrief,
	captureWorkspaceSnapshot,
	computeGraphEfficiencyMetrics,
	createPlanApproval,
	EvalContextStore,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	ReferenceArchitecturePlaybook,
	RegressionDataset,
	replayExecutionTrace,
	SingleAgentBaselineRunner,
	summarizeTraceMetrics,
	type TaskContract,
	TRACE_STAGES,
	TraceRecorder,
} from "../src/index.ts";

const AVAILABLE_WORKER_STATUS = {
	worker_capability: "available" as const,
	execution_mode: "normal" as const,
	delivery_status: "normal" as const,
};

function makeTask(id: string): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Trace task",
		objective: "Return a verified result",
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
			max_tool_calls: 2,
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
	const plan_assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "contract based",
		testability: "automated",
		business_viability: "internal",
		confidence: 0.9,
		open_risks: [],
		playbook_refs: ["trace-cli"],
	};
	return {
		provider_mode: "mock" as const,
		baseline_commit: "trace-test-baseline",
		plan_assessment,
		plan_checklist: {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		},
		plan_approval: createPlanApproval(plan_assessment, "owner"),
		playbook: new ReferenceArchitecturePlaybook([
			{ id: "trace-cli", task_types: [task.type], clauses: ["bounded local execution"] },
		]),
	};
}

describe("T11.1 execution trace", () => {
	test("derives graph efficiency from recorded execution facts", () => {
		const recorder = new TraceRecorder("metrics-task", "metrics-trace", "2026-09-13T11:00:00.000Z");
		recorder.record("DISPATCH", "parallel dispatch", "2026-09-13T11:00:00.010Z", {
			graph_width: 2,
			graph_depth: 3,
			active_workers: 2,
			handoff_count: 1,
		});
		recorder.record("WORKER", "worker-a", "2026-09-13T11:00:00.020Z", {
			active_workers: 2,
			agent_calls: 1,
		});
		recorder.record("RUN", "retry run", "2026-09-13T11:00:00.030Z", { attempt: 2 });
		recorder.record("RESULT", "success", "2026-09-13T11:00:00.040Z", { useful_work: 1 });
		recorder.record("VERIFICATION", "PASS", "2026-09-13T11:00:00.050Z", { status: "PASS" });
		recorder.finish("DONE", "2026-09-13T11:00:00.060Z");

		expect(computeGraphEfficiencyMetrics(recorder.snapshot())).toEqual({
			graph_width: 2,
			graph_depth: 3,
			handoff_count: 1,
			peak_active_workers: 2,
			retry_depth: 1,
			replan_count: 0,
			useful_work_ratio: 1,
			verification_first_pass_rate: 0,
			cost_per_verified_task: 0,
			time_per_verified_task: 60,
			agent_calls: 1,
			coordination_efficiency: 1 / 3,
		});
	});

	test("records every required stage and replays the decision path", () => {
		const recorder = new TraceRecorder("trace-task", "trace-1", "2026-09-13T11:00:00.000Z");
		for (const stage of TRACE_STAGES) recorder.record(stage, `${stage} completed`);
		recorder.addDecision({
			id: "decision-1",
			decision_type: "dispatch_policy",
			decision: "SINGLE_WORKER",
			reason: "low risk and small workload",
			inputs: ["trace-task"],
			at: "2026-09-13T11:00:00.000Z",
		});
		recorder.setMetrics({ token_per_task: 128, cache_hit_rate: 1, worker_tier: "cheap" });
		recorder.finish("DONE", "2026-09-13T11:00:01.000Z");

		const trace = recorder.snapshot();
		const replay = replayExecutionTrace(trace);
		expect(replay.complete).toBe(true);
		expect(replay.order_valid).toBe(true);
		expect(replay.missing_stages).toEqual([]);
		expect(replay.decision_reasons).toEqual(["dispatch_policy: low risk and small workload"]);
		expect(trace.metrics).toEqual({
			token_per_task: 128,
			cache_hit_rate: 1,
			worker_tier_distribution: { cheap: 1, standard: 0, frontier: 0 },
			graph_efficiency: {
				graph_width: 0,
				graph_depth: 0,
				handoff_count: 0,
				peak_active_workers: 0,
				retry_depth: 0,
				replan_count: 0,
				useful_work_ratio: 0,
				verification_first_pass_rate: 0,
				cost_per_verified_task: 0,
				time_per_verified_task: 0,
				agent_calls: 0,
				coordination_efficiency: 0,
			},
		});
	});

	test("persists a complete trace from the end-to-end pipeline", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("trace-pipeline");
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker: new PiWorker("trace-worker", () => ({
				status: "success",
				summary: "trace pipeline passed",
				evidence: ["worker_result"],
				work_receipt: {
					work_attempted: true,
					effects_count: 0,
					artifacts_created: [],
					state_changed: false,
					no_op: true,
					no_op_reason: "trace test has no file or artifact change",
					evidence_refs: ["worker_result"],
				},
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("trace-commit", [], []),
			at: "2026-09-13T11:01:00.000Z",
		});

		expect(replayExecutionTrace(execution.trace).complete).toBe(true);
		expect(store.getTrace(execution.trace.trace_id)).toEqual(execution.trace);
		expect(execution.trace.run_id).toBe(execution.run.id);
	});

	test("turns a terminal pipeline failure into a persisted regression case", async () => {
		const store = new PersistentStateStore();
		const task = makeTask("trace-failure");
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker: new PiWorker("trace-failing-worker", () => ({
				status: "failure",
				summary: "contract failure",
				errors: ["controlled failure"],
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("trace-failure-commit", [], []),
			at: "2026-09-13T11:02:00.000Z",
		});

		expect(execution.task.state).toBe("FAILED");
		expect(execution.trace.outcome).toBe("FAILED");
		expect(store.read().regressions).toHaveLength(1);
		expect(store.read().regressions[0]?.evidence_ref).toBe(execution.evidence.id);
		expect(replayExecutionTrace(execution.trace).complete).toBe(true);
	});
});

describe("T11.2 regression and baseline controls", () => {
	test("records and resolves regression cases", () => {
		const dataset = new RegressionDataset();
		const regression = dataset.add({
			category: "verification",
			task_id: "task-1",
			expected: "PASS",
			actual: "UNKNOWN",
			evidence_ref: "evidence-1",
		});

		expect(dataset.list()).toHaveLength(1);
		expect(dataset.resolve(regression.id).resolved).toBe(true);
		expect(dataset.list()[0]?.resolved).toBe(true);
	});

	test("keeps the 15-task single-agent baseline stable and bounded", async () => {
		const tasks = Array.from({ length: 15 }, (_, index) => makeTask(`baseline-${index + 1}`));
		const runner = new SingleAgentBaselineRunner((task, attempt) => ({
			success: task.id !== "baseline-1" || attempt === 2,
			duration_ms: 10,
			tokens: 100,
			manual_interventions: 0,
		}));
		const first = await runner.run(tasks, "baseline-a");
		const second = await runner.run(tasks, "baseline-b");

		expect(first.worker_count).toBe(1);
		expect(first.task_count).toBe(15);
		expect(first.success_rate).toBe(1);
		expect(first.cases[0]?.attempts).toBe(2);
		expect(first.total_duration_ms).toBe(160);
		expect(first.total_tokens).toBe(1600);
		expect(baselineReportsStable(first, second)).toBe(true);
	});

	test("aggregates trace metrics for cost and tier review", () => {
		const first = new TraceRecorder("metric-1");
		first.setMetrics({ token_per_task: 100, cache_hit_rate: 1, worker_tier: "cheap" });
		const second = new TraceRecorder("metric-2");
		second.setMetrics({ token_per_task: 300, cache_hit_rate: 0, worker_tier: "standard" });

		const summary = summarizeTraceMetrics([first.snapshot(), second.snapshot()]);
		expect(summary).toEqual({
			task_count: 2,
			total_tokens: 400,
			average_token_per_task: 200,
			cache_hit_rate: 0.5,
			worker_tier_distribution: { cheap: 1, standard: 1, frontier: 0 },
		});
	});

	test("produces a graph efficiency brief with coordination efficiency", () => {
		const recorder = new TraceRecorder("graph-metric");
		recorder.setMetrics({
			token_per_task: 100,
			cache_hit_rate: 0,
			worker_tier: "standard",
			graph_efficiency: {
				graph_width: 2,
				graph_depth: 3,
				handoff_count: 1,
				peak_active_workers: 2,
				retry_depth: 1,
				replan_count: 0,
				useful_work_ratio: 1,
				verification_first_pass_rate: 1,
				cost_per_verified_task: 0,
				time_per_verified_task: 20,
				agent_calls: 1,
				coordination_efficiency: 0,
			},
		});
		recorder.finish("DONE");

		const brief = buildGraphEfficiencyBrief([recorder.snapshot()], "2026-W37", "2026-09-13T11:03:00.000Z");
		expect(brief.metrics.coordination_efficiency).toBe(1 / 3);
		expect(brief.metrics.graph_depth).toBe(3);
		expect(brief.verified_tasks).toBe(1);
	});
});

describe("T11.3 evaluation context isolation", () => {
	test("does not resolve held-out objects in the evaluation store", () => {
		const evalStore = new EvalContextStore();
		const heldOut = evalStore.put("held-out answer", { held_out: true });
		const publicReference = evalStore.put("public evaluation context");

		expect(() =>
			evalStore.resolve({
				required: [heldOut.digest],
				optional: [],
				excluded: [],
				budget: { max_input_tokens: 100 },
			}),
		).toThrow(heldOut.digest);

		const resolved = evalStore.resolve({
			required: [publicReference.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 100 },
		});
		assertEvalIsolation(resolved, [heldOut.digest]);
		expect(resolved.text).toBe("public evaluation context");
		expect(evalStore.stats().objects).toBe(2);
	});
});
