import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type DecisionRecord,
	type EvidenceRecord,
	FileColdEvidenceArchive,
	type MasterHandoffReceipt,
	MemoryColdEvidenceArchive,
	MemoryConsolidator,
	type ResultContract,
	type RunRecord,
	TriggerGateway,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, UNKNOWN_MODEL_IDENTITY } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

function completedInput() {
	const task = makeV3Task("memory-task");
	const run: RunRecord = {
		id: "run-memory",
		task_id: task.id,
		attempt: 1,
		worker_id: "worker-memory",
		lease_epoch: 1,
		worker_status: AVAILABLE_WORKER_STATUS,
		model_identity: UNKNOWN_MODEL_IDENTITY,
		status: "SUCCEEDED",
		started_at: "2026-09-15T00:00:00.000Z",
	};
	const result: ResultContract = {
		task_id: task.id,
		run_id: run.id,
		worker_id: run.worker_id,
		lease_epoch: run.lease_epoch,
		status: "success",
		summary: "TASK_A_PRIVATE_TRANSCRIPT_MARKER verified memory result",
		changed_files: ["tmp/memory.txt"],
		artifacts: ["tmp/memory.txt"],
		evidence: ["worker_result"],
		errors: [],
		model_identity: UNKNOWN_MODEL_IDENTITY,
		work_receipt: {
			work_attempted: true,
			effects_count: 2,
			artifacts_created: ["tmp/memory.txt"],
			state_changed: true,
			no_op: false,
			evidence_refs: ["worker_result"],
		},
	};
	const evidence: EvidenceRecord = {
		id: "evidence-memory",
		task_id: task.id,
		run_id: run.id,
		captured_at: run.started_at,
		diff: { files: ["tmp/memory.txt"], digest: "diff" },
		commands: [],
		stdout: "verified memory result",
		stderr: "",
		artifacts: ["tmp/memory.txt"],
		evidence_types: ["worker_result"],
	};
	const decisions: DecisionRecord[] = [
		{
			id: "decision-memory",
			decision_type: "verification",
			decision: "PASS",
			reason: "verified",
			inputs: [task.id],
			at: run.started_at,
		},
	];
	const receipt: MasterHandoffReceipt = {
		task_id: task.id,
		status: "DONE",
		git_sha: "memory-git-sha",
		acceptance: "PASS",
		evidence_refs: [evidence.id],
		unresolved_risks: [],
		next_action: "proceed_to_next_task",
		work_receipt: structuredClone(result.work_receipt as NonNullable<ResultContract["work_receipt"]>),
	};
	return { task, run, result, evidence, receipt, decisions };
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T7.5 background memory consolidation", () => {
	test("uses Trigger Gateway, summarizes the receipt, archives raw Evidence and records token delta", () => {
		const input = completedInput();
		const archive = new MemoryColdEvidenceArchive();
		const trigger = new TriggerGateway();
		const consolidator = new MemoryConsolidator({ archive, trigger_gateway: trigger });
		const record = consolidator.consolidate(input);

		expect(record.status).toBe("CONSOLIDATED");
		expect(record.consolidation_task_id).toContain("memory-consolidation");
		expect(record.compact_decisions).toEqual(["verification:PASS"]);
		expect(record.token_delta).toBeGreaterThan(0);
		expect(record.summary).not.toContain("TASK_A_PRIVATE_TRANSCRIPT_MARKER");
		expect(consolidator.hotPath().items.join("\n")).not.toContain("TASK_A_PRIVATE_TRANSCRIPT_MARKER");
		expect(record.summary).toContain('"git_sha":"memory-git-sha"');
		expect(archive.read(record.archived_evidence_refs[0] ?? "")).toEqual(input.evidence);
	});

	test("treats duplicate content as a legal no-op and never deletes raw Evidence", () => {
		const input = completedInput();
		const archive = new MemoryColdEvidenceArchive();
		const consolidator = new MemoryConsolidator({ archive });
		const first = consolidator.consolidate(input);
		const second = consolidator.consolidate({ ...input, at: "2026-09-15T00:01:00.000Z" });
		const duplicateEvidence = consolidator.consolidate({
			...input,
			evidence: { ...input.evidence, id: "evidence-memory-duplicate" },
			receipt: { ...input.receipt, evidence_refs: ["evidence-memory-duplicate"] },
		});

		expect(first.status).toBe("CONSOLIDATED");
		expect(second.status).toBe("NO_OP");
		expect(second.token_delta).toBe(0);
		expect(duplicateEvidence.status).toBe("NO_OP");
		expect(duplicateEvidence.archived_evidence_refs).toHaveLength(1);
		expect(archive.list()).toHaveLength(2);
		expect(archive.read(duplicateEvidence.archived_evidence_refs[0] ?? "")?.id).toBe("evidence-memory-duplicate");
	});

	test("supports a file cold archive that remains readable after the cycle", () => {
		const input = completedInput();
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-cold-memory-"));
		temporaryDirectories.push(directory);
		const archive = new FileColdEvidenceArchive(directory);
		const record = new MemoryConsolidator({ archive }).consolidate(input);
		const reference = record.archived_evidence_refs[0] as string;
		const fileName = reference.slice("cold://file/".length);
		expect(readFileSync(join(directory, fileName), "utf8")).toContain("evidence-memory");
		expect(archive.read(reference)?.id).toBe("evidence-memory");
	});

	test("reuses Trigger Gateway for a deterministic scheduled cycle and retry", () => {
		const input = completedInput();
		const trigger = new TriggerGateway();
		const consolidator = new MemoryConsolidator({ trigger_gateway: trigger });
		const at = new Date("2026-09-15T08:00:00.000Z");
		const schedule = { id: "memory-daily", cron: "* * * * *" };

		const first = consolidator.consolidateFromSchedule(schedule, at, input);
		const retry = consolidator.consolidateFromSchedule(schedule, at, input);
		const miss = consolidator.consolidateFromSchedule({ id: "memory-never", cron: "61 * * * *" }, at, input);

		expect(first?.status).toBe("CONSOLIDATED");
		expect(first?.consolidation_task_id).toContain("memory-consolidation");
		expect(retry?.status).toBe("NO_OP");
		expect(retry?.token_delta).toBe(0);
		expect(miss).toBeUndefined();
	});
});
