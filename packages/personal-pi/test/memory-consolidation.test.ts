import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type DecisionRecord,
	type EvidenceRecord,
	FileColdEvidenceArchive,
	MemoryColdEvidenceArchive,
	MemoryConsolidator,
	type ResultContract,
	type RunRecord,
	TriggerGateway,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

function completedInput() {
	const task = makeV3Task("memory-task");
	const run: RunRecord = {
		id: "run-memory",
		task_id: task.id,
		attempt: 1,
		worker_id: "worker-memory",
		lease_epoch: 1,
		status: "SUCCEEDED",
		started_at: "2026-09-15T00:00:00.000Z",
	};
	const result: ResultContract = {
		task_id: task.id,
		run_id: run.id,
		worker_id: run.worker_id,
		lease_epoch: run.lease_epoch,
		status: "success",
		summary: "verified memory result",
		changed_files: ["tmp/memory.txt"],
		artifacts: ["tmp/memory.txt"],
		evidence: ["worker_result"],
		errors: [],
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
	return { task, run, result, evidence, decisions };
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
		expect(archive.read(record.archived_evidence_refs[0] ?? "")).toEqual(input.evidence);
	});

	test("treats duplicate content as a legal no-op and never deletes raw Evidence", () => {
		const input = completedInput();
		const archive = new MemoryColdEvidenceArchive();
		const consolidator = new MemoryConsolidator({ archive });
		const first = consolidator.consolidate(input);
		const second = consolidator.consolidate({ ...input, at: "2026-09-15T00:01:00.000Z" });

		expect(first.status).toBe("CONSOLIDATED");
		expect(second.status).toBe("NO_OP");
		expect(second.token_delta).toBe(0);
		expect(archive.list()).toHaveLength(1);
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
});
