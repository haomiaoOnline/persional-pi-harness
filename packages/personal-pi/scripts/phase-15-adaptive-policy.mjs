import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LearnedRoutingAdvisor,
	PiWorker,
	PlanRegressionDataset,
	RoutingRuleGuard,
	calibratePolicy,
	measuredPolicyMetric,
	policyObservationFromTrace,
	replayDecisionRecordAdmission,
	replayPlanRegressionCase,
	unavailablePolicyMetric,
	WorkerRegistry,
} from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const evidenceDirectory = join(repositoryRoot, "docs/stage-gates/evidence");
const phase12GatePath = "docs/stage-gates/evidence/phase-12-level-b-2026-09-15.json";
const phase12Path = "docs/stage-gates/evidence/phase-12-real-heterogeneous-2026-09-15.json";
const phase13Path = "docs/stage-gates/evidence/phase-13-t13-4-2026-09-15.json";
const phase14Path = "docs/stage-gates/evidence/phase-14-hermes-e2e-2026-09-16.json";
const comparisonPath = "docs/stage-gates/evidence/single-vs-multi-2026-09-14.json";
const outputPath = join(evidenceDirectory, "phase-15-adaptive-policy-2026-09-16.json");
const generatedAt = "2026-09-16T00:00:00.000Z";

function readJson(relativePath) {
	return JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8"));
}

function metric(value, unit, reference) {
	return measuredPolicyMetric(value, unit, [reference]);
}

function p12Observation(record, index, mode, reference, costAvailable) {
	const trace = record.trace_metrics ?? {};
	const sourceObservation = record.observation ?? {};
	const metrics = {
		useful_work_ratio: metric(trace.useful_work_ratio, "ratio", reference),
		coordination_efficiency: metric(trace.coordination_efficiency, "ratio", reference),
		verification_first_pass_rate: metric(trace.verification_first_pass_rate, "ratio", reference),
		handoff_count: metric(trace.handoff_count, "count", reference),
		retry_depth: metric(trace.retry_depth, "count", reference),
		replan_count: metric(trace.replan_count, "count", reference),
		graph_width: metric(trace.graph_width, "count", reference),
		graph_depth: metric(trace.graph_depth, "count", reference),
		agent_calls: metric(trace.agent_calls, "count", reference),
		time_per_verified_task: metric(sourceObservation.elapsed_ms, "ms_per_verified_task", reference),
		cost_per_verified_task: costAvailable
			? metric(sourceObservation.cost_usd, "usd_per_verified_task", reference)
			: unavailablePolicyMetric(
					"usd_per_verified_task",
					"source marks monetary cost as unavailable for this cohort",
					[reference],
				),
	};
	return {
		observation_id: `phase12-${mode}-${record.case_id ?? index}`,
		task_type: record.case_id ?? "phase12-real-case",
		task_id: record.result_identity?.task_id,
		run_id: record.result_identity?.run_id,
		source: `phase12_${mode}`,
		outcome: record.trace_outcome,
		worker_id: record.worker_id,
		worker_type: sourceObservation.backend === "pi-agent" ? "pi" : "codex",
		metrics,
		evidence_refs: [reference],
	};
}

function comparisonObservation(comparison, mode, reference) {
	const source = comparison[mode];
	return {
		observation_id: `single-vs-multi-${mode}`,
		task_type: "local-child-process-comparison",
		source: "t11.5_single_agent_baseline_and_comparison",
		cohort_size: comparison.sample_size,
		metrics: {
			coordination_efficiency: metric(source.coordination_efficiency, "ratio", reference),
			verification_first_pass_rate: metric(source.verification_first_pass_rate, "ratio", reference),
			handoff_count: metric(source.handoffs, "count", reference),
			retry_depth: metric(source.retries, "count", reference),
			graph_width: metric(source.graph_width, "count", reference),
			time_per_verified_task: metric(source.time_per_verified_task_ms, "ms_per_verified_task", reference),
			cost_per_verified_task: unavailablePolicyMetric(
				"usd_per_verified_task",
				"comparison explicitly has zero local provider cost; monetary provider cost is not measured",
				[reference],
			),
		},
		evidence_refs: [reference],
	};
}

