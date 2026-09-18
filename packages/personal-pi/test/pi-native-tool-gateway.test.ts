import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import piPermissionGate from "../src/adapters/pi-permission-gate.ts";
import {
	ArtifactStore,
	type CliObservation,
	createCliObservation,
	type JsonlProcessOptions,
	legalNoOpReceipt,
	PiAgentWorkerAdapter,
	type TaskContract,
	type ToolResultEnvelope,
	type WorkerProtocolRequest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "pph-pi-tool-gateway-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	delete process.env.PPH_PI_TOOL_POLICY;
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

function requestFor(task: TaskContract, artifactRoot?: string): WorkerProtocolRequest {
	return {
		task,
		protocol: {
			task_id: task.id,
			schema_version: 2,
			task_revision: task.task_revision,
			graph_revision: task.graph_revision,
			lease_epoch: 1,
			idempotency_key: task.execution.idempotency_key,
		},
		run_id: `run-${task.id}`,
		requested_actions: [],
		permission_request: {},
		tool_artifact_root: artifactRoot,
	};
}

function successText(): string {
	return JSON.stringify({
		status: "success",
		summary: "bounded child completed",
		changed_files: [],
		artifacts: [],
		evidence: ["fake-process"],
		errors: [],
		work_receipt: legalNoOpReceipt("fake no-op", ["fake-process"]),
	});
}

function emitIdentityAndResult(options: JsonlProcessOptions, observation: CliObservation): void {
	options.on_event({ type: "message_start", message: { role: "assistant" } }, observation);
	options.on_event(
		{
			type: "message_end",
			message: {
				role: "assistant",
				provider: "opencodex",
				model: "ArkCoding/deepseek-v4-flash-ga-260731",
				stopReason: "stop",
				usage: { input: 12, output: 8, totalTokens: 20, cost: { total: 0 } },
				content: [{ type: "text", text: successText() }],
			},
		},
		observation,
	);
}

function exactEnvelope(overrides: Partial<ToolResultEnvelope> = {}): ToolResultEnvelope {
	return {
		exit_code: 0,
		status: "success",
		duration: 3,
		stdout_summary: "bounded output",
		stderr_summary: "",
		error_fingerprint: null,
		relevant_stack_frames: [],
		artifact_id: "a".repeat(64),
		truncated: false,
		next_cursor: null,
		...overrides,
	};
}

function installGate(policy: Record<string, unknown>) {
	process.env.PPH_PI_TOOL_POLICY = JSON.stringify(policy);
	const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
	piPermissionGate({
		on: (event: string, handler: (value: Record<string, unknown>) => Promise<unknown>) =>
			handlers.set(event, handler),
	} as never);
	return handlers;
}

describe("Pi native T4.2-C Tool Gateway boundary", () => {
	test("archives exact bash stdout and replaces native tool_result with an exact bounded envelope", async () => {
		const directory = temporaryDirectory();
		const artifactRoot = join(directory, "artifacts");
		const stdoutPath = join(directory, "pi-bash-stdout.log");
		const fullRaw = "line one\napi_key=SUPER_SECRET_VALUE\nline three\n";
		writeFileSync(stdoutPath, fullRaw, "utf8");
		const handlers = installGate({
			working_directory: directory,
			allowed_tools: ["bash"],
			read_scopes: ["."],
			write_scopes: [],
			shell_allowed: ["git status"],
			network: false,
			artifact_store_root: artifactRoot,
			task_id: "pi-native-envelope",
			task_revision: 4,
		});
		const toolCall = handlers.get("tool_call");
		const toolResult = handlers.get("tool_result");
		expect(toolCall).toBeDefined();
		expect(toolResult).toBeDefined();
		expect(
			await toolCall?.({ toolCallId: "call-1", toolName: "bash", input: { command: "git status" } }),
		).toBeUndefined();
		const shaped = (await toolResult?.({
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "git status" },
			content: [{ type: "text", text: "TRUNCATED_NATIVE_MARKER" }],
			details: {
				stdoutFullOutputPath: stdoutPath,
				stdoutBytes: Buffer.byteLength(fullRaw),
				stderrBytes: 0,
				streamSeparation: "exact",
				outcome: { kind: "exit", exit_code: 0 },
			},
			isError: false,
		})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };

		expect(shaped.details).toEqual({});
		expect(shaped.content).toHaveLength(1);
		const envelope = JSON.parse(shaped.content[0]?.text ?? "{}") as ToolResultEnvelope;
		expect(Object.keys(envelope).sort()).toEqual(
			[
				"exit_code",
				"status",
				"duration",
				"stdout_summary",
				"stderr_summary",
				"error_fingerprint",
				"relevant_stack_frames",
				"artifact_id",
				"truncated",
				"next_cursor",
			].sort(),
		);
		expect(JSON.stringify(envelope)).not.toContain("SUPER_SECRET_VALUE");
		expect(JSON.stringify(envelope)).not.toContain("TRUNCATED_NATIVE_MARKER");
		const artifact = new ArtifactStore(artifactRoot).get(envelope.artifact_id);
		expect(artifact?.producer_task_id).toBe("pi-native-envelope");
		expect(artifact?.producer_task_revision).toBe(4);
		const payload = artifact?.payload as Record<string, unknown>;
		expect(payload.stdout).toBe(fullRaw);
		expect(payload.stderr).toBe("");
		expect(payload.sensitive_info).toBe("possible");
		expect(typeof payload.content_sha256).toBe("string");
		expect(typeof payload.size_bytes).toBe("number");
		expect(typeof payload.captured_at).toBe("string");
		expect(existsSync(stdoutPath)).toBe(false);
	});

	test("archives generic tool backing before native display truncation", async () => {
		const directory = temporaryDirectory();
		const artifactRoot = join(directory, "artifacts");
		const backingPath = join(directory, "read-full.log");
		const fullRaw = [
			...Array.from({ length: 20 }, (_, index) => `visible-context-${index}`),
			"RAW_BACKING_ONLY_MARKER",
			...Array.from({ length: 20 }, (_, index) => `tail-${index}`),
		].join("\n");
		writeFileSync(backingPath, fullRaw, "utf8");
		const handlers = installGate({
			working_directory: directory,
			allowed_tools: ["read"],
			read_scopes: ["."],
			write_scopes: [],
			shell_allowed: [],
			network: false,
			artifact_store_root: artifactRoot,
			task_id: "pi-native-read-backing",
			task_revision: 1,
		});
		const toolCall = handlers.get("tool_call");
		const toolResult = handlers.get("tool_result");
		expect(await toolCall?.({ toolCallId: "read-1", toolName: "read", input: { path: "file.ts" } })).toBeUndefined();
		const shaped = (await toolResult?.({
			toolCallId: "read-1",
			toolName: "read",
			input: { path: "file.ts" },
			content: [{ type: "text", text: "first\n[…native truncated…]" }],
			details: { fullOutputPath: backingPath, fullOutputBytes: Buffer.byteLength(fullRaw) },
			isError: false,
		})) as { content: Array<{ type: string; text: string }> };
		const envelope = JSON.parse(shaped.content[0]?.text ?? "{}") as ToolResultEnvelope;
		expect(JSON.stringify(envelope)).not.toContain("RAW_BACKING_ONLY_MARKER");
		expect(new ArtifactStore(artifactRoot).get(envelope.artifact_id)?.payload).toMatchObject({ stdout: fullRaw });
		expect(existsSync(backingPath)).toBe(false);
	});

	test("preserves bash nonzero, timeout, and abort outcomes with separated raw streams", async () => {
		const directory = temporaryDirectory();
		const artifactRoot = join(directory, "artifacts");
		const handlers = installGate({
			working_directory: directory,
			allowed_tools: ["bash"],
			read_scopes: ["."],
			write_scopes: [],
			shell_allowed: ["node --test"],
			network: false,
			artifact_store_root: artifactRoot,
			task_id: "pi-native-bash-outcomes",
			task_revision: 3,
		});
		const toolCall = handlers.get("tool_call");
		const toolResult = handlers.get("tool_result");
		for (const testCase of [
			{ id: "exit", outcome: { kind: "exit", exit_code: 23 }, status: "failure", exitCode: 23 },
			{
				id: "timeout",
				outcome: { kind: "timeout", exit_code: null, timeout_seconds: 5 },
				status: "error",
				exitCode: -1,
			},
			{ id: "abort", outcome: { kind: "abort", exit_code: 130 }, status: "error", exitCode: 130 },
		] as const) {
			const stdoutPath = join(directory, `${testCase.id}-stdout.log`);
			const stderrPath = join(directory, `${testCase.id}-stderr.log`);
			writeFileSync(stdoutPath, `stdout-${testCase.id}`, "utf8");
			writeFileSync(stderrPath, `stderr-${testCase.id}`, "utf8");
			expect(
				await toolCall?.({ toolCallId: testCase.id, toolName: "bash", input: { command: "node --test" } }),
			).toBeUndefined();
			const shaped = (await toolResult?.({
				toolCallId: testCase.id,
				toolName: "bash",
				input: { command: "node --test" },
				content: [{ type: "text", text: "native bounded display" }],
				details: {
					stdoutFullOutputPath: stdoutPath,
					stdoutBytes: Buffer.byteLength(`stdout-${testCase.id}`),
					stderrFullOutputPath: stderrPath,
					stderrBytes: Buffer.byteLength(`stderr-${testCase.id}`),
					streamSeparation: "exact",
					outcome: testCase.outcome,
				},
				isError: true,
			})) as { content: Array<{ type: string; text: string }> };
			const envelope = JSON.parse(shaped.content[0]?.text ?? "{}") as ToolResultEnvelope;
			expect(envelope).toMatchObject({ status: testCase.status, exit_code: testCase.exitCode });
			expect(new ArtifactStore(artifactRoot).get(envelope.artifact_id)?.payload).toMatchObject({
				stdout: `stdout-${testCase.id}`,
				stderr: `stderr-${testCase.id}`,
			});
			expect(existsSync(stdoutPath)).toBe(false);
			expect(existsSync(stderrPath)).toBe(false);
		}
	});

	test("uses canonical CommandRiskClassifier before bash execution", async () => {
		const directory = temporaryDirectory();
		const artifactRoot = join(directory, "artifacts");
		const handlers = installGate({
			working_directory: directory,
			allowed_tools: ["bash"],
			read_scopes: ["."],
			write_scopes: ["."],
			shell_allowed: ["*"],
			network: false,
			artifact_store_root: artifactRoot,
			task_id: "pi-native-risk",
			task_revision: 1,
		});
		const toolCall = handlers.get("tool_call");
		expect(
			await toolCall?.({ toolCallId: "safe", toolName: "bash", input: { command: "git status" } }),
		).toBeUndefined();
		expect(
			await toolCall?.({ toolCallId: "risky", toolName: "bash", input: { command: "npm publish" } }),
		).toMatchObject({ block: true, terminate: true });
		expect(
			await toolCall?.({ toolCallId: "danger", toolName: "bash", input: { command: "rm -rf tmp" } }),
		).toMatchObject({ block: true, terminate: true });
		expect(readdirSync(artifactRoot)).toEqual([]);
	});

	test("shapes a pre-execution blocked tool call as a blocked envelope", async () => {
		const directory = temporaryDirectory();
		const artifactRoot = join(directory, "artifacts");
		const handlers = installGate({
			working_directory: directory,
			allowed_tools: ["bash"],
			read_scopes: ["."],
			write_scopes: ["."],
			shell_allowed: ["*"],
			network: false,
			artifact_store_root: artifactRoot,
			task_id: "pi-native-blocked",
			task_revision: 2,
		});
		const toolCall = handlers.get("tool_call");
		const toolResult = handlers.get("tool_result");
		const blocked = (await toolCall?.({
			toolCallId: "blocked-call",
			toolName: "bash",
			input: { command: "npm publish" },
		})) as { reason?: string };
		expect(blocked.reason).toContain("requires controller approval");
		const shaped = (await toolResult?.({
			toolCallId: "blocked-call",
			toolName: "bash",
			input: { command: "npm publish" },
			content: [{ type: "text", text: blocked.reason ?? "blocked" }],
			details: {},
			isError: true,
		})) as { content: Array<{ type: string; text: string }> };
		const envelope = JSON.parse(shaped.content[0]?.text ?? "{}") as ToolResultEnvelope;
		expect(envelope).toMatchObject({ status: "blocked", exit_code: 126 });
		expect(new ArtifactStore(artifactRoot).get(envelope.artifact_id)?.payload).toMatchObject({
			stderr: expect.stringContaining("requires controller approval"),
		});
	});

	test("parent accepts only shaped tool_execution_end and exposes getToolResults", async () => {
		const directory = temporaryDirectory();
		const task = makeV3Task("pi-native-parent", {
			execution: { ...makeV3Task("pi-native-parent").execution, allowed_tools: ["read"] },
		});
		const envelope = exactEnvelope();
		let capturedPolicy: Record<string, unknown> | undefined;
		const adapter = new PiAgentWorkerAdapter({
			worker_id: "pi-native-parent",
			run_process: async (options) => {
				capturedPolicy = JSON.parse(options.env.PPH_PI_TOOL_POLICY ?? "{}") as Record<string, unknown>;
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event(
					{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "x" } },
					observation,
				);
				options.on_event(
					{
						type: "tool_execution_end",
						toolCallId: "tool-1",
						toolName: "read",
						result: { content: [{ type: "text", text: JSON.stringify(envelope) }], details: {} },
						isError: false,
					},
					observation,
				);
				emitIdentityAndResult(options, observation);
				return { observation };
			},
		});
		const result = await adapter.execute(requestFor(task, join(directory, "artifacts")));
		expect(result.status).toBe("success");
		expect(adapter.getToolResults()).toEqual([envelope]);
		expect(capturedPolicy).toMatchObject({
			artifact_store_root: join(directory, "artifacts"),
			task_id: task.id,
			task_revision: task.task_revision,
		});
	});

	test("parent fails closed on raw tool output", async () => {
		const directory = temporaryDirectory();
		const task = makeV3Task("pi-native-raw", {
			execution: { ...makeV3Task("pi-native-raw").execution, allowed_tools: ["read"] },
		});
		let decision: { terminate?: boolean; reason?: string } | undefined;
		const adapter = new PiAgentWorkerAdapter({
			worker_id: "pi-native-raw",
			run_process: async (options) => {
				const observation = createCliObservation();
				observation.exit_code = 0;
				options.on_event(
					{ type: "tool_execution_start", toolCallId: "tool-raw", toolName: "read", args: { path: "x" } },
					observation,
				);
				decision = options.on_event(
					{
						type: "tool_execution_end",
						toolCallId: "tool-raw",
						toolName: "read",
						result: { content: [{ type: "text", text: "RAW_SECRET_MARKER" }], details: { leaked: true } },
						isError: false,
					},
					observation,
				);
				emitIdentityAndResult(options, observation);
				return { observation };
			},
		});
		const result = await adapter.execute(requestFor(task, join(directory, "artifacts")));
		expect(decision?.terminate).toBe(true);
		expect(result.status).toBe("failure");
		expect(result.summary).not.toContain("RAW_SECRET_MARKER");
		expect(adapter.getToolResults()).toEqual([]);
	});

	test("fails closed before spawning Pi when tools lack a durable artifact root", async () => {
		const task = makeV3Task("pi-native-no-root", {
			execution: { ...makeV3Task("pi-native-no-root").execution, allowed_tools: ["read"] },
		});
		let calls = 0;
		const adapter = new PiAgentWorkerAdapter({
			worker_id: "pi-native-no-root",
			run_process: async () => {
				calls += 1;
				return { observation: createCliObservation() };
			},
		});
		const result = await adapter.execute(requestFor(task));
		expect(calls).toBe(0);
		expect(result.status).toBe("failure");
		expect(result.errors).toContain("tool_artifact_root_missing");
	});
});
