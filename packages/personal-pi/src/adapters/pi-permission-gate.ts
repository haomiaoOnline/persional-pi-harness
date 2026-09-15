/**
 * Runtime permission gate for Pi's built-in tools.
 *
 * The adapter passes a JSON policy through PPH_PI_TOOL_POLICY. This module is
 * loaded by Pi itself, so it intentionally has no Personal PI imports and
 * fails closed when the policy is absent or malformed.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

interface ToolPolicy {
	working_directory: string;
	allowed_tools: string[];
	read_scopes: string[];
	write_scopes: string[];
	shell_allowed: string[];
	network: boolean;
}

interface ToolEvent {
	toolName?: unknown;
	input?: unknown;
}

function readPolicy(): ToolPolicy | undefined {
	try {
		const value: unknown = JSON.parse(process.env.PPH_PI_TOOL_POLICY ?? "");
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const candidate = value as Record<string, unknown>;
		if (
			typeof candidate.working_directory !== "string" ||
			!Array.isArray(candidate.allowed_tools) ||
			!Array.isArray(candidate.read_scopes) ||
			!Array.isArray(candidate.write_scopes) ||
			!Array.isArray(candidate.shell_allowed) ||
			typeof candidate.network !== "boolean"
		)
			return undefined;
		const lists = [candidate.allowed_tools, candidate.read_scopes, candidate.write_scopes, candidate.shell_allowed];
		if (lists.some((list) => (list as unknown[]).some((item) => typeof item !== "string"))) return undefined;
		return {
			working_directory: candidate.working_directory,
			allowed_tools: candidate.allowed_tools as string[],
			read_scopes: candidate.read_scopes as string[],
			write_scopes: candidate.write_scopes as string[],
			shell_allowed: candidate.shell_allowed as string[],
			network: candidate.network,
		};
	} catch {
		return undefined;
	}
}

function existingRealPath(path: string): string {
	if (existsSync(path)) {
		try {
			return realpathSync.native(path);
		} catch {
			return normalize(path);
		}
	}
	let current = path;
	while (current !== dirname(current)) {
		if (existsSync(current)) {
			try {
				return resolve(realpathSync.native(current), relative(current, path));
			} catch {
				return normalize(path);
			}
		}
		current = dirname(current);
	}
	return normalize(path);
}

function policyPath(policy: ToolPolicy, candidate: string): string {
	return existingRealPath(isAbsolute(candidate) ? candidate : resolve(policy.working_directory, candidate));
}

function scopePath(policy: ToolPolicy, scope: string): string {
	return existingRealPath(isAbsolute(scope) ? scope : resolve(policy.working_directory, scope));
}

function within(policy: ToolPolicy, candidate: string, scopes: readonly string[]): boolean {
	const target = policyPath(policy, candidate);
	return scopes.some((scope) => {
		const root = scopePath(policy, scope);
		const child = relative(root, target);
		return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
	});
}

function toolInput(event: ToolEvent): Record<string, unknown> | undefined {
	return event.input && typeof event.input === "object" && !Array.isArray(event.input)
		? (event.input as Record<string, unknown>)
		: undefined;
}

function blockedReason(policy: ToolPolicy, event: ToolEvent): string | undefined {
	const name = typeof event.toolName === "string" ? event.toolName : "";
	if (!policy.allowed_tools.includes(name)) return `tool ${name || "unknown"} is not in the Task Contract allowlist`;
	const input = toolInput(event);
	if (!input) return `tool ${name} arguments are not an object`;
	if (name === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return "bash command is missing";
		if (
			!policy.shell_allowed.some(
				(allowed) => allowed === "*" || command === allowed || command.startsWith(`${allowed} `),
			)
		)
			return "bash command is outside the Task Contract shell scope";
		if (!policy.network && /\b(curl|wget|fetch|http|https|ssh|scp|nc|netcat|telnet|ftp)\b/i.test(command))
			return "network-like bash command is denied by the Task Contract";
		if (/\b(sudo|rm|rmdir|mkfs|chmod|chown|git\s+(reset|checkout|clean|push|commit))\b/i.test(command))
			return "destructive or external git bash command is denied by the Worker policy";
		return undefined;
	}
	if (["write", "edit"].includes(name)) {
		const path = typeof input.path === "string" ? input.path : "";
		if (!path || !within(policy, path, policy.write_scopes))
			return `${name} path is outside the Task Contract write scope`;
		return undefined;
	}
	if (["read", "grep", "find", "ls"].includes(name)) {
		const path = typeof input.path === "string" ? input.path : ".";
		if (!within(policy, path, policy.read_scopes)) return `${name} path is outside the Task Contract read scope`;
	}
	return undefined;
}

export default function (pi: { on: (event: "tool_call", handler: (event: ToolEvent) => Promise<unknown>) => void }) {
	const policy = readPolicy();
	pi.on("tool_call", async (event) => {
		if (!policy) return { block: true, terminate: true, reason: "missing or malformed PPH tool policy" };
		const reason = blockedReason(policy, event);
		return reason ? { block: true, terminate: true, reason } : undefined;
	});
}
