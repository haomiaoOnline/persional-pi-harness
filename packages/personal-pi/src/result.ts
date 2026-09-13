import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BatchResultEnvelope, ResultContract, ResultStatus, ValidationResult } from "./types.ts";

const ResultStatusSchema = Type.Union([
	Type.Literal("success"),
	Type.Literal("failure"),
	Type.Literal("timeout"),
	Type.Literal("INSUFFICIENT_CONTEXT"),
]);

const ResultItemSchema = Type.Object(
	{
		task_id: Type.String({ minLength: 1 }),
		status: ResultStatusSchema,
		changed_files: Type.Array(Type.String()),
		artifacts: Type.Array(Type.String()),
		evidence: Type.Array(Type.String()),
		errors: Type.Array(Type.String()),
		requested_context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
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
		requested_context: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
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

export function validateResultContract(value: unknown): ValidationResult<ResultContract> {
	if (Value.Check(ResultContractSchema, value)) return { valid: true, value: value as ResultContract, errors: [] };
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
