import type { DispatchMode, ExecutionTrace, TraceOutcome, WorkerTier, WorkerType } from "./types.ts";

/** T15.1 is deliberately an offline, deterministic analysis surface. */
export const POLICY_CALIBRATION_SCHEMA_VERSION = "t15.1.v1" as const;
export const POLICY_CALIBRATION_MIN_SAMPLE_SIZE = 3;

export type PolicyDataStatus = "measured" | "insufficient_data";
export type PolicyConfidence = "high" | "medium" | "low" | "insufficient_data";

export type PolicyMetricName =
	| "useful_work_ratio"
	| "coordination_efficiency"
	| "verification_first_pass_rate"
	| "cost_per_verified_task"
	| "time_per_verified_task"
	| "handoff_count"
	| "retry_depth"
	| "replan_count"
	| "graph_width"
	| "graph_depth"
	| "agent_calls";

export type PolicyFindingCategory =
	| "over_decomposition"
	| "wrong_worker"
	| "unnecessary_handoff"
	| "retry_replan_overuse"
	| "preclassifier_false_negative"
	| "decision_record_missing";

export interface ObservedPolicyMetric {
	value: number;
	unit: string;
	measured: boolean;
	evidence_refs: readonly string[];
	missing_reason?: string;
}

export interface PolicyObservationFlags {
	over_decomposed?: boolean;
	wrong_worker?: boolean;
	unnecessary_handoff?: boolean;
	retry_replan_overuse?: boolean;
	preclassifier_false_negative?: boolean;
}

/**
 * A normalized, bounded projection of one historical execution. It intentionally
 * has no prompt, context, credential, provider-secret, or raw output fields.
 */
export interface PolicyObservation {
	observation_id: string;
	task_type: string;
	task_id?: string;
	run_id?: string;
	source: string;
	outcome?: TraceOutcome;
	dispatch_mode?: DispatchMode;
	worker_id?: string;
	worker_type?: WorkerType;
	worker_tier?: WorkerTier;
	decision_record_count?: number;
	cohort_size?: number;
	metrics?: Partial<Record<PolicyMetricName, ObservedPolicyMetric>>;
	flags?: PolicyObservationFlags;
	evidence_refs: readonly string[];
}

export interface PolicyMetricSummary {
	status: PolicyDataStatus;
	unit: string;
	sample_count: number;
	cohort_count: number;
	value?: number;
	min?: number;
	max?: number;
	evidence_refs: string[];
	missing_reason?: string;
}

export interface PolicyFinding {
	id: string;
	category: PolicyFindingCategory;
	status: PolicyDataStatus;
	confidence: PolicyConfidence;
	sample_count: number;
	observed_count?: number;
	rate?: number;
	affected_task_types: string[];
	evidence_refs: string[];
	message: string;
	missing_reason?: string;
}

export interface PolicyRecommendation {
	id: string;
	category: PolicyFindingCategory;
	status: "PROPOSED" | "INSUFFICIENT_DATA";
	confidence: PolicyConfidence;
	affected_task_types: string[];
	evidence_refs: string[];
	before_rule_delta: string;
	after_rule_delta: string;
	rationale: string;
	guardrails: string[];
}

export interface PolicyCalibrationInput {
	observations: readonly PolicyObservation[];
	generated_at?: string;
}

export interface PolicyCalibrationReport {
	schema_version: typeof POLICY_CALIBRATION_SCHEMA_VERSION;
	kind: "policy_calibration_report";
	generated_at?: string;
	minimum_sample_size: number;
	observation_count: number;
	case_count: number;
	sources: string[];
	metrics: Record<PolicyMetricName, PolicyMetricSummary>;
	findings: PolicyFinding[];
	recommendations: PolicyRecommendation[];
	data_gaps: string[];
	boundary: {
		mode: "offline_advisory";
		llm_required: false;
		applies_recommendations_automatically: false;
		modifies_task_truth: false;
	};
}

const METRIC_UNITS: Record<PolicyMetricName, string> = {
	useful_work_ratio: "ratio",
	coordination_efficiency: "ratio",
	verification_first_pass_rate: "ratio",
	cost_per_verified_task: "usd_per_verified_task",
	time_per_verified_task: "ms_per_verified_task",
	handoff_count: "count",
	retry_depth: "count",
	replan_count: "count",
	graph_width: "count",
	graph_depth: "count",
	agent_calls: "count",
};

