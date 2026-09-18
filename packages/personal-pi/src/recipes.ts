import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ValidationResult, VerificationRecipe } from "./types.ts";

const ProviderModeSchema = Type.Union([Type.Literal("mock"), Type.Literal("local"), Type.Literal("real")]);

const VerificationRecipeSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		task_type: Type.String({ minLength: 1 }),
		required: Type.Array(Type.String({ minLength: 1 })),
		evidence: Type.Array(Type.String({ minLength: 1 })),
		required_provider_mode: Type.Optional(ProviderModeSchema),
	},
	{ additionalProperties: false },
);

export const DEFAULT_VERIFICATION_RECIPES: readonly VerificationRecipe[] = [
	{
		id: "web-feature-v1",
		task_type: "web_feature",
		required: ["unit_test", "integration_test", "browser_e2e", "network_trace"],
		evidence: ["screenshot", "video", "console_log", "request_trace"],
	},
	{
		id: "api-endpoint-v1",
		task_type: "api_endpoint",
		required: ["unit_test", "contract_test", "load_smoke"],
		evidence: ["test_report", "openapi_diff"],
	},
];

export class VerificationRecipeRegistry {
	private readonly recipes = new Map<string, VerificationRecipe>();

	constructor(recipes: readonly VerificationRecipe[] = DEFAULT_VERIFICATION_RECIPES) {
		for (const recipe of recipes) this.register(recipe);
	}

	register(recipe: VerificationRecipe): void {
		const validation = validateVerificationRecipe(recipe);
		if (!validation.valid) throw new Error(`invalid verification recipe: ${validation.errors.join("; ")}`);
		this.recipes.set(recipe.id, structuredClone(recipe));
	}

	get(id: string): VerificationRecipe | undefined {
		const recipe = this.recipes.get(id);
		return recipe ? structuredClone(recipe) : undefined;
	}
}

export function validateVerificationRecipe(value: unknown): ValidationResult<VerificationRecipe> {
	if (Value.Check(VerificationRecipeSchema, value))
		return { valid: true, value: value as VerificationRecipe, errors: [] };
	return {
		valid: false,
		errors: [...Value.Errors(VerificationRecipeSchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path || "/"}: ${error.message}`;
		}),
	};
}
