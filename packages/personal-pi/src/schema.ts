import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TaskContract, ValidationResult } from "./types.ts";

const NonEmptyString = Type.String({ minLength: 1 });
const JsonValue = Type.Unknown();

const PermissionsSchema = Type.Object(
	{
		filesystem: Type.Object({
			read: Type.Array(Type.String()),
			write: Type.Array(Type.String()),
		}),
		shell: Type.Object({ allowed: Type.Array(Type.String()) }),
		network: Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
		credentials: Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
		git: Type.Optional(Type.Object({ allowed: Type.Array(Type.String()) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);

const ExecutionSchema = Type.Object(
	{
		worker_type: Type.Union([
			Type.Literal("pi"),
			Type.Literal("codex"),
			Type.Literal("claude"),
			Type.Literal("local_model"),
			Type.Literal("cli"),
		]),
		worker_tier: Type.Union([Type.Literal("cheap"), Type.Literal("standard"), Type.Literal("frontier")]),
		reasoning_depth: Type.Union([
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("extended"),
		]),
		capability_tags: Type.Array(NonEmptyString),
		mode: Type.Union([
			Type.Literal("single"),
			Type.Literal("decompose"),
			Type.Literal("parallel"),
			Type.Literal("batch"),
		]),
		working_directory: NonEmptyString,
		allowed_tools: Type.Array(Type.String()),
		idempotency_key: Type.Optional(NonEmptyString),
	},
	{ additionalProperties: false },
);

const VerificationSchema = Type.Object(
	{
		strategy: Type.Union([Type.Literal("automated"), Type.Literal("manual")]),
		commands: Type.Array(Type.String()),
		checks: Type.Array(Type.String()),
		evidence_required: Type.Array(NonEmptyString),
		strength: Type.Union([Type.Literal("strong"), Type.Literal("weak"), Type.Literal("none")]),
		recipe_ref: Type.Optional(NonEmptyString),
	},
	{ additionalProperties: false },
);

const TaskContractSchema = Type.Object(
	{
		id: NonEmptyString,
		schema_version: Type.Literal(2),
		task_revision: Type.Integer({ minimum: 1 }),
		graph_revision: Type.Integer({ minimum: 0 }),
		type: NonEmptyString,
		title: NonEmptyString,
		objective: NonEmptyString,
		requirements: Type.Array(NonEmptyString),
		constraints: Type.Array(Type.String()),
		scope: Type.Object({ files: Type.Array(NonEmptyString) }, { additionalProperties: false }),
		role_profile_ref: Type.Optional(NonEmptyString),
		inputs: Type.Record(Type.String(), JsonValue),
		data_sources: Type.Array(Type.String()),
		data_references: Type.Array(Type.String()),
		permissions: PermissionsSchema,
		execution: ExecutionSchema,
		dependencies: Type.Array(Type.String()),
		artifact_dependencies: Type.Array(Type.String()),
		expected_outputs: Type.Array(NonEmptyString),
		acceptance_criteria: Type.Array(NonEmptyString),
		verification: VerificationSchema,
		context: Type.Object(
			{
				required: Type.Array(Type.String()),
				optional: Type.Array(Type.String()),
				excluded: Type.Array(Type.String()),
				budget: Type.Object({ max_input_tokens: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
			},
			{ additionalProperties: false },
		),
		risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
		priority: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]),
		timeout: Type.Integer({ minimum: 1 }),
		retry_policy: Type.Object(
			{
				max_attempts: Type.Integer({ minimum: 1 }),
				backoff: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		loop_budget: Type.Optional(
			Type.Object(
				{
					max_attempts: Type.Integer({ minimum: 1 }),
					max_model_calls: Type.Integer({ minimum: 0 }),
					max_tool_calls: Type.Integer({ minimum: 0 }),
					max_handoffs: Type.Integer({ minimum: 0 }),
					max_elapsed_ms: Type.Integer({ minimum: 1 }),
					max_input_tokens: Type.Integer({ minimum: 0 }),
					max_output_tokens: Type.Integer({ minimum: 0 }),
					max_cost_usd: Type.Number({ minimum: 0 }),
					max_state_growth_bytes: Type.Integer({ minimum: 0 }),
					on_exhaustion: Type.Object(
						{ action: Type.Literal("BLOCKED"), escalation: Type.Literal("human") },
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
		),
		approval: Type.Object(
			{
				required: Type.Boolean(),
				action_digest: Type.Optional(NonEmptyString),
				bound_revision: Type.Optional(Type.Integer({ minimum: 1 })),
				expires_at: Type.Optional(NonEmptyString),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export { TaskContractSchema };

export function validateAgainstSchema<T>(schema: TSchema, value: unknown): ValidationResult<T> {
	if (Value.Check(schema, value)) return { valid: true, value: value as T, errors: [] };
	const errors = [...Value.Errors(schema, value)].map((error) => {
		const path = "path" in error && typeof error.path === "string" ? error.path : "/";
		return `${path || "/"}: ${error.message}`;
	});
	return { valid: false, errors };
}

/**
 * T1.1 的唯一入口。语法层交给 TypeBox，额外的契约语义在这里集中维护，
 * 这样 DoR 和后续持久化都能复用同一个校验器。
 */
export function validateTaskContract(value: unknown): ValidationResult<TaskContract> {
	const result = validateAgainstSchema<TaskContract>(TaskContractSchema, value);
	if (!result.valid || !result.value) return result;

	const errors: string[] = [];
	if (result.value.permissions.credentials === "allow" && !result.value.role_profile_ref) {
		errors.push("/permissions/credentials: allow requires role_profile_ref");
	}
	if (result.value.approval.required) {
		if (!result.value.approval.action_digest)
			errors.push("/approval/action_digest: required when approval.required is true");
		if (!result.value.approval.bound_revision)
			errors.push("/approval/bound_revision: required when approval.required is true");
		if (!result.value.approval.expires_at)
			errors.push("/approval/expires_at: required when approval.required is true");
	}
	return errors.length === 0 ? result : { valid: false, errors };
}
