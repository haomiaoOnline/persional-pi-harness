export const PLAN_REGRESSION_DATASET_SCHEMA_VERSION = "t15.3.v1" as const;

export type PlanRegressionCategory =
	| "over_decomposition"
	| "wrong_worker"
	| "unnecessary_handoff"
	| "retry_replan_overuse"
	| "preclassifier_false_negative"
	| "decision_record_missing";

export type PlanRegressionStatus = "OPEN" | "CORRECTED" | "RETIRED";

export interface PlanRegressionExecutionRef {
	run_id?: string;
	trace_id?: string;
}

export interface PlanRegressionReplaySpec {
	input: Record<string, string | number | boolean>;
	expected_before: string;
	expected_after: string;
	correction_id: string;
}

export interface PlanRegressionCase {
	schema_version: typeof PLAN_REGRESSION_DATASET_SCHEMA_VERSION;
	id: string;
	category: PlanRegressionCategory;
	task_id: string;
	execution_ref: PlanRegressionExecutionRef;
	decision_ref: string;
	predicted_path: string;
	actual_outcome: string;
	missed_signal: string;
	correction: string;
	rule_delta: {
		before: string;
		after: string;
	};
	evidence_refs: string[];
	status: PlanRegressionStatus;
	created_at: string;
	replay?: PlanRegressionReplaySpec;
}

export interface PlanRegressionCaseInput extends Omit<PlanRegressionCase, "schema_version"> {
	schema_version?: typeof PLAN_REGRESSION_DATASET_SCHEMA_VERSION;
}

export interface PlanRegressionReplayResult {
	case_id: string;
	correction_id: string;
	before: string;
	after: string;
	expected_before: string;
	expected_after: string;
	changed_behavior: boolean;
	passed: boolean;
}

export interface PlanRegressionDatasetSummary {
	schema_version: typeof PLAN_REGRESSION_DATASET_SCHEMA_VERSION;
	case_count: number;
	category_counts: Record<PlanRegressionCategory, number>;
	status_counts: Record<PlanRegressionStatus, number>;
	preclassifier_false_negative_count: number;
	external_gap_registry_mixed: false;
	evidence_refs: string[];
}

const CATEGORIES: readonly PlanRegressionCategory[] = [
	"over_decomposition",
	"wrong_worker",
	"unnecessary_handoff",
	"retry_replan_overuse",
	"preclassifier_false_negative",
	"decision_record_missing",
];
const STATUSES: readonly PlanRegressionStatus[] = ["OPEN", "CORRECTED", "RETIRED"];
const GAP_REFERENCE_PATTERN = /\bgap\s*[-_ ]?\s*(?:01|03)\b/i;
const EXTERNAL_GAP_PATTERN = /known[_-]?gaps?(?:\.ya?ml)?|external[_-]?gap|runtime[_-]?identity/i;
const FAULT_INJECTION_PATTERN = /intentional(?:ly)?\s+(?:crash|fault)|fault\s+injection|crash\s+recovery/i;
const SENSITIVE_PATTERN = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|凭证|密钥|密码)/i;

function requiredText(value: string | undefined, field: string): string {
	if (!value || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	if (SENSITIVE_PATTERN.test(value)) throw new Error(`${field} contains sensitive material`);
	return value;
}

function validateReference(reference: string, field: string): string {
	const value = requiredText(reference, field);
	if (GAP_REFERENCE_PATTERN.test(value) || EXTERNAL_GAP_PATTERN.test(value))
		throw new Error(`${field} cannot reference the external gap registry`);
	return value;
}

function validateCase(input: PlanRegressionCaseInput): PlanRegressionCase {
	if ((input.schema_version ?? PLAN_REGRESSION_DATASET_SCHEMA_VERSION) !== PLAN_REGRESSION_DATASET_SCHEMA_VERSION)
		throw new Error(`unsupported regression dataset schema: ${input.schema_version}`);
	if (!CATEGORIES.includes(input.category)) throw new Error(`unknown plan regression category: ${input.category}`);
	if (!STATUSES.includes(input.status)) throw new Error(`unknown plan regression status: ${input.status}`);
	const taskId = requiredText(input.task_id, "task_id");
	const id = requiredText(input.id, "id");
	const decisionRef = validateReference(input.decision_ref, "decision_ref");
	const evidenceRefs = input.evidence_refs.map((ref, index) => validateReference(ref, `evidence_refs[${index}]`));
	if (evidenceRefs.length === 0) throw new Error("evidence_refs must not be empty");
	const executionRef = input.execution_ref;
	if (!executionRef || (!executionRef.run_id && !executionRef.trace_id))
		throw new Error("execution_ref requires run_id or trace_id");
	if (executionRef.run_id) requiredText(executionRef.run_id, "execution_ref.run_id");
	if (executionRef.trace_id) requiredText(executionRef.trace_id, "execution_ref.trace_id");
	const strings = [
		input.predicted_path,
		input.actual_outcome,
		input.missed_signal,
		input.correction,
		input.rule_delta.before,
		input.rule_delta.after,
	];
	for (const [index, value] of strings.entries()) requiredText(value, `case_text[${index}]`);
	const allText = [taskId, decisionRef, ...evidenceRefs, ...strings].join(" ");
	if (GAP_REFERENCE_PATTERN.test(allText) || EXTERNAL_GAP_PATTERN.test(allText))
		throw new Error("plan regression cases cannot mix external/provider gap records");
	if (FAULT_INJECTION_PATTERN.test(allText))
		throw new Error("fault-injection and crash-recovery records are not plan regressions");
	if (input.category === "preclassifier_false_negative" && input.predicted_path !== "FAST")
		throw new Error("T2.0-A preclassifier false-negative cases must have predicted_path FAST");
	if (input.replay) {
		requiredText(input.replay.correction_id, "replay.correction_id");
		requiredText(input.replay.expected_before, "replay.expected_before");
		requiredText(input.replay.expected_after, "replay.expected_after");
		if (Object.keys(input.replay.input).length === 0) throw new Error("replay.input must not be empty");
		for (const [key, value] of Object.entries(input.replay.input)) {
			requiredText(key, "replay.input key");
			if (typeof value === "string") requiredText(value, `replay.input.${key}`);
			if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`replay.input.${key} is not finite`);
		}
	}
	if (!/^\d{4}-\d{2}-\d{2}T/.test(input.created_at)) throw new Error("created_at must be an ISO timestamp");
	return structuredClone({
		...input,
		schema_version: PLAN_REGRESSION_DATASET_SCHEMA_VERSION,
		task_id: taskId,
		id,
		decision_ref: decisionRef,
		evidence_refs: evidenceRefs,
		execution_ref: { ...executionRef },
	});
}

