import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RoleProfile, TaskContract, ValidationResult } from "./types.ts";

const RoleProfileSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		mission: Type.String({ minLength: 1 }),
		suitable_tasks: Type.Array(Type.String({ minLength: 1 })),
		ownership_scope: Type.Array(Type.String({ minLength: 1 })),
		credential_scope: Type.Object(
			{
				allowed_services: Type.Array(Type.String()),
				allowed_scopes: Type.Array(Type.String()),
				forbidden: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
		preferred_tools: Type.Array(Type.String()),
		prohibited_actions: Type.Array(Type.String()),
		context_policy: Type.Object(
			{
				required: Type.Array(Type.String()),
				optional: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
		output_contract: Type.Array(Type.String({ minLength: 1 })),
		handoff: Type.Object({ downstream: Type.Array(Type.String()) }, { additionalProperties: false }),
		verifier_profile: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export { RoleProfileSchema };

export function validateRoleProfile(value: unknown): ValidationResult<RoleProfile> {
	if (Value.Check(RoleProfileSchema, value)) return { valid: true, value: value as RoleProfile, errors: [] };
	return {
		valid: false,
		errors: [...Value.Errors(RoleProfileSchema, value)].map(
			(error) => `${"path" in error && typeof error.path === "string" ? error.path : "/"}: ${error.message}`,
		),
	};
}

export const DEFAULT_ROLE_PROFILES: readonly RoleProfile[] = [
	{
		id: "backend-engineer",
		mission: "构建后端服务与稳定的 API 契约",
		suitable_tasks: ["api", "database", "backend", "migration"],
		ownership_scope: ["src/service/**", "src/model/**"],
		credential_scope: {
			allowed_services: [],
			allowed_scopes: [],
			forbidden: ["production_deploy", "permission_change", "payment"],
		},
		preferred_tools: ["repo", "shell", "test_runner"],
		prohibited_actions: ["production_deploy", "permission_change", "payment"],
		context_policy: { required: ["architecture", "api_contract"], optional: ["frontend_source"] },
		output_contract: ["changed_files", "api_contract", "tests", "evidence"],
		handoff: { downstream: ["frontend-engineer", "qa"] },
		verifier_profile: ["unit_test", "integration_test"],
	},
	{
		id: "qa",
		mission: "独立验证交付是否满足验收标准",
		suitable_tasks: ["qa", "test", "verification"],
		ownership_scope: ["test/**", "tests/**"],
		credential_scope: {
			allowed_services: [],
			allowed_scopes: [],
			forbidden: ["production_deploy", "permission_change", "payment"],
		},
		preferred_tools: ["repo", "shell", "test_runner"],
		prohibited_actions: ["production_deploy", "permission_change", "payment"],
		context_policy: { required: ["task_contract", "acceptance_criteria"], optional: ["changed_files"] },
		output_contract: ["test_result", "evidence", "open_risks"],
		handoff: { downstream: [] },
		verifier_profile: ["unit_test", "integration_test", "browser_e2e"],
	},
	{
		id: "researcher",
		mission: "收集可复核事实并形成有引用的研究结果",
		suitable_tasks: ["research", "analysis", "documentation"],
		ownership_scope: ["docs/**", "references/**"],
		credential_scope: {
			allowed_services: [],
			allowed_scopes: [],
			forbidden: ["production_deploy", "permission_change", "payment"],
		},
		preferred_tools: ["repo", "browser"],
		prohibited_actions: ["production_deploy", "permission_change", "payment"],
		context_policy: { required: ["research_question"], optional: ["reference_material"] },
		output_contract: ["sources", "summary", "evidence"],
		handoff: { downstream: ["qa"] },
		verifier_profile: ["source_check"],
	},
];

export interface RoleBoundaryResult {
	allowed: boolean;
	reasons: string[];
}

export function checkRoleBoundary(
	role: RoleProfile,
	task: Pick<TaskContract, "permissions" | "scope" | "type">,
): RoleBoundaryResult {
	const reasons: string[] = [];
	if (task.permissions.credentials === "allow" && role.credential_scope.allowed_services.length === 0) {
		reasons.push("role credential_scope does not allow credential access");
	}
	for (const forbidden of role.credential_scope.forbidden) {
		if (
			task.type.toLowerCase().includes(forbidden) ||
			task.scope.files.some((file) => file.toLowerCase().includes(forbidden))
		) {
			reasons.push(`role forbids action: ${forbidden}`);
		}
	}
	return { allowed: reasons.length === 0, reasons };
}
