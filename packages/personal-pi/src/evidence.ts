import { randomUUID } from "node:crypto";
import { digestFor } from "./artifacts.ts";
import type { CommandEvidence, EvidenceRecord } from "./types.ts";

export interface EvidenceInput {
	task_id: string;
	run_id: string;
	changed_files?: string[];
	commands?: CommandEvidence[];
	stdout?: string;
	stderr?: string;
	test_result?: string;
	build_result?: string;
	artifacts?: string[];
	evidence_types?: string[];
	captured_at?: string;
}

export class EvidenceCollector {
	collect(input: EvidenceInput): EvidenceRecord {
		const changedFiles = [...(input.changed_files ?? [])];
		return {
			id: randomUUID(),
			task_id: input.task_id,
			run_id: input.run_id,
			captured_at: input.captured_at ?? new Date().toISOString(),
			diff: { files: changedFiles, digest: digestFor(changedFiles) },
			commands: (input.commands ?? []).map((command) => ({ ...command })),
			stdout: input.stdout ?? "",
			stderr: input.stderr ?? "",
			test_result: input.test_result,
			build_result: input.build_result,
			artifacts: [...(input.artifacts ?? [])],
			evidence_types: [...new Set(input.evidence_types ?? [])],
		};
	}
}

export function replayEvidence(evidence: EvidenceRecord): EvidenceRecord {
	return structuredClone(evidence);
}

export function evidenceHasType(evidence: EvidenceRecord, type: string): boolean {
	return evidence.evidence_types.includes(type);
}
