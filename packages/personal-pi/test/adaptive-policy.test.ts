import { describe, expect, test } from "vitest";
import {
	calibratePolicy,
	DEFAULT_ROLE_PROFILES,
	LearnedRoutingAdvisor,
	measuredPolicyMetric,
	PiWorker,
	policyObservationFromTrace,
	preclassifyTask,
	type RegisteredWorker,
	RoutingRuleGuard,
	type RoutingSuggestion,
	type TaskContract,
	unavailablePolicyMetric,
	type WorkerPluginManifest,
	WorkerRegistry,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

function fixtureManifest(costTier: "cheap" | "standard" | "frontier" = "cheap", lowOnly = false): WorkerPluginManifest {
	return {
		worker_plugin: {
			id: `fixture-${costTier}-${lowOnly ? "low" : "all"}`,
			adapter_entry: "fixture-adapter.ts",
			models_supported: [
				{
					model: "fixture-model",
					reasoning_levels: lowOnly ? (["low"] as const) : (["low", "medium", "high", "extended"] as const),
				},
			],
			capability_tags: ["coding", "shell"],
			context_limit: 10_000,
			cost_tier: costTier,
			auth: { type: "none" as const },
			discovery: { type: "static_config" as const },
		},
	};
}

function registerWorker(workerId = "fixture-worker", costTier: "cheap" | "standard" | "frontier" = "cheap") {
	const registry = new WorkerRegistry();
	registry.register({
		worker_id: workerId,
		worker_type: "cli",
		manifest: fixtureManifest(costTier),
		adapter: new PiWorker(workerId, async () => ({ status: "success", summary: "fixture" })),
		capabilities: { latency_ms: 20 },
	});
	return registry;
}

function routingTask(id = "adaptive-route-task"): TaskContract {
	return makeV3Task(id, {
		type: "backend",
		execution: {
			worker_type: "cli",
			worker_tier: "cheap",
			reasoning_depth: "low",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: ["shell"],
		},
	});
}

function baseSuggestion(task: TaskContract, candidate: RegisteredWorker): RoutingSuggestion {
	return {
		schema_version: "t15.2.v1",
		task_id: task.id,
		worker_id: candidate.worker_id,
		worker_type: candidate.worker_type,
		worker_tier: candidate.manifest.worker_plugin.cost_tier,
		reasoning_depth: task.execution.reasoning_depth,
		capability_tags: [...task.execution.capability_tags],
		score: 999,
		factors: {
			capability_match: 1,
			historical_sample_count: 0,
			task_type_match: 0,
			cost_penalty: 0,
			latency_penalty: 0,
		},
		verification_strength: task.verification.strength,
		authority: "advisory",
		task_state_mutation: false,
	};
}

describe("T15.1 deterministic Policy Calibration", () => {
	test("keeps unavailable metrics as insufficient_data and emits executable recommendations", () => {
		const trace = {
			trace_id: "trace-calibration-1",
			task_id: "task-calibration-1",
			started_at: "2026-09-16T00:00:00.000Z",
			outcome: "DONE" as const,
			events: [],
			decisions: [],
			metrics: {
				token_per_task: 0,
				cache_hit_rate: 0,
				worker_tier_distribution: { cheap: 1, standard: 0, frontier: 0 },
				graph_efficiency: {
					graph_width: 3,
					graph_depth: 2,
					handoff_count: 0,
					peak_active_workers: 3,
					retry_depth: 0,
					replan_count: 0,
					useful_work_ratio: 1,
					verification_first_pass_rate: 1,
					cost_per_verified_task: 0,
					time_per_verified_task: 100,
					agent_calls: 1,
					coordination_efficiency: 1,
				},
			},
			replayable: true,
		};
		const observations = [
			policyObservationFromTrace(trace, {
				task_type: "phase13-analysis",
				evidence_refs: ["docs/stage-gates/evidence/phase-13-t13-4-2026-09-15.json"],
				measured_metrics: ["time_per_verified_task", "retry_depth", "coordination_efficiency"],
			}),
			policyObservationFromTrace(
				{ ...trace, trace_id: "trace-calibration-2", task_id: "task-calibration-2" },
				{
					task_type: "phase13-coding",
					evidence_refs: ["docs/stage-gates/evidence/phase-13-t13-4-2026-09-15.json"],
					measured_metrics: ["time_per_verified_task", "retry_depth", "coordination_efficiency"],
				},
			),
			policyObservationFromTrace(
				{ ...trace, trace_id: "trace-calibration-3", task_id: "task-calibration-3" },
				{
					task_type: "phase13-recovery",
					evidence_refs: ["docs/stage-gates/evidence/phase-13-t13-4-2026-09-15.json"],
					measured_metrics: ["time_per_verified_task", "retry_depth", "coordination_efficiency"],
				},
			),
		];
		const report = calibratePolicy({ observations, generated_at: "2026-09-16T00:00:00.000Z" });

		expect(report.metrics.time_per_verified_task.status).toBe("measured");
		expect(report.metrics.time_per_verified_task.value).toBe(100);
		expect(report.metrics.cost_per_verified_task.status).toBe("insufficient_data");
		expect(report.metrics.cost_per_verified_task.value).toBeUndefined();
		expect(report.findings.find((finding) => finding.category === "decision_record_missing")).toMatchObject({
			status: "measured",
			observed_count: 3,
			rate: 1,
		});
		expect(report.recommendations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "recommendation-decision-record-gate", status: "PROPOSED" }),
			]),
		);
		expect(report.boundary).toEqual({
			mode: "offline_advisory",
			llm_required: false,
			applies_recommendations_automatically: false,
			modifies_task_truth: false,
		});
	});

	test("is deterministic for equivalent input order and never mutates observations", () => {
		const observations = [
			{
				observation_id: "b",
				task_type: "task",
				source: "fixture",
				cohort_size: 1,
				metrics: { time_per_verified_task: measuredPolicyMetric(20, "ms_per_verified_task", ["evidence:b"]) },
				evidence_refs: ["evidence:b"],
			},
			{
				observation_id: "a",
				task_type: "task",
				source: "fixture",
				cohort_size: 1,
				metrics: { time_per_verified_task: measuredPolicyMetric(10, "ms_per_verified_task", ["evidence:a"]) },
				evidence_refs: ["evidence:a"],
			},
			{
				observation_id: "c",
				task_type: "task",
				source: "fixture",
				cohort_size: 1,
				metrics: { time_per_verified_task: measuredPolicyMetric(30, "ms_per_verified_task", ["evidence:c"]) },
				evidence_refs: ["evidence:c"],
			},
		];
		const before = structuredClone(observations);
		const first = calibratePolicy({ observations, generated_at: "2026-09-16T00:00:00.000Z" });
		const second = calibratePolicy({
			observations: [observations[2]!, observations[0]!, observations[1]!],
			generated_at: "2026-09-16T00:00:00.000Z",
		});
		expect(first).toEqual(second);
		expect(observations).toEqual(before);
	});

	test("does not turn an unavailable zero into a measured zero", () => {
		const report = calibratePolicy({
			observations: [
				{
					observation_id: "only-observation",
					task_type: "task",
					source: "fixture",
					metrics: {
						cost_per_verified_task: unavailablePolicyMetric("usd_per_verified_task", "no cost provenance"),
					},
					evidence_refs: ["evidence:cost-missing"],
				},
			],
		});
		expect(report.metrics.cost_per_verified_task).toMatchObject({ status: "insufficient_data", sample_count: 0 });
		expect(report.metrics.cost_per_verified_task).not.toHaveProperty("value");
	});
});