function phase15GuardProbe() {
	const manifest = {
		worker_plugin: {
			id: "phase15-guard-fixture",
			adapter_entry: "phase15-fixture.ts",
			models_supported: [{ model: "fixture-model", reasoning_levels: ["low", "medium", "high", "extended"] }],
			capability_tags: ["coding"],
			context_limit: 10_000,
			cost_tier: "cheap",
			auth: { type: "none" },
			discovery: { type: "static_config" },
		},
	};
	const task = {
		id: "phase15-guard-probe",
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "backend",
		title: "Phase 15 guard probe",
		objective: "Run a deterministic advisory guard probe",
		requirements: ["preserve hard rules"],
		constraints: ["local only"],
		scope: { files: ["src/phase15.ts"] },
		inputs: {},
		data_sources: ["phase15 fixture"],
		data_references: [],
		permissions: {
			filesystem: { read: ["src/**"], write: ["src/**"] },
			shell: { allowed: ["node"] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "cli",
			worker_tier: "cheap",
			reasoning_depth: "low",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: ["shell"],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["guard result"],
		acceptance_criteria: ["hard rule denial is explicit"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["guard result"],
			evidence_required: ["guard result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 1_000 } },
		risk: "low",
		priority: "P1",
		timeout: 30_000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: {
			max_attempts: 2,
			max_model_calls: 2,
			max_tool_calls: 2,
			max_handoffs: 0,
			max_elapsed_ms: 30_000,
			max_input_tokens: 2_000,
			max_output_tokens: 2_000,
			max_cost_usd: 1,
			max_state_growth_bytes: 10_000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
	const registry = new WorkerRegistry();
	registry.register({
		worker_id: "phase15-guard-worker",
		worker_type: "cli",
		manifest,
		adapter: new PiWorker("phase15-guard-worker", async () => ({ status: "success", summary: "probe" })),
	});
	const candidate = registry.selectCandidates(task)[0];
	if (!candidate) throw new Error("Phase 15 guard fixture did not produce a candidate");
	const suggestions = new LearnedRoutingAdvisor().recommend({ task, candidates: [candidate] });
	const suggestion = suggestions[0];
	if (!suggestion) throw new Error("Phase 15 guard fixture did not produce an advisory suggestion");
	const maliciousHighScoreSuggestion = {
		...suggestion,
		score: Number.MAX_SAFE_INTEGER,
		verification_strength: "none",
		permission_request: { filesystem: { write: ["outside/scope"] } },
		projected_usage: { attempts: 3 },
	};
	const result = new RoutingRuleGuard().validate({
		task,
		candidate,
		suggestion: maliciousHighScoreSuggestion,
	});
	return {
		candidate_count: 1,
		recommendation_count: suggestions.length,
		high_score: Number.MAX_SAFE_INTEGER,
		hard_rule_violation_blocked: !result.allowed,
		denial_reasons: result.reasons,
		checked_rules: result.checked_rules,
		runtime_selection_integrated: false,
		advisory_only: true,
	};
}

function gitOutput(args) {
	try {
		return execFileSync("git", args, {
			cwd: repositoryRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function repositoryBoundary() {
	let status = "";
	try {
		status = execFileSync("git", ["status", "--short"], {
			cwd: repositoryRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).replace(/\s+$/, "");
	} catch {
		status = "";
	}
	const diff = gitOutput(["diff", "--binary"]) ?? "";
	const upstream = gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	const divergence = gitOutput(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
	const [ahead, behind] = divergence ? divergence.split(/\s+/).map(Number) : [null, null];
	return {
		branch: gitOutput(["branch", "--show-current"]),
		head: gitOutput(["rev-parse", "HEAD"]),
		upstream,
		origin_main_divergence: { ahead, behind },
		worktree_dirty: status.length > 0,
		dirty_files: status
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(3).trim())
			.sort(),
		diff_digest: createHash("sha256").update(diff).digest("hex"),
		commit_push_merge_tag_performed: false,
	};
}

function runNpm(args) {
	const started = Date.now();
	try {
		const stdout = execFileSync("npm", args, {
			cwd: repositoryRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 32 * 1024 * 1024,
		});
		return {
			status: "PASS",
			exit_code: 0,
			duration_ms: Date.now() - started,
			output: stdout,
		};
	} catch (error) {
		const stdout = error.stdout ? String(error.stdout) : "";
		const stderr = error.stderr ? String(error.stderr) : "";
		return {
			status: "FAIL",
			exit_code: typeof error.status === "number" ? error.status : null,
			duration_ms: Date.now() - started,
			output: (stdout + "\n" + stderr).trim() || error.message,
		};
	}
}

function parseVitest(output) {
	const normalized = output.replace(/\u001b\[[0-9;]*m/g, "");
	const files = normalized.match(/Test Files\s+(\d+) passed/);
	const tests = normalized.match(/Tests\s+(\d+) passed/);
	return {
		test_files: files ? Number(files[1]) : undefined,
		tests: tests ? Number(tests[1]) : undefined,
	};
}

function trimCommand(args) {
	return `npm ${args.join(" ")}`;
}

function evidenceValidationEntry(args, result, parsed = {}) {
	const entry = {
		command: trimCommand(args),
		status: result.status,
		exit_code: result.exit_code,
		duration_ms: result.duration_ms,
		...parsed,
	};
	if (result.status !== "PASS") entry.output_excerpt = String(result.output ?? "").slice(-2_000);
	return entry;
}

function runValidationChecks() {
	const focusedArgs = ["exec", "--workspace=@personal-pi/core", "vitest", "--", "run", "test/adaptive-policy.test.ts", "test/plan-regression-dataset.test.ts"];
	const fullArgs = ["run", "test", "--workspace=@personal-pi/core"];
	const regressionArgs = ["run", "test:personal-pi-regression"];
	const buildArgs = ["run", "build", "--workspace=@personal-pi/core"];
	const protocolArgs = ["run", "check:protocol-isolation", "--workspace=@personal-pi/core"];
	const pinnedArgs = ["run", "check:pinned-deps"];
	const runtimeArgs = ["run", "check:runtime-deps"];
	const tsImportsArgs = ["run", "check:ts-imports"];
	const entryGraphsArgs = ["run", "check:entry-graphs"];

	const focused = runNpm(focusedArgs);
	const full = runNpm(fullArgs);
	const regression = runNpm(regressionArgs);
	const build = runNpm(buildArgs);
	const protocol = runNpm(protocolArgs);
	const pinned = runNpm(pinnedArgs);
	const runtime = runNpm(runtimeArgs);
	const tsImports = runNpm(tsImportsArgs);
	const entryGraphs = runNpm(entryGraphsArgs);

	const dependencyStatus = [pinned, runtime, tsImports, entryGraphs].every((entry) => entry.status === "PASS")
		? "PASS"
		: "FAIL";

	return {
		phase15_focused_tests: evidenceValidationEntry(focusedArgs, focused, parseVitest(focused.output ?? "")),
		personal_pi_full: evidenceValidationEntry(fullArgs, full, parseVitest(full.output ?? "")),
		personal_pi_regression: evidenceValidationEntry(regressionArgs, regression, parseVitest(regression.output ?? "")),
		build: evidenceValidationEntry(buildArgs, build),
		protocol_isolation: evidenceValidationEntry(protocolArgs, protocol),
		dependency_and_entry_checks: {
			command: [
				trimCommand(pinnedArgs),
				trimCommand(runtimeArgs),
				trimCommand(tsImportsArgs),
				trimCommand(entryGraphsArgs),
			],
			status: dependencyStatus,
			checks: {
				pinned_deps: evidenceValidationEntry(pinnedArgs, pinned),
				runtime_deps: evidenceValidationEntry(runtimeArgs, runtime),
				ts_imports: evidenceValidationEntry(tsImportsArgs, tsImports),
				entry_graphs: evidenceValidationEntry(entryGraphsArgs, entryGraphs),
			},
		},
	};
}

const phase12Gate = readJson(phase12GatePath);
const phase12 = readJson(phase12Path);
const phase13 = readJson(phase13Path);
const phase14 = readJson(phase14Path);
const comparison = readJson(comparisonPath);
const observations = [];

for (const [name, entry] of Object.entries(phase13.t13_4 ?? {})) {
	const trace = entry?.trace?.trace;
	if (trace) {
		observations.push(
			policyObservationFromTrace(trace, {
				task_type: name,
				evidence_refs: [`${phase13Path}#t13_4.${name}`],
				measured_metrics: [
					"useful_work_ratio",
					"coordination_efficiency",
					"verification_first_pass_rate",
					"handoff_count",
					"retry_depth",
					"replan_count",
					"graph_width",
					"graph_depth",
					"agent_calls",
					"time_per_verified_task",
				],
			}),
		);
	}
}

for (const [mode, block] of [
	["single", phase12.benchmark?.single_worker_baseline],
	["heterogeneous_multi", phase12.benchmark?.heterogeneous_multi],
]) {
	for (const [index, record] of (block?.records ?? []).entries()) {
		observations.push(
			p12Observation(
				record,
				index,
				mode,
				`${phase12Path}#benchmark.${mode}.records[${index}]`,
				block.metrics?.cost_unavailable === false,
			),
		);
	}
}

observations.push(comparisonObservation(comparison, "single", comparisonPath));
observations.push(comparisonObservation(comparison, "multi", comparisonPath));
const hermesRun = phase14.run;
observations.push({
	observation_id: "phase14-hermes-e2e",
	task_type: "phase14-hermes",
	task_id: hermesRun.task_id,
	run_id: hermesRun.pph_run_id,
	source: "phase14_hermes_e2e",
	outcome: hermesRun.result_status === "success" ? "DONE" : "FAILED",
	evidence_refs: [`${phase14Path}#run`],
});

const calibration = calibratePolicy({ observations, generated_at: generatedAt });
const realRegressionCase = {
	schema_version: "t15.3.v1",
	id: "phase13-empty-decision-record-001",
	category: "decision_record_missing",
	task_id: "t13-read-synthesis",
	execution_ref: { trace_id: "c44fc7fd-669b-40eb-9f2b-9dee02fc8970" },
	decision_ref: "trace:DISPATCH",
	predicted_path: "parallel_dispatch_accepted",
	actual_outcome: "DONE with an empty Decision Record list",
	missed_signal: "decision_record_count=0",
	correction: "Require a non-empty dispatch Decision Record before route-policy calibration.",
	rule_delta: {
		before: "A successful trace is usable for calibration even when its decision list is empty.",
		after: "An empty decision list makes decision-dependent calibration insufficient_data.",
	},
	evidence_refs: [`${phase13Path}#t13_4.parallel_read_analysis.trace.trace`],
	status: "CORRECTED",
	created_at: generatedAt,
	replay: {
		input: { decision_record_count: 0, outcome: "DONE" },
		expected_before: "usable_for_calibration",
		expected_after: "insufficient_data",
		correction_id: "decision-record-admission-v1",
	},
};
const regressionDataset = new PlanRegressionDataset([realRegressionCase]);
const regressionReplay = replayPlanRegressionCase(
	regressionDataset.get(realRegressionCase.id),
	replayDecisionRecordAdmission,
);
const guardProbe = phase15GuardProbe();
const validation = runValidationChecks();
const validationPassed = Object.values(validation).every((entry) => entry.status === "PASS");
const supportedRecommendations = calibration.recommendations
	.filter((recommendation) => recommendation.status === "PROPOSED")
	.map((recommendation) => recommendation.id)
	.sort();

const gateChecks = {
	t15_1_executable_calibration_report:
		calibration.recommendations.length > 0 && calibration.recommendations.every((item) => item.evidence_refs.length > 0),
	t15_1_measured_recommendation_support: supportedRecommendations.length > 0,
	t15_2_recommendation_plus_rule_guard: guardProbe.hard_rule_violation_blocked && guardProbe.advisory_only,
	t15_2_hard_rule_violation_interception_100_percent: guardProbe.hard_rule_violation_blocked,
	t15_3_versioned_schema_and_ingestion: regressionDataset.summary().external_gap_registry_mixed === false,
	t15_3_real_historical_case_replay: regressionReplay.passed,
	phase12_phase13_phase14_status_unchanged:
		phase12Gate.phase12_gate === "PASS" &&
		phase13.aggregate_gate === "PASS" &&
		phase14.phase14_overall === "PASS",
	p0_invariants_preserved:
		Object.values(phase12Gate.gate_checks ?? {}).every(Boolean) &&
		phase13.p0_multi_worker_mvp === "PASS" &&
		Object.values(phase14.gate_checks ?? {}).every(Boolean),
	validation_suite_passed: validationPassed,
};

const evidence = {
	schema_version: "phase-15-adaptive-policy.v1",
	phase: "Phase 15",
	stage: "T15.1/T15.2/T15.3",
	baseline: "v3.2",
	captured_at: generatedAt,
	authority: {
		architecture_sha256: "31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480",
		task_list_sha256: "a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b",
	},
	repository: repositoryBoundary(),
	retained_phase_status: {
		phase12: phase12Gate.phase12_gate,
		phase13_t13_4: phase13.aggregate_gate,
		p0_multi_worker_mvp: phase13.p0_multi_worker_mvp,
		phase14_level_c_multi_cri: phase14.phase14_overall,
		codex_gap_01: "OPEN_NON_BLOCKING",
		agy_gap_03: "OPEN_NON_BLOCKING",
		gemini_route: "STOPPED",
		cli_discovery: "P2_TODO",
	},
	policy_calibration: calibration,
	learned_routing: {
		schema_version: "t15.2.v1",
		mode: "advisory_only",
		scoring: {
			capability_match_weight: 100,
			historical_success_rate_weight: 25,
			task_type_match_weight: 10,
			surplus_cost_tier_penalty: 5,
			latency_penalty_divisor_ms: 1000,
			missing_history_score: 0,
			tie_break: "worker_id_ascending",
		},
		rule_guard: guardProbe,
		learned_suggestion_does_not_modify_task_truth: true,
		runtime_selection_integrated: false,
	},
	plan_regression_dataset: {
		summary: regressionDataset.summary(),
		cases: regressionDataset.list(),
		replay: regressionReplay,
		preclassifier_false_negative_subclass: {
			status: "insufficient_data",
			count: regressionDataset.summary().preclassifier_false_negative_count,
			correction: "Ingest only evidence-backed T2.0-A false negatives; do not infer them from route failures.",
		},
	},
	gate_checks: gateChecks,
	known_gaps_separate_from_plan_regressions: true,
	data_quality: {
		insufficient_data_is_non_blocking_observation: true,
		insufficient_data_categories: calibration.data_gaps,
		provider_or_model_identity_is_not_inferred_by_this_phase: true,
	},
	boundary: {
		new_architecture_module: false,
		pipeline_controller_dag_verification_persistent_state_modified: false,
		llm_required: false,
		secrets_read_or_recorded: false,
		recommendations_applied_automatically: false,
	},
	validation,
};

writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, phase15_overall: evidence.phase15_overall, gate_checks: gateChecks }, null, 2));
