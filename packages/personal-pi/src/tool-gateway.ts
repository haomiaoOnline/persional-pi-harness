import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ArtifactStore } from "./artifacts.ts";
import type {
	BackpressureAdmission,
	BackpressureKey,
	BackpressureSignal,
	ExecutionBackpressureController,
} from "./backpressure.ts";
import type {
	CommandEvidence,
	JsonValue,
	ToolArtifactPage,
	ToolOutputKind,
	ToolResultEnvelope,
	ToolResultStatus,
	ValidationResult,
} from "./types.ts";

const DEFAULT_SUMMARY_LINES = 30;
const DEFAULT_SUMMARY_CHARS = 4_000;
const DEFAULT_PAGE_CHARS = 4_000;
const MAX_PAGE_CHARS = 16_000;
const SEARCH_RESULT_COUNT_LIMIT = 20;
const SEARCH_RESULT_BYTE_LIMIT = 2_048;
const CURSOR_PREFIX = "tool-output:";
const SECRET_ASSIGNMENT =
	/((?:^|[\s,{;])(?:[A-Z0-9_]*(?:TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|COOKIE|AUTHORIZATION)[A-Z0-9_]*|[A-Z0-9_]+_KEY)\s*[:=]\s*)[^\s,;}]+/gim;

const ToolResultStatusSchema = Type.Union([
	Type.Literal("success"),
	Type.Literal("failure"),
	Type.Literal("error"),
	Type.Literal("blocked"),
]);

export const ToolResultEnvelopeSchema = Type.Object(
	{
		exit_code: Type.Integer(),
		status: ToolResultStatusSchema,
		duration: Type.Number({ minimum: 0 }),
		stdout_summary: Type.String(),
		stderr_summary: Type.String(),
		error_fingerprint: Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()]),
		relevant_stack_frames: Type.Array(Type.String()),
		artifact_id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		truncated: Type.Boolean(),
		next_cursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	},
	{ additionalProperties: false },
);

