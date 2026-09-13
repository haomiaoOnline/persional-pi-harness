import { Type } from "typebox";
import { parse } from "yaml";
import { validateAgainstSchema } from "./schema.ts";
import type { ReasoningDepth, ValidationResult, WorkerPluginManifest } from "./types.ts";

const NonEmptyString = Type.String({ minLength: 1 });
const ReasoningDepthSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("extended"),
]);

const WorkerPluginModelSchema = Type.Object(
	{
		model: NonEmptyString,
		reasoning_levels: Type.Array(ReasoningDepthSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const WorkerPluginAuthSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("none"), Type.Literal("api_key")]),
		env_var: Type.Optional(NonEmptyString),
	},
	{ additionalProperties: false },
);

export const WorkerPluginManifestSchema = Type.Object(
	{
		worker_plugin: Type.Object(
			{
				id: NonEmptyString,
				adapter_entry: NonEmptyString,
				models_supported: Type.Array(WorkerPluginModelSchema, { minItems: 1 }),
				capability_tags: Type.Array(NonEmptyString, { minItems: 1 }),
				context_limit: Type.Integer({ minimum: 1 }),
				cost_tier: Type.Union([Type.Literal("cheap"), Type.Literal("standard"), Type.Literal("frontier")]),
				auth: WorkerPluginAuthSchema,
				discovery: Type.Object({ type: Type.Literal("static_config") }, { additionalProperties: false }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export function validateWorkerPluginManifest(value: unknown): ValidationResult<WorkerPluginManifest> {
	const structural = validateAgainstSchema<WorkerPluginManifest>(WorkerPluginManifestSchema, value);
	if (!structural.valid || !structural.value) return structural;

	const manifest = structural.value;
	const plugin = manifest.worker_plugin;
	const errors: string[] = [];
	if (plugin.adapter_entry.startsWith("/") || plugin.adapter_entry.split("/").includes("..")) {
		errors.push("/worker_plugin/adapter_entry: must be a relative entry path");
	}
	if (plugin.auth.type === "api_key" && !plugin.auth.env_var) {
		errors.push("/worker_plugin/auth/env_var: required for api_key authentication");
	}
	if (plugin.auth.type === "none" && plugin.auth.env_var) {
		errors.push("/worker_plugin/auth/env_var: forbidden when authentication type is none");
	}
	if (new Set(plugin.capability_tags).size !== plugin.capability_tags.length) {
		errors.push("/worker_plugin/capability_tags: duplicate capability tag");
	}
	const modelNames = new Set<string>();
	for (const model of plugin.models_supported) {
		if (modelNames.has(model.model)) errors.push(`/worker_plugin/models_supported: duplicate model ${model.model}`);
		modelNames.add(model.model);
		if (new Set<ReasoningDepth>(model.reasoning_levels).size !== model.reasoning_levels.length) {
			errors.push(`/worker_plugin/models_supported/${model.model}: duplicate reasoning level`);
		}
	}
	return errors.length === 0 ? structural : { valid: false, errors };
}

export function parseWorkerPluginManifest(source: string): ValidationResult<WorkerPluginManifest> {
	try {
		return validateWorkerPluginManifest(parse(source));
	} catch (error) {
		return {
			valid: false,
			errors: [`/: invalid YAML: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}