const METRIC_NAMES = Object.keys(METRIC_UNITS) as PolicyMetricName[];
const SENSITIVE_PATTERN = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|凭证|密钥|密码)/i;

function text(value: string | undefined, field: string): string {
	if (!value || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function finiteNonNegative(value: number, field: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
	return value;
}

function validateMetricValue(name: PolicyMetricName, value: number): number {
	const normalized = finiteNonNegative(value, `metrics.${name}.value`);
	if (
		(name === "useful_work_ratio" || name === "coordination_efficiency" || name === "verification_first_pass_rate") &&
		normalized > 1
	) {
		throw new Error(`metrics.${name}.value must be between 0 and 1`);
	}
	return normalized;
}

function validateObservation(observation: PolicyObservation): PolicyObservation {
	text(observation.observation_id, "observation_id");
	text(observation.task_type, "task_type");
	text(observation.source, "source");
	if (observation.task_id !== undefined) text(observation.task_id, "task_id");
	if (observation.run_id !== undefined) text(observation.run_id, "run_id");
	if (observation.evidence_refs.length === 0 || observation.evidence_refs.some((ref) => ref.trim().length === 0)) {
		throw new Error(`observation ${observation.observation_id} must contain evidence_refs`);
	}
	if (
		[observation.observation_id, observation.task_type, observation.source, ...observation.evidence_refs].some(
			(value) => SENSITIVE_PATTERN.test(value),
		)
	)
		throw new Error(`observation ${observation.observation_id} contains sensitive material`);
	const cohortSize = observation.cohort_size ?? 1;
	if (!Number.isInteger(cohortSize) || cohortSize < 1) throw new Error("cohort_size must be a positive integer");
	if (observation.decision_record_count !== undefined) {
		if (!Number.isInteger(observation.decision_record_count) || observation.decision_record_count < 0)
			throw new Error("decision_record_count must be a non-negative integer");
	}
	for (const [name, metric] of Object.entries(observation.metrics ?? {}) as [
		PolicyMetricName,
		ObservedPolicyMetric,
	][]) {
		if (!METRIC_UNITS[name]) throw new Error(`unknown policy metric: ${name}`);
		text(metric.unit, `metrics.${name}.unit`);
		if (metric.unit !== METRIC_UNITS[name]) throw new Error(`metrics.${name}.unit must be ${METRIC_UNITS[name]}`);
		if (typeof metric.measured !== "boolean") throw new Error(`metrics.${name}.measured must be boolean`);
		finiteNonNegative(metric.value, `metrics.${name}.value`);
		if (metric.measured) validateMetricValue(name, metric.value);
		if (metric.evidence_refs.some((ref) => ref.trim().length === 0))
			throw new Error(`metrics.${name}.evidence_refs contains an empty reference`);
	}
	return structuredClone({ ...observation, evidence_refs: [...observation.evidence_refs], cohort_size: cohortSize });
}

export function measuredPolicyMetric(
	value: number,
	unit: string,
	evidenceRefs: readonly string[] = [],
): ObservedPolicyMetric {
	return {
		value,
		unit,
		measured: true,
		evidence_refs: [...evidenceRefs],
	};
}

export function unavailablePolicyMetric(
	unit: string,
	reason: string,
	evidenceRefs: readonly string[] = [],
): ObservedPolicyMetric {
	return {
		value: 0,
		unit,
		measured: false,
		evidence_refs: [...evidenceRefs],
		missing_reason: reason,
	};
}

function confidenceFor(sampleCount: number): PolicyConfidence {
	if (sampleCount < POLICY_CALIBRATION_MIN_SAMPLE_SIZE) return "insufficient_data";
	if (sampleCount >= 10) return "high";
	if (sampleCount >= 5) return "medium";
	return "low";
}

function allEvidence(observations: readonly PolicyObservation[]): string[] {
	return [...new Set(observations.flatMap((observation) => observation.evidence_refs))].sort();
}

function affectedTypes(observations: readonly PolicyObservation[]): string[] {
	return [...new Set(observations.map((observation) => observation.task_type))].sort();
}

function metricSummary(name: PolicyMetricName, observations: readonly PolicyObservation[]): PolicyMetricSummary {
	const entries = observations.flatMap((observation) => {
		const metric = observation.metrics?.[name];
		if (!metric) return [];
		return [{ observation, metric }];
	});
	const measured = entries.filter(({ metric }) => metric.measured);
	const unit = METRIC_UNITS[name];
	const evidenceRefs = [
		...new Set(entries.flatMap(({ observation, metric }) => [...observation.evidence_refs, ...metric.evidence_refs])),
	].sort();
	const boundedEvidenceRefs = evidenceRefs.length > 0 ? evidenceRefs : allEvidence(observations);
	const sampleCount = measured.reduce((sum, { observation }) => sum + (observation.cohort_size ?? 1), 0);
	const cohortCount = measured.length;
	if (sampleCount < POLICY_CALIBRATION_MIN_SAMPLE_SIZE) {
		const reasons = entries
			.filter(({ metric }) => !metric.measured && metric.missing_reason)
			.map(({ metric }) => metric.missing_reason as string);
		return {
			status: "insufficient_data",
			unit,
			sample_count: sampleCount,
			cohort_count: cohortCount,
			evidence_refs: boundedEvidenceRefs,
			missing_reason:
				reasons[0] ??
				`only ${sampleCount} measured sample(s); at least ${POLICY_CALIBRATION_MIN_SAMPLE_SIZE} are required`,
		};
	}
	const weightedTotal = measured.reduce(
		(sum, { observation, metric }) => sum + metric.value * (observation.cohort_size ?? 1),
		0,
	);
	const values = measured.map(({ metric }) => metric.value);
	return {
		status: "measured",
		unit,
		sample_count: sampleCount,
		cohort_count: cohortCount,
		value: weightedTotal / sampleCount,
		min: Math.min(...values),
		max: Math.max(...values),
		evidence_refs: boundedEvidenceRefs,
	};
}

function flagFinding(category: PolicyFindingCategory, observations: readonly PolicyObservation[]): PolicyFinding {
	const flag =
		category === "over_decomposition"
			? "over_decomposed"
			: category === "wrong_worker"
				? "wrong_worker"
				: category === "unnecessary_handoff"
					? "unnecessary_handoff"
					: category === "retry_replan_overuse"
						? "retry_replan_overuse"
						: "preclassifier_false_negative";
	const entries = observations.filter((observation) => observation.flags?.[flag] !== undefined);
	const sampleCount = entries.reduce((sum, observation) => sum + (observation.cohort_size ?? 1), 0);
	const observedCount = entries.reduce(
		(sum, observation) => sum + (observation.flags?.[flag] === true ? (observation.cohort_size ?? 1) : 0),
		0,
	);
	const evidenceRefs = [...new Set(entries.flatMap((observation) => observation.evidence_refs))].sort();
	if (sampleCount < POLICY_CALIBRATION_MIN_SAMPLE_SIZE) {
		return {
			id: `finding-${category}`,
			category,
			status: "insufficient_data",
			confidence: "insufficient_data",
			sample_count: sampleCount,
			observed_count: observedCount,
			affected_task_types: affectedTypes(entries),
			evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : allEvidence(observations),
			message: `No sufficiently sized explicit ${category} cohort was recorded; no outcome was inferred from failure or coordination alone.`,
			missing_reason: `explicit ${flag} labels require at least ${POLICY_CALIBRATION_MIN_SAMPLE_SIZE} cases`,
		};
	}
	return {
		id: `finding-${category}`,
		category,
		status: "measured",
		confidence: confidenceFor(sampleCount),
		sample_count: sampleCount,
		observed_count: observedCount,
		rate: observedCount / sampleCount,
		affected_task_types: affectedTypes(entries),
		evidence_refs: evidenceRefs,
		message: `${observedCount}/${sampleCount} cases were explicitly labeled ${flag}.`,
	};
}

function decisionRecordFinding(observations: readonly PolicyObservation[]): PolicyFinding {
	const entries = observations.filter((observation) => observation.decision_record_count !== undefined);
	const sampleCount = entries.reduce((sum, observation) => sum + (observation.cohort_size ?? 1), 0);
	const missingCount = entries.reduce(
		(sum, observation) => sum + (observation.decision_record_count === 0 ? (observation.cohort_size ?? 1) : 0),
		0,
	);
	const evidenceRefs = [...new Set(entries.flatMap((observation) => observation.evidence_refs))].sort();
	if (sampleCount < POLICY_CALIBRATION_MIN_SAMPLE_SIZE) {
		return {
			id: "finding-decision-record-missing",
			category: "decision_record_missing",
			status: "insufficient_data",
			confidence: "insufficient_data",
			sample_count: sampleCount,
			affected_task_types: affectedTypes(entries),
			evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : allEvidence(observations),
			message: "Decision-record completeness cannot be calibrated from a sufficiently sized trace cohort.",
			missing_reason: `decision_record_count is available for only ${sampleCount} case(s)`,
		};
	}
	return {
		id: "finding-decision-record-missing",
		category: "decision_record_missing",
		status: "measured",
		confidence: confidenceFor(sampleCount),
		sample_count: sampleCount,
		observed_count: missingCount,
		rate: missingCount / sampleCount,
		affected_task_types: affectedTypes(entries),
		evidence_refs: evidenceRefs,
		message: `${missingCount}/${sampleCount} observed cases contain no Decision Record.`,
	};
}

function insufficientRecommendation(
	category: PolicyFindingCategory,
	finding: PolicyFinding,
	before: string,
	after: string,
	rationale: string,
): PolicyRecommendation {
	return {
		id: `recommendation-${category}-insufficient-data`,
		category,
		status: "INSUFFICIENT_DATA",
		confidence: "insufficient_data",
		affected_task_types: finding.affected_task_types.length > 0 ? finding.affected_task_types : ["unknown"],
		evidence_refs: finding.evidence_refs,
		before_rule_delta: before,
		after_rule_delta: after,
		rationale,
		guardrails: [
			"Do not infer a route change from missing observations.",
			"Collect an explicit label and an evidence reference before changing policy.",
		],
	};
}

function buildRecommendations(
	observations: readonly PolicyObservation[],
	findings: readonly PolicyFinding[],
	metrics: Record<PolicyMetricName, PolicyMetricSummary>,
): PolicyRecommendation[] {
	const recommendations: PolicyRecommendation[] = [];
	const decisionFinding = findings.find((finding) => finding.category === "decision_record_missing");
	if (decisionFinding?.status === "measured" && (decisionFinding.observed_count ?? 0) > 0) {
		recommendations.push({
			id: "recommendation-decision-record-gate",
			category: "decision_record_missing",
			status: "PROPOSED",
			confidence: decisionFinding.confidence,
			affected_task_types: decisionFinding.affected_task_types,
			evidence_refs: decisionFinding.evidence_refs,
			before_rule_delta: "No calibration admission rule requires a non-empty Decision Record.",
			after_rule_delta:
				"Require a dispatch Decision Record for route-policy calibration; otherwise mark decision-dependent metrics insufficient_data and do not change routing.",
			rationale: decisionFinding.message,
			guardrails: [
				"This is an evidence-admission rule, not an automatic Task or Persistent State mutation.",
				"Do not synthesize a missing decision or infer its Worker/model/provider fields.",
			],
		});
	}

	const coordinationMetric = metrics.coordination_efficiency;
	const retryMetric = metrics.retry_depth;
	if (retryMetric.status === "measured" && (retryMetric.value ?? 0) > 0) {
		recommendations.push({
			id: "recommendation-recovery-overhead-classification",
			category: "retry_replan_overuse",
			status: "PROPOSED",
			confidence: "low",
			affected_task_types: affectedTypes(observations),
			evidence_refs: retryMetric.evidence_refs,
			before_rule_delta: "Retry or handoff presence may be treated as evidence of overuse.",
			after_rule_delta:
				"Classify retry/handoff as overuse only with an explicit overuse label; preserve recovery traces as a separate cohort.",
			rationale: `Observed retry depth average is ${retryMetric.value}; coordination efficiency is ${coordinationMetric.status === "measured" ? coordinationMetric.value : "insufficient_data"}. Presence alone does not prove waste.`,
			guardrails: [
				"Never reduce max_attempts, max_handoffs, or replan budgets from this observation alone.",
				"Keep Loop Budget and recovery admission as hard controls.",
			],
		});
	}

	const categories: Array<[PolicyFindingCategory, string, string, string]> = [
		[
			"over_decomposition",
			"No explicit over-decomposition labels are available.",
			"Keep existing decomposition gates unchanged until explicit over-decomposition cases are collected.",
			"Do not infer over-decomposition from graph width alone.",
		],
		[
			"wrong_worker",
			"No explicit wrong-Worker labels are available.",
			"Keep Registry capability, role, reasoning, context, and tier checks unchanged until a labeled cohort exists.",
			"Do not infer wrong Worker from a failed result without a route decision and correction record.",
		],
		[
			"unnecessary_handoff",
			"No explicit unnecessary-handoff labels are available.",
			"Keep handoff admission and fencing unchanged until necessity is recorded per case.",
			"Do not classify crash recovery handoff as unnecessary.",
		],
		[
			"retry_replan_overuse",
			"No explicit retry/replan-overuse labels are available.",
			"Keep retry/replan bounds unchanged until an explicit overuse cohort exists.",
			"Do not classify bounded recovery as overuse.",
		],
		[
			"preclassifier_false_negative",
			"No T2.0-A preclassifier false-negative incidents are present in the supplied execution observations.",
			"Ingest T2.0-A incidents as a distinct subtype before changing FAST/SLOW policy.",
			"Never merge this subtype into Worker or external-gap failures.",
		],
	];
	for (const [category, before, after, rationale] of categories) {
		const finding = findings.find((item) => item.category === category);
		if (finding?.status === "insufficient_data")
			recommendations.push(insufficientRecommendation(category, finding, before, after, rationale));
	}
	return recommendations.sort((left, right) => left.id.localeCompare(right.id));
}

export function calibratePolicy(input: PolicyCalibrationInput): PolicyCalibrationReport {
	const observations = input.observations
		.map(validateObservation)
		.sort((left, right) => left.observation_id.localeCompare(right.observation_id));
	const metrics = Object.fromEntries(METRIC_NAMES.map((name) => [name, metricSummary(name, observations)])) as Record<
		PolicyMetricName,
		PolicyMetricSummary
	>;
	const findings = [
		flagFinding("over_decomposition", observations),
		flagFinding("wrong_worker", observations),
		flagFinding("unnecessary_handoff", observations),
		flagFinding("retry_replan_overuse", observations),
		flagFinding("preclassifier_false_negative", observations),
		decisionRecordFinding(observations),
	];
	const dataGaps = findings
		.filter((finding) => finding.status === "insufficient_data")
		.map((finding) => `${finding.category}: ${finding.missing_reason ?? finding.message}`)
		.sort();
	return {
		schema_version: POLICY_CALIBRATION_SCHEMA_VERSION,
		kind: "policy_calibration_report",
		...(input.generated_at ? { generated_at: input.generated_at } : {}),
		minimum_sample_size: POLICY_CALIBRATION_MIN_SAMPLE_SIZE,
		observation_count: observations.length,
		case_count: observations.reduce((sum, observation) => sum + (observation.cohort_size ?? 1), 0),
		sources: [...new Set(observations.map((observation) => observation.source))].sort(),
		metrics,
		findings,
		recommendations: buildRecommendations(observations, findings, metrics),
		data_gaps: dataGaps,
		boundary: {
			mode: "offline_advisory",
			llm_required: false,
			applies_recommendations_automatically: false,
			modifies_task_truth: false,
		},
	};
}

const TRACE_METRIC_NAMES: readonly PolicyMetricName[] = [
	"useful_work_ratio",
	"coordination_efficiency",
	"verification_first_pass_rate",
	"cost_per_verified_task",
	"time_per_verified_task",
	"handoff_count",
	"retry_depth",
	"replan_count",
	"graph_width",
	"graph_depth",
	"agent_calls",
];

export function policyObservationFromTrace(
	trace: ExecutionTrace,
	options: {
		task_type?: string;
		evidence_refs: readonly string[];
		measured_metrics?: readonly PolicyMetricName[];
		metric_evidence_refs?: Partial<Record<PolicyMetricName, readonly string[]>>;
	},
): PolicyObservation {
	const graph = trace.metrics.graph_efficiency;
	const measured = new Set(options.measured_metrics ?? []);
	const metrics = graph
		? Object.fromEntries(
				TRACE_METRIC_NAMES.map((name) => {
					const value = graph[name];
					return [
						name,
						measured.has(name)
							? measuredPolicyMetric(value, METRIC_UNITS[name], [
									...options.evidence_refs,
									...(options.metric_evidence_refs?.[name] ?? []),
								])
							: unavailablePolicyMetric(
									METRIC_UNITS[name],
									"the source did not provide independent provenance for this value",
									options.metric_evidence_refs?.[name] ?? options.evidence_refs,
								),
					];
				}),
			)
		: undefined;
	return {
		observation_id: `trace-${trace.trace_id}`,
		task_type: options.task_type ?? "unknown",
		task_id: trace.task_id,
		run_id: trace.run_id ?? trace.trace_id,
		source: "execution_trace",
		outcome: trace.outcome,
		decision_record_count: trace.decisions.length,
		metrics,
		evidence_refs: [...options.evidence_refs],
	};
}
