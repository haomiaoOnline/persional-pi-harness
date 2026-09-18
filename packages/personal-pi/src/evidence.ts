import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { digestFor } from "./artifacts.ts";
import { validateToolResultEnvelope } from "./tool-gateway.ts";
import type {
	CommandEvidence,
	DeliveryEvidencePackage,
	EvidenceRecord,
	JsonValue,
	ProviderMode,
	ToolResultEnvelope,
	ValidationResult,
	WorkspaceSnapshot,
} from "./types.ts";

const ProviderModeSchema = Type.Union([Type.Literal("mock"), Type.Literal("local"), Type.Literal("real")]);

export const DeliveryEvidencePackageSchema = Type.Object(
	{
		baseline_commit: Type.String({ minLength: 1 }),
		actual_diff: Type.Object(
			{
				files: Type.Array(Type.String()),
				digest: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		task_revision: Type.Integer({ minimum: 1 }),
		workspace_snapshot_ref: Type.String({ minLength: 1 }),
		commands_and_exit_codes: Type.Array(
			Type.Object(
				{
					command: Type.String({ minLength: 1 }),
					exit_code: Type.Integer(),
				},
				{ additionalProperties: false },
			),
		),
		test_output_summary: Type.String(),
		artifact_digest: Type.String({ minLength: 1 }),
		browser_or_container_verification: Type.Array(Type.String({ minLength: 1 })),
		unfinished_items: Type.Array(Type.String({ minLength: 1 })),
		provider_mode: ProviderModeSchema,
	},
	{ additionalProperties: false },
);

export function validateProviderMode(value: unknown): value is ProviderMode {
	return Value.Check(ProviderModeSchema, value);
}

export function validateDeliveryEvidencePackage(value: unknown): ValidationResult<DeliveryEvidencePackage> {
	if (Value.Check(DeliveryEvidencePackageSchema, value))
		return { valid: true, value: value as DeliveryEvidencePackage, errors: [] };
	return {
		valid: false,
		errors: [...Value.Errors(DeliveryEvidencePackageSchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path || "/"}: ${error.message}`;
		}),
	};
}

export function workspaceSnapshotRef(snapshot: WorkspaceSnapshot): string {
	return `workspace:${digestFor({
		commit_hash: snapshot.commit_hash,
		diff_digest: snapshot.diff_digest,
		artifact_digest: snapshot.artifact_digest,
	})}`;
}

export function deliveryEvidencePackageDigest(value: DeliveryEvidencePackage): string {
	return digestFor(value as unknown as JsonValue);
}

export function createDeliveryEvidencePackage(input: {
	baseline_commit: string;
	task_revision: number;
	snapshot: WorkspaceSnapshot;
	changed_files: readonly string[];
	commands: readonly CommandEvidence[];
	test_output_summary: string;
	browser_or_container_verification?: readonly string[];
	unfinished_items?: readonly string[];
	provider_mode: ProviderMode;
}): DeliveryEvidencePackage {
	const actualDiff = {
		files: [...input.changed_files],
		digest: input.snapshot.diff_digest,
	};
	const value: DeliveryEvidencePackage = {
		baseline_commit: input.baseline_commit,
		actual_diff: actualDiff,
		task_revision: input.task_revision,
		workspace_snapshot_ref: workspaceSnapshotRef(input.snapshot),
		commands_and_exit_codes: input.commands.map((command) => ({
			command: command.command,
			exit_code: command.exit_code,
		})),
		test_output_summary: input.test_output_summary,
		artifact_digest: input.snapshot.artifact_digest,
		browser_or_container_verification: [...new Set(input.browser_or_container_verification ?? [])],
		unfinished_items: [...new Set(input.unfinished_items ?? [])],
		provider_mode: input.provider_mode,
	};
	const validation = validateDeliveryEvidencePackage(value);
	if (!validation.valid) throw new Error(`invalid delivery evidence package: ${validation.errors.join("; ")}`);
	return structuredClone(value);
}

export interface EvidenceInput {
	task_id: string;
	run_id: string;
	changed_files?: string[];
	commands?: CommandEvidence[];
	tool_results?: ToolResultEnvelope[];
	stdout?: string;
	stderr?: string;
	test_result?: string;
	build_result?: string;
	artifacts?: string[];
	evidence_types?: string[];
	captured_at?: string;
	delivery_evidence_package?: DeliveryEvidencePackage;
}

export class EvidenceCollector {
	collect(input: EvidenceInput): EvidenceRecord {
		const changedFiles = [...(input.changed_files ?? [])];
		for (const toolResult of input.tool_results ?? []) {
			const validation = validateToolResultEnvelope(toolResult);
			if (!validation.valid) throw new Error(`invalid tool result envelope: ${validation.errors.join("; ")}`);
		}
		if (input.delivery_evidence_package) {
			const validation = validateDeliveryEvidencePackage(input.delivery_evidence_package);
			if (!validation.valid) throw new Error(`invalid delivery evidence package: ${validation.errors.join("; ")}`);
		}
		return {
			id: randomUUID(),
			task_id: input.task_id,
			run_id: input.run_id,
			captured_at: input.captured_at ?? new Date().toISOString(),
			diff: { files: changedFiles, digest: digestFor(changedFiles) },
			commands: (input.commands ?? []).map((command) => ({ ...command })),
			...(input.tool_results ? { tool_results: structuredClone(input.tool_results) } : {}),
			stdout: input.stdout ?? "",
			stderr: input.stderr ?? "",
			test_result: input.test_result,
			build_result: input.build_result,
			artifacts: [...(input.artifacts ?? [])],
			evidence_types: [...new Set(input.evidence_types ?? [])],
			...(input.delivery_evidence_package
				? { delivery_evidence_package: structuredClone(input.delivery_evidence_package) }
				: {}),
		};
	}
}

export function replayEvidence(evidence: EvidenceRecord): EvidenceRecord {
	return structuredClone(evidence);
}

export function evidenceHasType(evidence: EvidenceRecord, type: string): boolean {
	return evidence.evidence_types.includes(type);
}