describe("T15.2 Learned Routing and Rule Guard", () => {
	test("ranks only candidates that pass the hard guard and remains advisory", () => {
		const registry = registerWorker();
		const task = routingTask();
		const candidates = registry.selectCandidates(task);
		const suggestions = new LearnedRoutingAdvisor().recommend({
			task,
			candidates,
			historical_success: [{ worker_id: "fixture-worker", task_type: task.type, successes: 3, failures: 0 }],
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({
			worker_id: "fixture-worker",
			authority: "advisory",
			task_state_mutation: false,
		});
	});

	test("blocks every hard-rule violation even when the suggestion score is highest", () => {
		const registry = registerWorker();
		const candidate = registry.selectCandidates(routingTask())[0]!;
		const guard = new RoutingRuleGuard();
		const cases: Array<{
			name: string;
			task: TaskContract;
			suggestion?: Partial<RoutingSuggestion>;
			role?: (typeof DEFAULT_ROLE_PROFILES)[number];
		}> = [
			{
				name: "worker type",
				task: makeV3Task("guard-worker-type"),
				suggestion: { worker_type: "cli" },
			},
			{
				name: "worker tier",
				task: makeV3Task("guard-worker-tier", {
					execution: { ...routingTask().execution, worker_tier: "frontier" },
				}),
			},
			{
				name: "capability",
				task: makeV3Task("guard-capability", {
					execution: { ...routingTask().execution, capability_tags: ["math"] },
				}),
			},
			{
				name: "reasoning",
				task: makeV3Task("guard-reasoning", {
					execution: { ...routingTask().execution, reasoning_depth: "high" },
				}),
				suggestion: { reasoning_depth: "low" },
			},
			{
				name: "context",
				task: makeV3Task("guard-context", {
					execution: { ...routingTask().execution },
					context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 20_000 } },
				}),
			},
			{
				name: "permission",
				task: routingTask("guard-permission"),
				suggestion: { permission_request: { filesystem: { write: ["outside/scope"] } } },
			},
			{
				name: "role",
				task: makeV3Task("guard-role", { type: "production_deploy" }),
				role: DEFAULT_ROLE_PROFILES[0],
			},
			{
				name: "verification",
				task: routingTask("guard-verification"),
				suggestion: { verification_strength: "none" },
			},
			{
				name: "loop budget",
				task: routingTask("guard-budget"),
				suggestion: { projected_usage: { attempts: 3 } },
			},
			{
				name: "approval",
				task: makeV3Task("guard-approval", { approval: { required: true } }),
			},
		];

		for (const item of cases) {
			const suggestion = {
				...baseSuggestion(item.task, candidate.registration),
				...item.suggestion,
				score: Number.MAX_SAFE_INTEGER,
			};
			const beforeTask = structuredClone(item.task);
			const result = guard.validate({ task: item.task, candidate, suggestion, role: item.role });
			expect(result.allowed, item.name).toBe(false);
			expect(result.reasons.length, item.name).toBeGreaterThan(0);
			expect(item.task).toEqual(beforeTask);
		}
		expect(cases).toHaveLength(10);
	});

	test("does not infer a route change from a failed preclassifier signal", () => {
		const result = preclassifyTask({ description: "ordinary local task" });
		expect(result.path).toBe("FAST");
		const report = calibratePolicy({
			observations: [
				{
					observation_id: "no-preclassifier-history",
					task_type: "planning",
					source: "fixture",
					evidence_refs: ["evidence:no-preclassifier-history"],
				},
			],
		});
		expect(report.findings.find((finding) => finding.category === "preclassifier_false_negative")).toMatchObject({
			status: "insufficient_data",
		});
	});
});
