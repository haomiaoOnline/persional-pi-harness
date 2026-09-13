import { checkRoleBoundary } from "./roles.ts";
import type { PermissionRequest, ResolvedContext, RoleProfile, TaskContract, ValidationResult } from "./types.ts";

export interface PermissionDecision {
	allowed: boolean;
	reasons: string[];
	granted: {
		filesystem: { read: string[]; write: string[] };
		shell: string[];
		network: boolean;
		git: string[];
		credentials: boolean;
	};
}

export interface SensitiveContextResult {
	context: ResolvedContext;
	redacted_digests: string[];
	security_event?: string;
}

export class PermissionDeniedError extends Error {
	readonly reasons: string[];

	constructor(reasons: readonly string[]) {
		super(`permission denied: ${reasons.join("; ")}`);
		this.name = "PermissionDeniedError";
		this.reasons = [...reasons];
	}
}

function normalizedPath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	return normalized || ".";
}

function pathAllowed(allowed: readonly string[], requested: string): boolean {
	const candidate = normalizedPath(requested);
	return allowed.some((scope) => {
		const normalized = normalizedPath(scope);
		if (normalized === "." || normalized === "*") return true;
		if (normalized.endsWith("/**"))
			return candidate === normalized.slice(0, -3) || candidate.startsWith(normalized.slice(0, -2));
		return candidate === normalized || candidate.startsWith(`${normalized}/`);
	});
}

function shellAllowed(allowed: readonly string[], command: string): boolean {
	return allowed.some(
		(candidate) => candidate === "*" || command === candidate || command.startsWith(`${candidate} `),
	);
}

function gitAllowed(allowed: readonly string[], action: string): boolean {
	return allowed.some((candidate) => candidate === "*" || action === candidate || action.startsWith(`${candidate} `));
}

export function validatePermissionRequest(value: unknown): ValidationResult<PermissionRequest> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { valid: false, errors: ["/: permission request must be an object"] };
	const candidate = value as Record<string, unknown>;
	const errors: string[] = [];
	for (const key of ["network", "credentials"]) {
		if (candidate[key] !== undefined && typeof candidate[key] !== "boolean") errors.push(`/${key}: must be boolean`);
	}
	for (const key of ["shell", "git", "credential_scopes"]) {
		if (
			candidate[key] !== undefined &&
			(!Array.isArray(candidate[key]) || candidate[key].some((item) => typeof item !== "string"))
		)
			errors.push(`/${key}: must be an array of strings`);
	}
	return errors.length === 0
		? { valid: true, value: value as PermissionRequest, errors: [] }
		: { valid: false, errors };
}

export function evaluateTaskPermissions(
	task: TaskContract,
	request: PermissionRequest = {},
	role?: RoleProfile,
): PermissionDecision {
	const reasons: string[] = [];
	const filesystem = request.filesystem ?? {};
	for (const path of filesystem.read ?? []) {
		if (!pathAllowed(task.permissions.filesystem.read, path)) reasons.push(`filesystem read outside scope: ${path}`);
	}
	for (const path of filesystem.write ?? []) {
		if (!pathAllowed(task.permissions.filesystem.write, path))
			reasons.push(`filesystem write outside scope: ${path}`);
	}
	for (const command of request.shell ?? []) {
		if (!shellAllowed(task.permissions.shell.allowed, command))
			reasons.push(`shell command outside scope: ${command}`);
	}
	if (request.network && task.permissions.network !== "allow")
		reasons.push("network access is denied by Task Contract");
	for (const action of request.git ?? []) {
		if (!gitAllowed(task.permissions.git?.allowed ?? [], action)) reasons.push(`git action outside scope: ${action}`);
	}
	if (request.credentials && task.permissions.credentials !== "allow")
		reasons.push("credential access is denied by Task Contract");
	if (task.role_profile_ref && !role) reasons.push("role profile is required for this Task Contract");
	if (role) {
		const boundary = checkRoleBoundary(role, task);
		if (!boundary.allowed) reasons.push(...boundary.reasons);
		if (request.credentials) {
			if (request.credential_service && !role.credential_scope.allowed_services.includes(request.credential_service))
				reasons.push(`credential service is outside role scope: ${request.credential_service}`);
			for (const scope of request.credential_scopes ?? []) {
				if (!role.credential_scope.allowed_scopes.includes(scope))
					reasons.push(`credential scope is outside role scope: ${scope}`);
			}
		}
	}
	return {
		allowed: reasons.length === 0,
		reasons,
		granted: {
			filesystem: { read: [...(filesystem.read ?? [])], write: [...(filesystem.write ?? [])] },
			shell: [...(request.shell ?? [])],
			network: request.network === true,
			git: [...(request.git ?? [])],
			credentials: request.credentials === true,
		},
	};
}

const SENSITIVE_PATTERN =
	/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|凭证|密钥|密码|-----begin)/i;

export function filterSensitiveContext(context: ResolvedContext, allowCredentials = false): SensitiveContextResult {
	if (allowCredentials) return { context: structuredClone(context), redacted_digests: [] };
	const redacted = context.items.filter((item) => SENSITIVE_PATTERN.test(item.content)).map((item) => item.digest);
	if (redacted.length === 0) return { context: structuredClone(context), redacted_digests: [] };
	const items = context.items.map((item) =>
		redacted.includes(item.digest)
			? { ...item, content: "[REDACTED SENSITIVE CONTEXT]", token_estimate: 4 }
			: { ...item },
	);
	return {
		context: {
			...structuredClone(context),
			items,
			text: items.map((item) => item.content).join("\n\n"),
			total_tokens: items.reduce((sum, item) => sum + item.token_estimate, 0),
			cache_hit: false,
		},
		redacted_digests: redacted,
		security_event: `redacted ${redacted.length} sensitive context object(s)`,
	};
}

export function authorizeWorkerExecution(
	task: TaskContract,
	request: PermissionRequest = {},
	role?: RoleProfile,
): PermissionDecision {
	const decision = evaluateTaskPermissions(task, request, role);
	if (!decision.allowed) throw new PermissionDeniedError(decision.reasons);
	return decision;
}
