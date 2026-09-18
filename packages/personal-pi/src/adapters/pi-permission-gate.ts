/**
 * Runtime permission gate for Pi's built-in tools.
 *
 * The adapter passes a JSON policy through PPH_PI_TOOL_POLICY. This module is
 * loaded by Pi itself. The coding-agent bundle emits it as a self-contained
 * sidecar with its private Personal PI dependencies embedded, so the public
 * coding-agent package still has no Personal PI runtime dependency. It fails
 * closed when the policy is absent or malformed.
 */

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { ArtifactStore } from "../artifacts.ts";
import { CommandRiskClassifier } from "../command-risk.ts";
import { ToolGateway } from "../tool-gateway.ts";
import type { ToolOutputKind } from "../types.ts";

interface ToolPolicy {
	working_directory: string;
	allowed_tools: string[];
	read_scopes: string[];
	write_scopes: string[];
	shell_allowed: string[];
	network: boolean;
	artifact_store_root: string;
	task_id: string;
	task_revision: number;
}

interface ToolEvent {
	toolCallId?: unknown;
	toolName?: unknown;
	input?: unknown;
}

interface ToolResultEvent extends ToolEvent {
	content?: unknown;
	details?: unknown;
	isError?: unknown;
}

interface PiHooks {
	on(event: "tool_call", handler: (event: ToolEvent) => Promise<unknown>): void;
	on(event: "tool_result", handler: (event: ToolResultEvent) => Promise<unknown>): void;
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
			typeof candidate.network !== "boolean" ||
			typeof candidate.artifact_store_root !== "string" ||
			!candidate.artifact_store_root ||
			typeof candidate.task_id !== "string" ||
			!candidate.task_id ||
			!Number.isInteger(candidate.task_revision) ||
			(candidate.task_revision as number) < 1
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
			artifact_store_root: candidate.artifact_store_root,
			task_id: candidate.task_id,
			task_revision: candidate.task_revision as number,
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
		const risk = new CommandRiskClassifier().classify(command);
		if (risk.risk === "danger") return `danger bash command is blocked before execution: ${risk.reason}`;
		if (risk.risk === "risky") return `risky bash command requires controller approval: ${risk.reason}`;
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

function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return "";
			const record = item as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return record.text;
			return JSON.stringify(record);
		})
		.filter(Boolean)
		.join("\n");
}

function outputKind(toolName: string, input: Record<string, unknown> | undefined): ToolOutputKind | undefined {
	if (toolName === "read") return "large_file";
	if (toolName === "grep" || toolName === "find") return "search";
	if (toolName !== "bash") return undefined;
	const command = typeof input?.command === "string" ? input.command : "";
	if (/\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|node\s+--test)\b/i.test(command))
		return "test";
	if (/\b(?:tsc|tsgo|cargo\s+build|go\s+build|npm\s+(?:run\s+)?build|compile)\b/i.test(command)) return "compile";
	if (/\b(?:rg|grep|find)\b/i.test(command)) return "search";
	return undefined;
}

