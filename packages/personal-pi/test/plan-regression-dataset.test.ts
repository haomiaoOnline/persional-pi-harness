import { describe, expect, test } from "vitest";
import {
	type PlanRegressionCaseInput,
	PlanRegressionDataset,
	replayDecisionRecordAdmission,
	replayPlanRegressionCase,
} from "../src/index.ts";

const realDecisionRecordCase: PlanRegressionCaseInput = {
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
	evidence_refs: ["docs/stage-gates/evidence/phase-13-t13-4-2026-09-15.json"],
	status: "CORRECTED",
	created_at: "2026-09-16T00:00:00.000Z",
	replay: {
		input: { decision_record_count: 0, outcome: "DONE" },
		expected_before: "usable_for_calibration",
		expected_after: "insufficient_data",
		correction_id: "decision-record-admission-v1",
	},
};

describe("T15.3 Plan Regression Dataset", () => {
	test("ingests and replays a real Phase 13 decision-record case", () => {
		const dataset = new PlanRegressionDataset([realDecisionRecordCase]);
		const regression = dataset.get(realDecisionRecordCase.id);
		expect(regression).toBeDefined();
		const replay = replayPlanRegressionCase(regression!, replayDecisionRecordAdmission);
		expect(replay).toEqual({
			case_id: realDecisionRecordCase.id,
			correction_id: "decision-record-admission-v1",
			before: "usable_for_calibration",
			after: "insufficient_data",
			expected_before: "usable_for_calibration",
			expected_after: "insufficient_data",
			changed_behavior: true,
			passed: true,
		});
		expect(dataset.summary()).toMatchObject({
			case_count: 1,
			category_counts: { decision_record_missing: 1, preclassifier_false_negative: 0 },
			preclassifier_false_negative_count: 0,
			external_gap_registry_mixed: false,
		});
	});

	test("keeps T2.0-A false negatives as a distinct typed subtype", () => {
		const dataset = new PlanRegressionDataset([
			{
				...realDecisionRecordCase,
				id: "preclassifier-false-negative-001",
				category: "preclassifier_false_negative",
				predicted_path: "FAST",
				actual_outcome: "SLOW was required after the missed risk signal",
				missed_signal: "permission_model",
				correction: "Force repeated permission_model cases onto SLOW.",
				rule_delta: {
					before: "FAST is accepted when no high-risk keyword is matched.",
					after: "A repeated T2.0-A signal forces SLOW.",
				},
				replay: undefined,
			},
		]);
		expect(dataset.summary().preclassifier_false_negative_count).toBe(1);
	});

	test("rejects external gaps, fault injection, malformed references, and duplicate IDs", () => {
		const makeInvalid = (overrides: Partial<PlanRegressionCaseInput>) => ({
			...realDecisionRecordCase,
			...overrides,
		});
		expect(() => new PlanRegressionDataset([makeInvalid({ decision_ref: "GAP-03" })])).toThrow(
			/external gap registry|external\/provider gap/i,
		);
		expect(
			() => new PlanRegressionDataset([makeInvalid({ evidence_refs: ["docs/stage-gates/known_gaps.yaml"] })]),
		).toThrow(/external gap registry/i);
		expect(() => new PlanRegressionDataset([makeInvalid({ actual_outcome: "intentional crash recovery" })])).toThrow(
			/fault-injection|crash-recovery/i,
		);
		expect(() => new PlanRegressionDataset([makeInvalid({ execution_ref: {} })])).toThrow(/run_id or trace_id/);
		expect(() => new PlanRegressionDataset([realDecisionRecordCase, realDecisionRecordCase])).toThrow(/duplicate/);
	});

	test("fails replay when a proposed correction is a no-op", () => {
		const dataset = new PlanRegressionDataset([realDecisionRecordCase]);
		const regression = dataset.get(realDecisionRecordCase.id)!;
		const replay = replayPlanRegressionCase(regression, () => "usable_for_calibration");
		expect(replay.changed_behavior).toBe(false);
		expect(replay.passed).toBe(false);
	});
});
