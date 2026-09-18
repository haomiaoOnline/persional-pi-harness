import { describe, expect, test } from "vitest";
import { ArtifactStore } from "../src/artifacts.ts";
import {
	buildMasterHandoffReceipt,
	createArchivedHandoffFailure,
	createBoundedHandoffFailure,
	MASTER_FAILURE_SUMMARY_MAX_LENGTH,
	validateMasterHandoffReceipt,
} from "../src/handoff.ts";
import type { MasterHandoffReceipt, WorkReceipt } from "../src/types.ts";

const workReceipt: WorkReceipt = {
	work_attempted: true,
	effects_count: 0,
	artifacts_created: [],
	state_changed: false,
	no_op: true,
	no_op_reason: "verification-only leaf task",
	evidence_refs: ["worker_result"],
};

function validReceipt(): MasterHandoffReceipt {
	return {
		task_id: "task-a",
		status: "DONE",
		git_sha: "abc123",
		acceptance: "PASS",
		evidence_refs: ["evidence-a"],
		unresolved_risks: [],
		next_action: "proceed_to_next_task",
		work_receipt: structuredClone(workReceipt),
	};
}

describe("T3.5 receipt-only Master handoff", () => {
	test("accepts only the exact Master-visible receipt shape", () => {
		const receipt = validReceipt();
		expect(validateMasterHandoffReceipt(receipt)).toMatchObject({ valid: true });

		for (const forbidden of [
			{ transcript: "raw worker transcript" },
			{ summary: "raw Result summary" },
			{ errors: ["raw Result error"] },
			{ evidence: { stdout: "raw evidence" } },
			{ resolved_context: { text: "prior Worker context" } },
			{ task: { id: "task-a", state: "DONE" } },
			{ run: { id: "run-a" } },
			{ result: { summary: "PipelineExecution Result" } },
			{ verification: { status: "PASS" } },
			{ trace: { events: [] } },
		]) {
			expect(validateMasterHandoffReceipt({ ...receipt, ...forbidden }).valid).toBe(false);
		}
	});

	test("builds only controller-selected fields and preserves nested WorkReceipt semantics", () => {
		const receipt = buildMasterHandoffReceipt({
			task_id: "task-a",
			status: "DONE",
			git_sha: "abc123",
			acceptance: "PASS",
			evidence_refs: ["evidence-a", "evidence-a"],
			unresolved_risks: ["bounded controller risk", "bounded controller risk"],
			next_action: "proceed_to_next_task",
			work_receipt: workReceipt,
		});

		expect(receipt).toEqual({
			...validReceipt(),
			unresolved_risks: ["bounded controller risk"],
		});
		expect(receipt.work_receipt).toEqual(workReceipt);
		expect(receipt).not.toHaveProperty("summary");
		expect(receipt).not.toHaveProperty("errors");
	});

	test("turns verbose failure material into a bounded fingerprint summary", () => {
		const marker = "TASK_A_PRIVATE_TRANSCRIPT_MARKER";
		const rawFailure = `${marker}\n${"stack line\n".repeat(2_000)}`;
		const failure = createBoundedHandoffFailure(rawFailure, ["artifact-a"], "worker_failed");

		expect(failure.error_summary.length).toBeLessThanOrEqual(MASTER_FAILURE_SUMMARY_MAX_LENGTH);
		expect(failure.error_summary).toContain("error_fingerprint=");
		expect(failure.error_summary).not.toContain(marker);
		expect(failure.artifact_refs).toEqual(["artifact-a"]);
		expect(() => createBoundedHandoffFailure(rawFailure, [])).toThrow("Artifact ref");
	});

	test("retains full failure detail only behind an Artifact ref", () => {
		const marker = "TASK_A_PRIVATE_TRANSCRIPT_MARKER";
		const artifacts = new ArtifactStore();
		const failure = createArchivedHandoffFailure({
			artifact_store: artifacts,
			task_id: "task-a",
			task_revision: 3,
			raw_failure_detail: {
				status: "failure",
				transcript: `${marker}:${"x".repeat(4_096)}`,
			},
		});
		const stored = artifacts.get(failure.artifact_refs[0] as string);

		expect(failure.error_summary).not.toContain(marker);
		expect(JSON.stringify(stored?.payload)).toContain(marker);
		expect(stored).toMatchObject({
			type: "worker_failure_detail",
			schema_version: 1,
			producer_task_id: "task-a",
			producer_task_revision: 3,
		});
	});

	test("rejects inconsistent completion and failure claims", () => {
		const receipt = validReceipt();
		expect(validateMasterHandoffReceipt({ ...receipt, status: "RUNNING", acceptance: "UNKNOWN" }).valid).toBe(false);
		expect(validateMasterHandoffReceipt({ ...receipt, acceptance: "UNKNOWN" }).valid).toBe(false);
		expect(
			validateMasterHandoffReceipt({
				...receipt,
				failure: { error_summary: "should not exist", artifact_refs: ["artifact-a"] },
			}).valid,
		).toBe(false);
		expect(validateMasterHandoffReceipt({ ...receipt, status: "FAILED" }).valid).toBe(false);
	});
});
