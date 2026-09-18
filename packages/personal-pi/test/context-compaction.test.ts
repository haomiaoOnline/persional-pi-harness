import { describe, expect, test } from "vitest";
import {
	ContextCompactionPolicy,
	createEmptyPersistentState,
	type EvidenceRecord,
	validateContextCompactionReport,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

function evidence(taskId: string, id: string, revision: number, artifact: string): EvidenceRecord {
	return {
		id,
		task_id: taskId,
		run_id: `run-${revision}`,
		captured_at: "2026-09-19T00:00:00.000Z",
		diff: { files: [], digest: "diff" },
		commands: [],
		tool_results: [
			{
				exit_code: 1,
				status: "failure",
				duration: 1,
				stdout_summary: "bounded",
				stderr_summary: "bounded failure",
				error_fingerprint: `fp-${revision}`,
				relevant_stack_frames: [],
				artifact_id: `tool-artifact-${revision}`,
				truncated: true,
				next_cursor: null,
			},
		],
		stdout: "RAW_MARKER_MUST_NOT_APPEAR",
		stderr: "RAW_STACK_MUST_NOT_APPEAR",
		artifacts: [artifact],
		evidence_types: ["worker_result"],
		delivery_evidence_package: {
			baseline_commit: "base",
			actual_diff: { files: [], digest: "diff" },
			task_revision: revision,
			workspace_snapshot_ref: "snapshot",
			commands_and_exit_codes: [],
			test_output_summary: "bounded",
			artifact_digest: artifact,
			browser_or_container_verification: [],
			unfinished_items: [],
			provider_mode: "mock",
		},
	};
}

describe("T6.5 structured context compaction provenance", () => {
	test("uses only current-revision PASS Evidence and only Artifact refs", () => {
		const state = createEmptyPersistentState();
		const task = makeV3Task("compact-current", { task_revision: 2 });
		state.tasks.push({ ...task, state: "RUNNING", audit_log: [] });
		state.runs.push({
			id: "run-current",
			task_id: task.id,
			task_revision: 2,
			attempt: 2,
			worker_id: "worker",
			lease_epoch: 2,
			worker_status: { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" },
			model_identity: {
				requested_model: "model",
				platform_accepted_model: "model",
				observed_runtime_model: "model",
			},
			status: "RUNNING",
			started_at: "2026-09-19T00:00:00.000Z",
			workspace_commit_hash: "current-sha",
		});
		state.evidence.push(
			evidence(task.id, "evidence-stale", 1, "artifact-stale"),
			evidence(task.id, "evidence-current", 2, "artifact-current"),
		);
		state.verifications.push(
			{
				id: "verification-stale",
				task_id: task.id,
				evidence_id: "evidence-stale",
				status: "PASS",
				verification_confidence: "strong",
				task_revision: 1,
				commit_hash: "old-sha",
				diff_digest: "diff",
				artifact_digest: "artifact-stale",
				checked_at: "2026-09-18T00:00:00.000Z",
				checks: [],
				reasons: [],
			},
			{
				id: "verification-current",
				task_id: task.id,
				evidence_id: "evidence-current",
				status: "PASS",
				verification_confidence: "strong",
				task_revision: 2,
				commit_hash: "current-sha",
				diff_digest: "diff",
				artifact_digest: "artifact-current",
				checked_at: "2026-09-19T00:01:00.000Z",
				checks: [],
				reasons: [],
			},
		);
		state.handoff_receipts.push({
			task_id: task.id,
			status: "DONE",
			git_sha: "old-sha",
			acceptance: "PASS",
			evidence_refs: ["evidence-stale"],
			unresolved_risks: ["STALE_RISK"],
			next_action: "STALE_NEXT_ACTION",
			work_receipt: {
				work_attempted: true,
				effects_count: 0,
				artifacts_created: [],
				state_changed: false,
				no_op: true,
				no_op_reason: "old",
				evidence_refs: ["evidence-stale"],
			},
		});
		state.handoff_bindings[task.id] = {
			task_id: task.id,
			task_revision: 1,
			run_id: "run-old",
			provenance_stage: "verified",
			git_sha: "old-sha",
			work_receipt_digest: "old",
			evidence_refs: ["evidence-stale"],
		};

		const report = new ContextCompactionPolicy().buildReport({
			state,
			task_ids: [task.id],
			anchor_task_id: task.id,
		});

		expect(report.facts).toEqual([]);
		expect(report.verified_evidence).toEqual(["evidence-current"]);
		expect(report.open_tasks).toEqual([task.id]);
		expect(report.open_risks).toEqual([]);
		expect(report.next_action).toBe("");
		expect(report.git_sha).toBe("current-sha");
		expect(report.failed_attempts).toEqual([{ error_fingerprint: "fp-2" }]);
		expect(report.artifact_refs).toEqual(["artifact-current", "tool-artifact-2"]);
		expect(report.artifact_refs).not.toContain("evidence-current");
		expect(JSON.stringify(report)).not.toContain("RAW_MARKER_MUST_NOT_APPEAR");
		expect(JSON.stringify(report)).not.toContain("RAW_STACK_MUST_NOT_APPEAR");
	});

	test("strict schema rejects extra top-level fields", () => {
		const state = createEmptyPersistentState();
		const report = new ContextCompactionPolicy().buildReport({ state });
		expect(validateContextCompactionReport(report).valid).toBe(true);
		expect(validateContextCompactionReport({ ...report, extra: "not allowed" }).valid).toBe(false);
	});
});