export class PlanRegressionDataset {
	private readonly cases = new Map<string, PlanRegressionCase>();

	constructor(initial: readonly PlanRegressionCaseInput[] = []) {
		for (const input of initial) {
			const regression = validateCase(input);
			if (this.cases.has(regression.id)) throw new Error(`duplicate plan regression case: ${regression.id}`);
			this.cases.set(regression.id, regression);
		}
	}

	ingest(input: PlanRegressionCaseInput): PlanRegressionCase {
		const regression = validateCase(input);
		if (this.cases.has(regression.id)) throw new Error(`duplicate plan regression case: ${regression.id}`);
		this.cases.set(regression.id, regression);
		return structuredClone(regression);
	}

	get(caseId: string): PlanRegressionCase | undefined {
		const regression = this.cases.get(caseId);
		return regression ? structuredClone(regression) : undefined;
	}

	list(): PlanRegressionCase[] {
		return [...this.cases.values()]
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((regression) => structuredClone(regression));
	}

	summary(): PlanRegressionDatasetSummary {
		const cases = this.list();
		const categoryCounts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
			PlanRegressionCategory,
			number
		>;
		const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
			PlanRegressionStatus,
			number
		>;
		for (const regression of cases) {
			categoryCounts[regression.category] += 1;
			statusCounts[regression.status] += 1;
		}
		return {
			schema_version: PLAN_REGRESSION_DATASET_SCHEMA_VERSION,
			case_count: cases.length,
			category_counts: categoryCounts,
			status_counts: statusCounts,
			preclassifier_false_negative_count: categoryCounts.preclassifier_false_negative,
			external_gap_registry_mixed: false,
			evidence_refs: [...new Set(cases.flatMap((regression) => regression.evidence_refs))].sort(),
		};
	}
}

export type PlanRegressionReplayEvaluator = (
	input: Readonly<Record<string, string | number | boolean>>,
	policy: "before" | "after",
) => string;

export function replayPlanRegressionCase(
	regression: PlanRegressionCase,
	evaluate: PlanRegressionReplayEvaluator,
): PlanRegressionReplayResult {
	if (!regression.replay) throw new Error(`regression case has no replay spec: ${regression.id}`);
	const before = evaluate(structuredClone(regression.replay.input), "before");
	const after = evaluate(structuredClone(regression.replay.input), "after");
	const changedBehavior = before !== after;
	return {
		case_id: regression.id,
		correction_id: regression.replay.correction_id,
		before,
		after,
		expected_before: regression.replay.expected_before,
		expected_after: regression.replay.expected_after,
		changed_behavior: changedBehavior,
		passed:
			changedBehavior && before === regression.replay.expected_before && after === regression.replay.expected_after,
	};
}

/** Deterministic replay used by the real Phase 13 decision-record case. */
export function replayDecisionRecordAdmission(
	input: Readonly<Record<string, string | number | boolean>>,
	policy: "before" | "after",
): string {
	const count = input.decision_record_count;
	if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return "invalid_observation";
	if (policy === "before") return "usable_for_calibration";
	return count > 0 ? "usable_for_calibration" : "insufficient_data";
}