function fullBackedOutput(event: ToolResultEvent): string | undefined {
	if (!event.details || typeof event.details !== "object" || Array.isArray(event.details)) return undefined;
	const path = (event.details as Record<string, unknown>).fullOutputPath;
	if (typeof path !== "string" || !path || !existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

type BashOutcome =
	| { kind: "exit"; exit_code: number | null }
	| { kind: "timeout"; exit_code: number | null; timeout_seconds: number }
	| { kind: "abort"; exit_code: number | null };

function resultDetails(event: ToolResultEvent): Record<string, unknown> | undefined {
	return event.details && typeof event.details === "object" && !Array.isArray(event.details)
		? (event.details as Record<string, unknown>)
		: undefined;
}

function bashOutcome(details: Record<string, unknown> | undefined): BashOutcome | undefined {
	const value = details?.outcome;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const outcome = value as Record<string, unknown>;
	if (outcome.kind === "exit" && (typeof outcome.exit_code === "number" || outcome.exit_code === null))
		return { kind: "exit", exit_code: outcome.exit_code };
	if (
		outcome.kind === "timeout" &&
		(typeof outcome.exit_code === "number" || outcome.exit_code === null) &&
		typeof outcome.timeout_seconds === "number"
	)
		return { kind: "timeout", exit_code: outcome.exit_code, timeout_seconds: outcome.timeout_seconds };
	if (outcome.kind === "abort" && (typeof outcome.exit_code === "number" || outcome.exit_code === null))
		return { kind: "abort", exit_code: outcome.exit_code };
	return undefined;
}

function readBackedPath(details: Record<string, unknown> | undefined, key: string): string | undefined {
	const path = details?.[key];
	if (typeof path !== "string" || !path || !existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function cleanupBackingPaths(details: Record<string, unknown> | undefined): void {
	for (const key of ["fullOutputPath", "stdoutFullOutputPath", "stderrFullOutputPath"]) {
		const path = details?.[key];
		if (typeof path === "string" && path) rmSync(path, { force: true });
	}
}

export default function (pi: PiHooks) {
	const policy = readPolicy();
	const gateway = policy
		? new ToolGateway({ artifact_store: new ArtifactStore(policy.artifact_store_root) })
		: undefined;
	const startedAt = new Map<string, number>();
	const blockedCalls = new Set<string>();
	pi.on("tool_call", async (event) => {
		if (!policy) return { block: true, terminate: true, reason: "missing or malformed PPH tool policy" };
		const reason = blockedReason(policy, event);
		if (reason) {
			if (typeof event.toolCallId === "string") blockedCalls.add(event.toolCallId);
			return { block: true, terminate: true, reason };
		}
		if (typeof event.toolCallId === "string") startedAt.set(event.toolCallId, Date.now());
		return undefined;
	});
	pi.on("tool_result", async (event) => {
		if (!policy || !gateway) throw new Error("missing or malformed PPH Tool Gateway policy");
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		const input = toolInput(event);
		const isError = event.isError === true;
		const blocked = typeof event.toolCallId === "string" && blockedCalls.delete(event.toolCallId);
		const started = typeof event.toolCallId === "string" ? startedAt.get(event.toolCallId) : undefined;
		if (typeof event.toolCallId === "string") startedAt.delete(event.toolCallId);
		const details = resultDetails(event);
		let exitCode = blocked ? 126 : isError ? 1 : 0;
		let status: "success" | "failure" | "error" | "blocked" = blocked ? "blocked" : isError ? "failure" : "success";
		let stdout = "";
		let stderr = "";
		if (toolName === "bash" && !blocked) {
			const outcome = bashOutcome(details);
			if (!outcome) throw new Error("governed bash result is missing exact outcome metadata");
			if (details?.streamSeparation !== "exact")
				throw new Error("governed bash result is missing exact stdout/stderr separation");
			const stdoutBytes = typeof details.stdoutBytes === "number" ? details.stdoutBytes : 0;
			const stderrBytes = typeof details.stderrBytes === "number" ? details.stderrBytes : 0;
			stdout = readBackedPath(details, "stdoutFullOutputPath") ?? "";
			stderr = readBackedPath(details, "stderrFullOutputPath") ?? "";
			if (stdoutBytes > 0 && !stdout) {
				if (outcome.kind === "exit" && outcome.exit_code === 0 && stderrBytes === 0)
					stdout = resultText(event.content);
				else throw new Error("governed bash stdout backing is missing");
			}
			if (stderrBytes > 0 && !stderr) throw new Error("governed bash stderr backing is missing");
			exitCode = outcome.exit_code ?? -1;
			status = outcome.kind === "exit" ? (exitCode === 0 && !isError ? "success" : "failure") : "error";
		} else {
			const content = fullBackedOutput(event) ?? resultText(event.content);
			if (isError || blocked) stderr = content;
			else stdout = content;
		}
		const envelope = gateway.wrap({
			tool_name: toolName === "bash" && typeof input?.command === "string" ? input.command : toolName,
			task_id: policy.task_id,
			task_revision: policy.task_revision,
			exit_code: exitCode,
			stdout,
			stderr,
			status,
			duration_ms: started === undefined ? 0 : Math.max(0, Date.now() - started),
			output_kind: outputKind(toolName, input),
		});
		cleanupBackingPaths(details);
		return {
			content: [{ type: "text", text: JSON.stringify(envelope) }],
			// Explicitly replace native details so full-output temp paths and truncation metadata
			// cannot leak into the next provider turn. The durable ArtifactStore is canonical.
			details: {},
			isError,
		};
	});
}
