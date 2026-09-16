import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { parse } from "yaml";
import { validateAgainstSchema } from "./schema.ts";
import type { ValidationResult } from "./types.ts";

export type KnownExternalGapImpact = "BLOCKING" | "NON_BLOCKING";

export interface KnownExternalGap {
	id: string;
	symptoms: string;
	evidence: string;
	root_cause: string;
	decision: string;
	resolution: string;
	current_consequence: string;
	mvp_impact: KnownExternalGapImpact;
}

export interface KnownExternalGapRegistry {
	version: 1;
	known_gaps: KnownExternalGap[];
}

const NonEmptyString = Type.String({ minLength: 1 });

export const KnownExternalGapRegistrySchema = Type.Object(
	{
		version: Type.Literal(1),
		known_gaps: Type.Array(
			Type.Object(
				{
					id: NonEmptyString,
					symptoms: NonEmptyString,
					evidence: NonEmptyString,
					root_cause: NonEmptyString,
					decision: NonEmptyString,
					resolution: NonEmptyString,
					current_consequence: NonEmptyString,
					mvp_impact: Type.Union([Type.Literal("BLOCKING"), Type.Literal("NON_BLOCKING")]),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

export function validateKnownExternalGapRegistry(value: unknown): ValidationResult<KnownExternalGapRegistry> {
	const structural = validateAgainstSchema<KnownExternalGapRegistry>(KnownExternalGapRegistrySchema, value);
	if (!structural.valid || !structural.value) return structural;

	const ids = new Set<string>();
	const errors: string[] = [];
	for (const [index, gap] of structural.value.known_gaps.entries()) {
		if (ids.has(gap.id)) errors.push(`/known_gaps/${index}/id: duplicate gap id ${gap.id}`);
		ids.add(gap.id);
		if (gap.id === "GAP-01" && gap.mvp_impact !== "NON_BLOCKING") {
			errors.push(`/known_gaps/${index}/mvp_impact: GAP-01 must be NON_BLOCKING`);
		}
	}
	return errors.length === 0 ? structural : { valid: false, errors };
}

export function parseKnownExternalGapRegistry(source: string): ValidationResult<KnownExternalGapRegistry> {
	try {
		return validateKnownExternalGapRegistry(parse(source));
	} catch (error) {
		return {
			valid: false,
			errors: [`/: invalid YAML: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

export function loadKnownExternalGapRegistry(path: string): KnownExternalGapRegistry {
	const result = parseKnownExternalGapRegistry(readFileSync(path, "utf8"));
	if (!result.valid || !result.value)
		throw new Error(`invalid Known External Gap Registry: ${result.errors.join("; ")}`);
	return result.value;
}

export function findKnownExternalGap(registry: KnownExternalGapRegistry, id: string): KnownExternalGap | undefined {
	return registry.known_gaps.find((gap) => gap.id === id);
}
