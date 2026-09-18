import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
	BatchResultEnvelope,
	ModelIdentity,
	ResultContract,
	ResultStatus,
	ValidationResult,
	WorkerStatus,
	WorkReceipt,
} from "./types.ts";

const ResultStatusSchema = Type.Union([
	Type.Literal("success"),
	Type.Literal("failure"),
	Type.Literal("timeout"),
	Type.Literal("INSUFFICIENT_CONTEXT"),
]);

export const WorkerStatusSchema = Type.Object(
	{
		worker_capability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
		execution_mode: Type.Union([Type.Literal("normal"), Type.Literal("root_only"), Type.Literal("degraded")]),
		delivery_status: Type.Union([Type.Literal("normal"), Type.Literal("degraded")]),
	},
	{ additionalProperties: false },
);

export const ModelIdentitySchema = Type.Object(
	{
		requested_model: Type.String({ minLength: 1 }),
		platform_accepted_model: Type.String({ minLength: 1 }),
		observed_runtime_model: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

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

const ResultItemSchema = Type.Object(
	{
		task_id: Type.String({ minLength: 1 }),
		status: ResultStatusSchema,
		changed_files: Type.Array(Type.String()),
		artifacts: Type.Array(Type.String()),
		evidence: Type.Array(Type.String()),
		errors: Type.Array(Type.String()),
		requested_context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		work_receipt: Type.Optional(WorkReceiptSchema),
	},
	{ additionalProperties: false },
);

const ResultContractSchema = Type.Object(
	{
		task_id: Type.String({ minLength: 1 }),
		run_id: Type.String({ minLength: 1 }),
		worker_id: Type.String({ minLength: 1 }),
		lease_epoch: Type.Integer({ minimum: 1 }),
		status: ResultStatusSchema,
		summary: Type.String({ minLength: 1 }),
		changed_files: Type.Array(Type.String()),
		artifacts: Type.Array(Type.String()),
		evidence: Type.Array(Type.String()),
		errors: Type.Array(Type.String()),
		model_identity: ModelIdentitySchema,
		requested_context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		work_receipt: Type.Optional(WorkReceiptSchema),
	},
	{ additionalProperties: false },
);

const BatchResultEnvelopeSchema = Type.Object(
	{
		batch_id: Type.String({ minLength: 1 }),
		worker_id: Type.String({ minLength: 1 }),
		lease_epoch: Type.Integer({ minimum: 1 }),
		results: Type.Array(ResultItemSchema),
	},
	{ additionalProperties: false },
);

export { BatchResultEnvelopeSchema, ResultContractSchema, ResultItemSchema, ResultStatusSchema };

export function createModelIdentity(
	requestedModel: string,
	options: { platform_accepted_model?: string; observed_runtime_model?: string } = {},
): ModelIdentity {
	return {
		requested_model: requestedModel.trim() || "unknown",
		platform_accepted_model: options.platform_accepted_model?.trim() || "unknown",
		observed_runtime_model: options.observed_runtime_model?.trim() || "unknown",
	};
}

export function validateModelIdentity(value: unknown): ValidationResult<ModelIdentity> {
	if (Value.Check(ModelIdentitySchema, value)) return { valid: true, value: value as ModelIdentity, errors: [] };
	return {
		valid: false,
		errors: [...Value.Errors(ModelIdentitySchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path || "/"}: ${error.message}`;
		}),
	};
}

export function validateWorkerStatus(value: unknown): ValidationResult<WorkerStatus> {
	if (!Value.Check(WorkerStatusSchema, value)) {
		return {
			valid: false,
			errors: [...Value.Errors(WorkerStatusSchema, value)].map((error) => {
				const path = "path" in error && typeof error.path === "string" ? error.path : "/";
				return `${path || "/"}: ${error.message}`;
			}),
		};
	}
	const status = value as WorkerStatus;
	const errors: string[] = [];
	if (
		status.worker_capability === "unavailable" &&
		(status.execution_mode !== "root_only" || status.delivery_status !== "degraded")
	)
		errors.push("unavailable Worker must use execution_mode=root_only and delivery_status=degraded");
	if (status.execution_mode === "root_only" && status.worker_capability !== "unavailable")
		errors.push("execution_mode=root_only requires worker_capability=unavailable");
	if (status.execution_mode === "degraded" && status.delivery_status !== "degraded")
		errors.push("execution_mode=degraded requires delivery_status=degraded");
	return errors.length === 0 ? { valid: true, value: status, errors: [] } : { valid: false, errors };
}

export function createWorkReceipt(
	changedFiles: readonly string[],
	artifacts: readonly string[],
	evidence: readonly string[],
	workAttempted = true,
): WorkReceipt {
	return {
		work_attempted: workAttempted,
		effects_count: changedFiles.length + artifacts.length,
		artifacts_created: [...artifacts],
		state_changed: changedFiles.length > 0 || artifacts.length > 0,
		no_op: false,
		evidence_refs: [...evidence],
	};
}

export function ensureWorkReceipt(result: ResultContract): ResultContract {
	if (result.work_receipt) return structuredClone(result);
	return {
		...structuredClone(result),
		work_receipt: createWorkReceipt(result.changed_files, result.artifacts, result.evidence),
	};
}

export function workReceiptErrors(receipt: WorkReceipt): string[] {
	const errors: string[] = [];
	const observableWork = receipt.effects_count > 0 || receipt.artifacts_created.length > 0 || receipt.state_changed;
	if (receipt.no_op && !receipt.no_op_reason) errors.push("/work_receipt/no_op_reason: required when no_op is true");
	if (!receipt.no_op && receipt.no_op_reason)
		errors.push("/work_receipt/no_op_reason: only allowed when no_op is true");
	if (!receipt.work_attempted && !receipt.no_op)
		errors.push("/work_receipt: work_attempted=false requires no_op=true");
	if (receipt.no_op && observableWork) errors.push("/work_receipt: no_op=true cannot report observable work");
	return errors;
}

export function workReceiptHasObservableWork(receipt: WorkReceipt): boolean {
	return receipt.effects_count > 0 || receipt.artifacts_created.length > 0 || receipt.state_changed;
}

export function validateResultContract(value: unknown): ValidationResult<ResultContract> {
	if (Value.Check(ResultContractSchema, value)) {
		const result = value as ResultContract;
		const receipt = result.work_receipt;
		if (receipt) {
			const errors = workReceiptErrors(receipt);
			if (errors.length > 0) return { valid: false, errors };
		}
		return { valid: true, value: result, errors: [] };
	}
	return {
		valid: false,
		errors: [...Value.Errors(ResultContractSchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path || "/"}: ${error.message}`;
		}),
	};
}

export function validateBatchResultEnvelope(value: unknown): ValidationResult<BatchResultEnvelope> {
	if (Value.Check(BatchResultEnvelopeSchema, value))
		return { valid: true, value: value as BatchResultEnvelope, errors: [] };
	return {
		valid: false,
		errors: [...Value.Errors(BatchResultEnvelopeSchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path || "/"}: ${error.message}`;
		}),
	};
}

export function resultStatusIsTerminal(status: ResultStatus): boolean {
	return status === "success" || status === "failure" || status === "timeout";
}
