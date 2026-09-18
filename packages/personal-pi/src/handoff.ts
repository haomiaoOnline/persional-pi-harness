import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ArtifactStore } from "./artifacts.ts";
import { workReceiptErrors } from "./result.ts";
import type { JsonValue, MasterHandoffReceipt, ValidationResult, WorkReceipt } from "./types.ts";

export const MASTER_FAILURE_SUMMARY_MAX_LENGTH = 512;

const WorkReceiptSchema = Type.Object(
	{
		work_attempted: Type.Boolean(),
		effects_count: Type.Integer({ minimum: 0 }),
		artifacts_created: Type.Array(Type.String()),
		state_changed: Type.Boolean(),
		no_op: Type.Boolean(),
		no_op_reason: Type.Optional(Type.String({ minLength: 1 })),
		evidence_refs: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

const MasterHandoffStatusSchema = Type.Union([
	Type.Literal("DONE"),
	Type.Literal("FAILED"),
	Type.Literal("BLOCKED"),
	Type.Literal("CANCELLED"),
	Type.Literal("OBSOLETE"),
]);

const MasterAcceptanceStatusSchema = Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("UNKNOWN")]);

export const MasterHandoffReceiptSchema = Type.Object(
	{
		task_id: Type.String({ minLength: 1 }),
		status: MasterHandoffStatusSchema,
		git_sha: Type.String({ minLength: 1, maxLength: 256 }),
		acceptance: MasterAcceptanceStatusSchema,
		evidence_refs: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
		unresolved_risks: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { uniqueItems: true }),
		next_action: Type.String({ minLength: 1, maxLength: 512 }),
		work_receipt: WorkReceiptSchema,
		failure: Type.Optional(
			Type.Object(
				{
					error_summary: Type.String({ minLength: 1, maxLength: MASTER_FAILURE_SUMMARY_MAX_LENGTH }),
					artifact_refs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export interface MasterHandoffBuildInput {
	task_id: string;
	status: MasterHandoffReceipt["status"];
	git_sha: string;
	acceptance: MasterHandoffReceipt["acceptance"];
	evidence_refs: readonly string[];
	unresolved_risks: readonly string[];
	next_action: string;
	work_receipt: WorkReceipt;
	failure?: NonNullable<MasterHandoffReceipt["failure"]>;
}

function validationErrors(value: unknown): string[] {
	return [...Value.Errors(MasterHandoffReceiptSchema, value)].map((error) => {
		const path = "path" in error && typeof error.path === "string" ? error.path : "/";
		return `${path || "/"}: ${error.message}`;
	});
}

export function validateMasterHandoffReceipt(value: unknown): ValidationResult<MasterHandoffReceipt> {
	if (!Value.Check(MasterHandoffReceiptSchema, value)) return { valid: false, errors: validationErrors(value) };
	const receipt = value as MasterHandoffReceipt;
	const errors = workReceiptErrors(receipt.work_receipt);
	if (receipt.status === "DONE" && receipt.acceptance !== "PASS")
		errors.push("/acceptance: DONE handoff requires acceptance=PASS");
	if (receipt.status !== "DONE" && receipt.acceptance === "PASS")
		errors.push("/acceptance: acceptance=PASS requires status=DONE");
	if (receipt.status === "DONE" && receipt.failure)
		errors.push("/failure: DONE handoff must not include failure details");
	return errors.length === 0 ? { valid: true, value: receipt, errors: [] } : { valid: false, errors };
}

function boundedText(value: string, maxLength: number): string {
	const compact = value.trim().replace(/\s+/g, " ");
	return compact.slice(0, maxLength);
}

/**
 * Convert verbose/raw failure material into a Master-safe summary. The raw
 * content is hashed but never copied into the receipt; callers retain it only
 * behind the supplied Artifact refs.
 */
export function createBoundedHandoffFailure(
	rawFailureDetail: string,
	artifactRefs: readonly string[],
	classification = "worker_failure",
): NonNullable<MasterHandoffReceipt["failure"]> {
	const uniqueArtifactRefs = [...new Set(artifactRefs.filter((reference) => reference.trim().length > 0))];
	if (uniqueArtifactRefs.length === 0) throw new Error("Master handoff failure requires at least one Artifact ref");
	const fingerprint = createHash("sha256").update(rawFailureDetail).digest("hex").slice(0, 16);
	const prefix = boundedText(classification, 128) || "worker_failure";
	return {
		error_summary: `${prefix}; error_fingerprint=${fingerprint}`.slice(0, MASTER_FAILURE_SUMMARY_MAX_LENGTH),
		artifact_refs: uniqueArtifactRefs,
	};
}

export function createArchivedHandoffFailure(input: {
	artifact_store: ArtifactStore;
	task_id: string;
	task_revision: number;
	raw_failure_detail: JsonValue;
	classification?: string;
}): NonNullable<MasterHandoffReceipt["failure"]> {
	const artifact = input.artifact_store.put(
		"worker_failure_detail",
		1,
		input.raw_failure_detail,
		input.task_id,
		input.task_revision,
	);
	return createBoundedHandoffFailure(
		JSON.stringify(input.raw_failure_detail),
		[artifact.digest],
		input.classification ?? "worker_failure",
	);
}

/**
 * Build the receipt only from Controller-selected canonical fields. This API
 * intentionally has no parameter for Result, Evidence payloads, transcript,
 * ResolvedContext, Trace, or Worker session data.
 */
export function buildMasterHandoffReceipt(input: MasterHandoffBuildInput): MasterHandoffReceipt {
	const receipt: MasterHandoffReceipt = {
		task_id: input.task_id,
		status: input.status,
		git_sha: input.git_sha,
		acceptance: input.acceptance,
		evidence_refs: [...new Set(input.evidence_refs)],
		unresolved_risks: [...new Set(input.unresolved_risks.map((risk) => boundedText(risk, 512)).filter(Boolean))],
		next_action: boundedText(input.next_action, 512),
		work_receipt: structuredClone(input.work_receipt),
		failure: input.failure ? structuredClone(input.failure) : undefined,
	};
	const validation = validateMasterHandoffReceipt(receipt);
	if (!validation.valid) throw new Error(`invalid Master handoff receipt: ${validation.errors.join("; ")}`);
	return structuredClone(receipt);
}