export function validateToolResultEnvelope(value: unknown): ValidationResult<ToolResultEnvelope> {
	if (Value.Check(ToolResultEnvelopeSchema, value))
		return { valid: true, value: value as ToolResultEnvelope, errors: [] };
	return {
		valid: false,
		errors: [...Value.Errors(ToolResultEnvelopeSchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path || "/"}: ${error.message}`;
		}),
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function containsSensitiveInfo(value: string): boolean {
	return (
		/-----BEGIN [^-\n]*PRIVATE KEY-----/i.test(value) ||
		/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
		new RegExp(SECRET_ASSIGNMENT.source, "im").test(value)
	);
}

function redactSensitive(value: string): string {
	return value
		.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
		.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
		.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function limitText(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) return { text: value, truncated: false };
	return { text: `${value.slice(0, maxChars)}\n[…truncated…]`, truncated: true };
}

function lastLines(value: string, count = DEFAULT_SUMMARY_LINES): string {
	const lines = stripAnsi(value)
		.split(/\r?\n/)
		.filter((line) => line.length > 0);
	return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function uniqueLines(lines: readonly string[]): string[] {
	return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function inferOutputKind(command: string, stdout: string, stderr: string): ToolOutputKind {
	const normalized = command.trim().toLowerCase();
	if (/\b(?:rg|grep|find)\b/.test(normalized)) return "search";
	if (/\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|node\s+--test)\b/.test(normalized))
		return "test";
	if (/\b(?:tsc|tsgo|cargo\s+build|go\s+build|npm\s+(?:run\s+)?build|compile)\b/.test(normalized)) return "compile";
	if (/\b(?:cat|head|tail|sed\s+-n)\b/.test(normalized)) return "large_file";
	const combined = `${stderr}\n${stdout}`;
	if ((combined.match(/^\s*at\s+/gm) ?? []).length >= 3) return "stack";
	return "generic";
}

function relevantStackFrames(value: string): string[] {
	return uniqueLines(
		stripAnsi(value)
			.split(/\r?\n/)
			.filter(
				(line) =>
					/^\s*at\s+/.test(line) &&
					!line.includes("node_modules") &&
					!line.includes("node:internal") &&
					!line.includes("internal/"),
			),
	).slice(0, 12);
}

function normalizeError(value: string): string {
	return stripAnsi(value)
		.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
		.replace(/0x[0-9a-f]+/gi, "<address>")
		.replace(/:\d+:\d+/g, ":<line>:<col>")
		.replace(/\s+/g, " ")
		.trim();
}

function errorFingerprint(exitCode: number, status: ToolResultStatus, stdout: string, stderr: string): string | null {
	if (exitCode === 0 && status === "success") return null;
	const normalized = normalizeError(stderr || stdout || `exit_code=${exitCode};status=${status}`);
	return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

interface Summary {
	stdout: string;
	stderr: string;
	frames: string[];
	truncated: boolean;
}

function summarizeCompile(stdout: string, stderr: string): Summary {
	const combined = stripAnsi([stderr, stdout].filter(Boolean).join("\n"));
	const lines = combined.split(/\r?\n/);
	const root = lines.filter((line) => /(?:error\s+TS\d+|\berror\b|exception|:\d+:\d+)/i.test(line)).slice(0, 12);
	const tail = lines.slice(-30);
	const summary = uniqueLines([...root, ...tail]).join("\n");
	const limited = limitText(redactSensitive(summary), DEFAULT_SUMMARY_CHARS);
	return {
		stdout: "",
		stderr: limited.text,
		frames: relevantStackFrames(combined),
		truncated: limited.truncated || lines.length > 30,
	};
}

function summarizeTest(stdout: string, stderr: string): Summary {
	const combined = stripAnsi([stdout, stderr].filter(Boolean).join("\n"));
	const lines = combined.split(/\r?\n/);
	const failures = lines.filter((line) =>
		/(?:\bFAIL(?:ED)?\b|AssertionError|Expected|Received|\bactual\b|\bexpected\b|^[\s]*[×✕❯])/i.test(line),
	);
	const selected = failures.length > 0 ? failures.slice(0, 30) : lines.slice(-30);
	const limited = limitText(redactSensitive(uniqueLines(selected).join("\n")), DEFAULT_SUMMARY_CHARS);
	return {
		stdout: limited.text,
		stderr: "",
		frames: relevantStackFrames(combined),
		truncated: limited.truncated || lines.length > selected.length,
	};
}

function summarizeStack(stdout: string, stderr: string): Summary {
	const combined = stripAnsi([stderr, stdout].filter(Boolean).join("\n"));
	const lines = combined.split(/\r?\n/);
	const roots = lines.filter((line) => line.trim() && !/^\s*at\s+/.test(line)).slice(0, 8);
	const frames = relevantStackFrames(combined);
	const limited = limitText(redactSensitive(uniqueLines(roots).join("\n")), DEFAULT_SUMMARY_CHARS);
	return {
		stdout: "",
		stderr: limited.text,
		frames,
		truncated: limited.truncated || lines.length > roots.length + frames.length,
	};
}

function searchDirectory(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	const parts = normalized.split("/").filter(Boolean);
	return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : ".";
}

function boundedSearchPreview(lines: readonly string[]): string[] {
	const preview: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (preview.length >= SEARCH_RESULT_COUNT_LIMIT) break;
		const separatorBytes = preview.length > 0 ? 1 : 0;
		const lineBytes = Buffer.byteLength(line, "utf8") + separatorBytes;
		if (bytes + lineBytes > SEARCH_RESULT_BYTE_LIMIT) break;
		preview.push(line);
		bytes += lineBytes;
	}
	return preview;
}

function summarizeSearch(stdout: string, stderr: string): Summary {
	const lines = stripAnsi(stdout).split(/\r?\n/).filter(Boolean);
	const totalBytes = Buffer.byteLength(stdout, "utf8");
	const groups = new Map<string, number>();
	for (const line of lines) {
		const path = line.split(":", 1)[0] ?? line;
		const directory = searchDirectory(path);
		groups.set(directory, (groups.get(directory) ?? 0) + 1);
	}
	const groupSummary = [...groups.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 12)
		.map(([directory, count]) => `${directory}: ${count}`)
		.join(", ");
	const preview = boundedSearchPreview(lines);
	const limitExceeded = lines.length > SEARCH_RESULT_COUNT_LIMIT || totalBytes > SEARCH_RESULT_BYTE_LIMIT;
	const text = [
		`matches=${lines.length}`,
		limitExceeded
			? `search limits exceeded: result_count_limit=${SEARCH_RESULT_COUNT_LIMIT}, total_byte_limit=${SEARCH_RESULT_BYTE_LIMIT}, observed_bytes=${totalBytes}; narrow the search scope and retry`
			: "",
		groupSummary ? `groups=${groupSummary}` : "",
		preview.length > 0 ? `preview:\n${preview.join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const limited = limitText(redactSensitive(text), DEFAULT_SUMMARY_CHARS);
	const stderrLimited = limitText(redactSensitive(lastLines(stderr)), DEFAULT_SUMMARY_CHARS);
	return {
		stdout: limited.text,
		stderr: stderrLimited.text,
		frames: relevantStackFrames(stderr),
		truncated: limitExceeded || limited.truncated || stderrLimited.truncated || lines.length > preview.length,
	};
}

function summarizeLargeFile(stdout: string, stderr: string): Summary {
	const lines = stripAnsi(stdout).split(/\r?\n/);
	const symbols = lines
		.map((line, index) => ({ line, lineNumber: index + 1 }))
		.filter(({ line }) =>
			/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|func)\s+[A-Za-z_$][\w$]*/.test(line),
		)
		.slice(0, 16)
		.map(({ line, lineNumber }) => `L${lineNumber}: ${line.trim()}`);
	const windowEnd = Math.min(lines.length, 12);
	const contextWindow = lines
		.slice(0, windowEnd)
		.map((line, index) => `L${index + 1}: ${line}`)
		.join("\n");
	const summary = [
		`large_file_lines=${lines.length}`,
		symbols.length > 0 ? `symbols:\n${symbols.join("\n")}` : "symbols=none-detected",
		windowEnd > 0 ? `context_window=L1-L${windowEnd}:\n${contextWindow}` : "context_window=empty",
		"full file content withheld; use artifact_id + next_cursor for an explicit bounded page",
	].join("\n");
	const limited = limitText(redactSensitive(summary), DEFAULT_SUMMARY_CHARS);
	const stderrLimited = limitText(redactSensitive(lastLines(stderr)), DEFAULT_SUMMARY_CHARS);
	return {
		stdout: limited.text,
		stderr: stderrLimited.text,
		frames: relevantStackFrames(stderr),
		truncated: stdout.length > contextWindow.length || limited.truncated || stderrLimited.truncated,
	};
}

function summarizeGeneric(stdout: string, stderr: string): Summary {
	const stdoutLimited = limitText(redactSensitive(lastLines(stdout)), DEFAULT_SUMMARY_CHARS);
	const stderrLimited = limitText(redactSensitive(lastLines(stderr)), DEFAULT_SUMMARY_CHARS);
	return {
		stdout: stdoutLimited.text,
		stderr: stderrLimited.text,
		frames: relevantStackFrames(`${stderr}\n${stdout}`),
		truncated:
			stdoutLimited.truncated ||
			stderrLimited.truncated ||
			stripAnsi(stdout).split(/\r?\n/).filter(Boolean).length > DEFAULT_SUMMARY_LINES ||
			stripAnsi(stderr).split(/\r?\n/).filter(Boolean).length > DEFAULT_SUMMARY_LINES,
	};
}

function summarize(kind: ToolOutputKind, stdout: string, stderr: string): Summary {
	switch (kind) {
		case "compile":
			return summarizeCompile(stdout, stderr);
		case "test":
			return summarizeTest(stdout, stderr);
		case "stack":
			return summarizeStack(stdout, stderr);
		case "search":
			return summarizeSearch(stdout, stderr);
		case "large_file":
			return summarizeLargeFile(stdout, stderr);
		default:
			return summarizeGeneric(stdout, stderr);
	}
}

function encodeCursor(artifactId: string, offset: number): string {
	return `${CURSOR_PREFIX}${artifactId}:${offset}`;
}

function decodeCursor(artifactId: string, cursor: string | undefined): number {
	if (!cursor) return 0;
	if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error("invalid tool artifact cursor");
	const payload = cursor.slice(CURSOR_PREFIX.length);
	const separator = payload.lastIndexOf(":");
	if (separator <= 0) throw new Error("invalid tool artifact cursor");
	const cursorArtifactId = payload.slice(0, separator);
	if (cursorArtifactId !== artifactId)
		throw new Error("tool artifact cursor does not belong to the requested artifact");
	const offset = Number.parseInt(payload.slice(separator + 1), 10);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid tool artifact cursor");
	return offset;
}

function rawArtifactText(stdout: string, stderr: string): string {
	return `[stdout]\n${stdout}\n[stderr]\n${stderr}`;
}

function lineDifferences(previous: string, current: string): string[] {
	const previousLines = new Set(
		stripAnsi(previous)
			.split(/\r?\n/)
			.map((line) => normalizeError(line))
			.filter(Boolean),
	);
	return uniqueLines(
		stripAnsi(current)
			.split(/\r?\n/)
			.filter((line) => line && !previousLines.has(normalizeError(line))),
	).slice(0, 6);
}

export interface ToolGatewayOptions {
	artifact_store: ArtifactStore;
	now?: () => string;
	clock_ms?: () => number;
	page_chars?: number;
	backpressure_controller?: ExecutionBackpressureController;
}

export interface ToolGatewayWrapInput {
	tool_name: string;
	task_id: string;
	task_revision: number;
	exit_code: number;
	stdout: string;
	stderr: string;
	status?: ToolResultStatus;
	duration_ms?: number;
	output_kind?: ToolOutputKind;
	captured_at?: string;
}

export interface ToolGatewayExecution {
	envelope: ToolResultEnvelope;
	command_evidence?: CommandEvidence;
	environment_error?: string;
}

export interface ToolGatewayBlockedInput {
	command: string;
	task_id: string;
	task_revision: number;
	reason: string;
	exit_code?: number;
	captured_at?: string;
}

export class ToolGateway {
	private readonly artifactStore: ArtifactStore;
	private readonly now: () => string;
	private readonly clockMs: () => number;
	private readonly pageChars: number;
	private readonly previousErrors = new Map<string, string>();
	private readonly backpressure?: ExecutionBackpressureController;

	constructor(options: ToolGatewayOptions) {
		this.artifactStore = options.artifact_store;
		this.now = options.now ?? (() => new Date().toISOString());
		this.clockMs = options.clock_ms ?? (() => Date.now());
		this.pageChars = Math.max(1, Math.min(options.page_chars ?? DEFAULT_PAGE_CHARS, MAX_PAGE_CHARS));
		this.backpressure = options.backpressure_controller;
	}

	admitBackpressure(input: BackpressureKey, at = this.clockMs()): BackpressureAdmission {
		return (
			this.backpressure?.admit(input, at) ?? {
				...input,
				action: "ALLOW",
				wait_ms: 0,
				reason: "no backpressure controller",
			}
		);
	}

	reportBackpressure(input: BackpressureSignal): BackpressureAdmission {
		return (
			this.backpressure?.report(input) ?? {
				scope: input.scope,
				key: input.key,
				action: "ALLOW",
				wait_ms: 0,
				reason: "no backpressure controller",
			}
		);
	}

	hasDurableArchive(): boolean {
		return this.artifactStore.isDurable();
	}

	private assertDurableArchive(): void {
		if (!this.hasDurableArchive()) throw new Error("ToolGateway raw archive is not durable");
	}

	wrap(input: ToolGatewayWrapInput): ToolResultEnvelope {
		const status = input.status ?? (input.exit_code === 0 ? "success" : "failure");
		const kind = input.output_kind ?? inferOutputKind(input.tool_name, input.stdout, input.stderr);
		const capturedAt = input.captured_at ?? this.now();
		const raw = rawArtifactText(input.stdout, input.stderr);
		const sensitiveInfo = containsSensitiveInfo(raw) ? "possible" : "none";
		const artifactPayload = {
			tool_name: input.tool_name,
			stdout: input.stdout,
			stderr: input.stderr,
			content_sha256: createHash("sha256").update(raw).digest("hex"),
			size_bytes: Buffer.byteLength(raw, "utf8"),
			captured_at: capturedAt,
			sensitive_info: sensitiveInfo,
		} satisfies JsonValue;
		const artifact = this.artifactStore.put(
			"tool_raw_output",
			1,
			artifactPayload,
			input.task_id,
			input.task_revision,
		);
		const fingerprint = errorFingerprint(input.exit_code, status, input.stdout, input.stderr);
		let summary = summarize(kind, input.stdout, input.stderr);
		if (fingerprint) {
			const previous = this.previousErrors.get(fingerprint);
			if (previous !== undefined) {
				const differences =
					sensitiveInfo === "possible" ? [] : lineDifferences(previous, raw).map((line) => redactSensitive(line));
				const repeatMessage = [
					`same as error fingerprint ${fingerprint}`,
					sensitiveInfo === "possible"
						? "new differences: withheld because archived output may contain sensitive data"
						: differences.length > 0
							? `new differences:\n${differences.join("\n")}`
							: "new differences: none",
				].join("; ");
				summary = { stdout: "", stderr: repeatMessage, frames: [], truncated: true };
			} else {
				this.previousErrors.set(fingerprint, raw);
			}
		}
		const envelope: ToolResultEnvelope = {
			exit_code: input.exit_code,
			status,
			duration: Math.max(0, input.duration_ms ?? 0),
			stdout_summary: summary.stdout,
			stderr_summary: summary.stderr,
			error_fingerprint: fingerprint,
			relevant_stack_frames: summary.frames.map((frame) => redactSensitive(frame)),
			artifact_id: artifact.digest,
			truncated: summary.truncated,
			next_cursor: summary.truncated ? encodeCursor(artifact.digest, 0) : null,
		};
		const validation = validateToolResultEnvelope(envelope);
		if (!validation.valid) throw new Error(`invalid tool result envelope: ${validation.errors.join("; ")}`);
		return structuredClone(envelope);
	}

	markBlocked(envelope: ToolResultEnvelope, reason: string, exitCode = 126): ToolResultEnvelope {
		const redacted = limitText(redactSensitive(reason), DEFAULT_SUMMARY_CHARS).text;
		const blocked: ToolResultEnvelope = {
			...structuredClone(envelope),
			exit_code: exitCode,
			status: "blocked",
			stderr_summary: redacted,
			error_fingerprint: `sha256:${createHash("sha256").update(`blocked:${redacted}`).digest("hex")}`,
		};
		const validation = validateToolResultEnvelope(blocked);
		if (!validation.valid) throw new Error(`invalid blocked tool result envelope: ${validation.errors.join("; ")}`);
		return blocked;
	}

	createBlockedCommand(input: ToolGatewayBlockedInput): ToolGatewayExecution & { command_evidence: CommandEvidence } {
		this.assertDurableArchive();
		const envelope = this.wrap({
			tool_name: input.command,
			task_id: input.task_id,
			task_revision: input.task_revision,
			exit_code: input.exit_code ?? 126,
			stdout: "",
			stderr: input.reason,
			status: "blocked",
			output_kind: "generic",
			captured_at: input.captured_at,
		});
		return {
			envelope,
			command_evidence: {
				command: input.command,
				exit_code: envelope.exit_code,
				stdout: envelope.stdout_summary,
				stderr: envelope.stderr_summary,
			},
		};
	}

	async executeCommand(input: {
		command: string;
		task_id: string;
		task_revision: number;
		runner: (command: string) => Promise<CommandEvidence> | CommandEvidence;
		output_kind?: ToolOutputKind;
		captured_at?: string;
		backpressure_key?: BackpressureKey;
	}): Promise<ToolGatewayExecution> {
		this.assertDurableArchive();
		if (input.backpressure_key) {
			const admission = this.admitBackpressure(input.backpressure_key);
			if (admission.action === "QUEUE") {
				return this.createBlockedCommand({
					command: input.command,
					task_id: input.task_id,
					task_revision: input.task_revision,
					reason: `backpressure queued ${admission.scope}:${admission.key}; wait_ms=${admission.wait_ms}`,
					captured_at: input.captured_at,
				});
			}
		}
		const started = this.clockMs();
		try {
			const raw = await input.runner(input.command);
			const envelope = this.wrap({
				tool_name: input.command,
				task_id: input.task_id,
				task_revision: input.task_revision,
				exit_code: raw.exit_code,
				stdout: raw.stdout,
				stderr: raw.stderr,
				duration_ms: this.clockMs() - started,
				output_kind: input.output_kind,
				captured_at: input.captured_at,
			});
			return {
				envelope,
				command_evidence: {
					command: input.command,
					exit_code: envelope.exit_code,
					stdout: envelope.stdout_summary,
					stderr: envelope.stderr_summary,
				},
			};
		} catch (error) {
			const detail = error instanceof Error ? error.stack || error.message : String(error);
			const envelope = this.wrap({
				tool_name: input.command,
				task_id: input.task_id,
				task_revision: input.task_revision,
				exit_code: -1,
				stdout: "",
				stderr: detail,
				status: "error",
				duration_ms: this.clockMs() - started,
				output_kind: "stack",
				captured_at: input.captured_at,
			});
			return {
				envelope,
				environment_error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	readArtifactPage(artifactId: string, cursor?: string, maxChars?: number): ToolArtifactPage {
		const artifact = this.artifactStore.get(artifactId);
		if (!artifact || artifact.type !== "tool_raw_output" || artifact.schema_version !== 1)
			throw new Error(`unknown tool output artifact: ${artifactId}`);
		if (!artifact.payload || typeof artifact.payload !== "object" || Array.isArray(artifact.payload))
			throw new Error(`invalid tool output artifact: ${artifactId}`);
		if (
			typeof artifact.payload.tool_name !== "string" ||
			typeof artifact.payload.stdout !== "string" ||
			typeof artifact.payload.stderr !== "string" ||
			typeof artifact.payload.content_sha256 !== "string" ||
			typeof artifact.payload.size_bytes !== "number" ||
			typeof artifact.payload.captured_at !== "string" ||
			(artifact.payload.sensitive_info !== "none" && artifact.payload.sensitive_info !== "possible")
		)
			throw new Error(`invalid tool output artifact metadata: ${artifactId}`);
		const stdout = artifact.payload.stdout;
		const stderr = artifact.payload.stderr;
		const sensitiveInfo = artifact.payload.sensitive_info;
		const raw = rawArtifactText(stdout, stderr);
		const contentHash = createHash("sha256").update(raw).digest("hex");
		if (
			artifact.payload.content_sha256 !== contentHash ||
			artifact.payload.size_bytes !== Buffer.byteLength(raw, "utf8")
		)
			throw new Error(`invalid tool output artifact content metadata: ${artifactId}`);
		const safeContent = redactSensitive(raw);
		const offset = decodeCursor(artifactId, cursor);
		if (offset > safeContent.length) throw new Error("tool artifact cursor is beyond the archived output");
		const pageSize = Math.max(1, Math.min(maxChars ?? this.pageChars, MAX_PAGE_CHARS));
		const end = Math.min(safeContent.length, offset + pageSize);
		return {
			artifact_id: artifactId,
			content: safeContent.slice(offset, end),
			next_cursor: end < safeContent.length ? encodeCursor(artifactId, end) : null,
			truncated: end < safeContent.length,
			sensitive_info: sensitiveInfo,
		};
	}
}
