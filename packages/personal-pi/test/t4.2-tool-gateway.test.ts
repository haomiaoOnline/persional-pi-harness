import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ArtifactStore,
	CommandRiskClassifier,
	captureWorkspaceSnapshot,
	LifecycleHookManager,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	type TaskContract,
	ToolGateway,
	type ToolOutputKind,
	validateToolResultEnvelope,
} from "../src/index.ts";
import { AVAILABLE_WORKER_STATUS, makeV3Task, planFor, requirementFor } from "./v3-fixtures.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

function rawArtifactText(stdout: string, stderr: string): string {
	return `[stdout]\n${stdout}\n[stderr]\n${stderr}`;
}

function durableArtifactStore(prefix: string): { root: string; store: ArtifactStore } {
	const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
	temporaryDirectories.push(root);
	return { root, store: new ArtifactStore(root) };
}

function verificationTask(id: string, command: string): TaskContract {
	return makeV3Task(id, {
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [command] },
			network: "deny",
			credentials: "deny",
		},
		verification: {
			strategy: "automated",
			commands: [command],
			checks: ["independent command"],
			evidence_required: ["independent_command"],
			strength: "strong",
		},
	});
}

function legalNoOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "T4.2-C verification-only test",
		evidence_refs: ["worker_result"],
	};
}

class RecordingCommandRiskClassifier extends CommandRiskClassifier {
	readonly calls: string[];

	constructor(calls: string[]) {
		super();
		this.calls = calls;
	}

	override classify(command: string) {
		this.calls.push(`risk:${command}`);
		return super.classify(command);
	}
}

describe("T4.2-C ToolGateway", () => {
	test("emits the exact ten-field envelope and archives full raw output with integrity metadata", () => {
		const store = new ArtifactStore();
		const gateway = new ToolGateway({ artifact_store: store, now: () => "2026-09-18T12:34:56.000Z" });
		const stdout = "compile started";
		const stderr = "token=abcdefghijklmnop";
		const raw = rawArtifactText(stdout, stderr);
		const envelope = gateway.wrap({
			tool_name: "tsc --noEmit",
			task_id: "tool-envelope",
			task_revision: 3,
			exit_code: 1,
			stdout,
			stderr,
			duration_ms: 17,
			output_kind: "compile",
		});

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
		expect(validateToolResultEnvelope(envelope)).toMatchObject({ valid: true, errors: [] });
		expect(validateToolResultEnvelope({ ...envelope, raw_output: "forbidden" })).toMatchObject({ valid: false });
		const { duration: _duration, ...missingDuration } = envelope;
		expect(validateToolResultEnvelope(missingDuration)).toMatchObject({ valid: false });

		const artifact = store.get(envelope.artifact_id);
		expect(artifact).toMatchObject({
			type: "tool_raw_output",
			schema_version: 1,
			producer_task_id: "tool-envelope",
			producer_task_revision: 3,
			payload: {
				tool_name: "tsc --noEmit",
				stdout,
				stderr,
				content_sha256: createHash("sha256").update(raw).digest("hex"),
				size_bytes: Buffer.byteLength(raw, "utf8"),
				captured_at: "2026-09-18T12:34:56.000Z",
				sensitive_info: "possible",
			},
		});
		expect(envelope.stderr_summary).not.toContain("abcdefghijklmnop");
	});

	test("keeps compile, test, stack, search, large-file, and generic summaries bounded and task-oriented", () => {
		const gateway = new ToolGateway({ artifact_store: new ArtifactStore() });
		const cases: Array<{
			kind: ToolOutputKind;
			stdout: string;
			stderr: string;
			expected: string;
		}> = [
			{
				kind: "compile",
				stdout: "build output",
				stderr: "src/main.ts:12:4 error TS2322: Type 'string' is not assignable",
				expected: "TS2322",
			},
			{
				kind: "test",
				stdout: "FAIL parser.test.ts\nExpected: 2\nReceived: 3",
				stderr: "",
				expected: "FAIL parser.test.ts",
			},
			{
				kind: "stack",
				stdout: "",
				stderr:
					"Error: boom\n    at first (/repo/src/a.ts:1:2)\n    at second (/repo/src/b.ts:3:4)\n    at third (/repo/src/c.ts:5:6)\n    at internal (node:internal/x:1:1)",
				expected: "Error: boom",
			},
			{
				kind: "search",
				stdout: "src/a.ts:1:hit\nsrc/b.ts:2:hit\ntest/a.test.ts:3:hit",
				stderr: "",
				expected: "matches=3",
			},
			{
				kind: "large_file",
				stdout: "export function alpha() {}\nline two\nclass Beta {}\nline four",
				stderr: "",
				expected: "symbols:",
			},
			{
				kind: "generic",
				stdout: Array.from({ length: 45 }, (_, index) => `generic-${index}`).join("\n"),
				stderr: "",
				expected: "generic-44",
			},
		];

		for (const [index, item] of cases.entries()) {
			const envelope = gateway.wrap({
				tool_name: `summary-${item.kind}`,
				task_id: `summary-${index}`,
				task_revision: 1,
				exit_code: item.kind === "compile" || item.kind === "test" || item.kind === "stack" ? 1 : 0,
				stdout: item.stdout,
				stderr: item.stderr,
				output_kind: item.kind,
			});
			const summary = `${envelope.stdout_summary}\n${envelope.stderr_summary}`;
			expect(summary).toContain(item.expected);
			expect(envelope.stdout_summary.length).toBeLessThan(4_100);
			expect(envelope.stderr_summary.length).toBeLessThan(4_100);
		}
	});

	test("bounds oversized search results and instructs the model to narrow scope while retaining artifact paging", () => {
		const store = new ArtifactStore();
		const gateway = new ToolGateway({ artifact_store: store });
		const stdout = Array.from(
			{ length: 1_000 },
			(_, index) => `src/generated/file-${index}.ts:${index + 1}:match-${index}`,
		).join("\n");
		const envelope = gateway.wrap({
			tool_name: "rg match src",
			task_id: "search-bounded",
			task_revision: 1,
			exit_code: 0,
			stdout,
			stderr: "",
			output_kind: "search",
		});

		expect(envelope.stdout_summary).toContain("matches=1000");
		expect(envelope.stdout_summary).toContain("search limits exceeded");
		expect(envelope.stdout_summary).toContain("narrow the search scope and retry");
		expect(envelope.stdout_summary).toContain("file-0.ts");
		expect(envelope.stdout_summary).not.toContain("file-999.ts");
		expect(envelope.truncated).toBe(true);
		expect(envelope.next_cursor).not.toBeNull();
		expect(store.get(envelope.artifact_id)?.payload).toMatchObject({ stdout });
	});

	test("suppresses duplicate error bodies by normalized fingerprint", () => {
		const gateway = new ToolGateway({ artifact_store: new ArtifactStore() });
		const first = gateway.wrap({
			tool_name: "node failing.js",
			task_id: "duplicate-error",
			task_revision: 1,
			exit_code: 1,
			stdout: "",
			stderr: "Error: failed at /repo/src/a.ts:10:2",
			output_kind: "generic",
		});
		const second = gateway.wrap({
			tool_name: "node failing.js",
			task_id: "duplicate-error",
			task_revision: 1,
			exit_code: 1,
			stdout: "",
			stderr: "Error: failed at /repo/src/a.ts:99:7",
			output_kind: "generic",
		});

		expect(second.error_fingerprint).toBe(first.error_fingerprint);
		expect(second.stderr_summary).toContain(`same as error fingerprint ${first.error_fingerprint}`);
		expect(second.stderr_summary).not.toContain("Error: failed at");
		expect(second.truncated).toBe(true);
	});

	test("binds cursors to artifacts, survives ArtifactStore restart, and redacts sensitive text before paging", () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-tool-gateway-"));
		temporaryDirectories.push(root);
		const secret = "abcdefghijklmnop-secret-value";
		const stdout = Array.from({ length: 45 }, (_, index) => (index === 4 ? `token=${secret}` : `line-${index}`)).join(
			"\n",
		);
		const firstGateway = new ToolGateway({ artifact_store: new ArtifactStore(root), page_chars: 7 });
		const envelope = firstGateway.wrap({
			tool_name: "cat output.log",
			task_id: "paged-output",
			task_revision: 1,
			exit_code: 0,
			stdout,
			stderr: "",
			output_kind: "generic",
		});
		expect(envelope.next_cursor).not.toBeNull();

		const restartedGateway = new ToolGateway({ artifact_store: new ArtifactStore(root), page_chars: 7 });
		let cursor = envelope.next_cursor ?? undefined;
		let fetched = "";
		do {
			const page = restartedGateway.readArtifactPage(envelope.artifact_id, cursor);
			fetched += page.content;
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(fetched).toContain("token=[REDACTED]");
		expect(fetched).not.toContain(secret);

		const other = firstGateway.wrap({
			tool_name: "cat other.log",
			task_id: "other-output",
			task_revision: 1,
			exit_code: 0,
			stdout: Array.from({ length: 40 }, (_, index) => `other-${index}`).join("\n"),
			stderr: "",
			output_kind: "generic",
		});
		expect(() => restartedGateway.readArtifactPage(other.artifact_id, envelope.next_cursor ?? undefined)).toThrow(
			"cursor does not belong to the requested artifact",
		);
	});

	test("redacts secret-like environment variable names in summaries and artifact pages", () => {
		const store = new ArtifactStore();
		const gateway = new ToolGateway({ artifact_store: store });
		const secret = "cf-secret-value-123456";
		const genericKeySecret = "generic-key-secret-123456";
		const envelope = gateway.wrap({
			tool_name: "diagnostic",
			task_id: "secret-like-key",
			task_revision: 1,
			exit_code: 0,
			stdout: `SAFE=value\nCLOUDFLARE_API_TOKEN=${secret}\nFOO_KEY=${genericKeySecret}\nOTHER_PASSWORD:another-secret`,
			stderr: "",
			output_kind: "generic",
		});
		const summary = `${envelope.stdout_summary}\n${envelope.stderr_summary}`;
		expect(summary).toContain("CLOUDFLARE_API_TOKEN=[REDACTED]");
		expect(summary).toContain("FOO_KEY=[REDACTED]");
		expect(summary).not.toContain(secret);
		expect(summary).not.toContain(genericKeySecret);
		const page = gateway.readArtifactPage(envelope.artifact_id, undefined, 16_000);
		expect(page.sensitive_info).toBe("possible");
		expect(page.content).toContain("CLOUDFLARE_API_TOKEN=[REDACTED]");
		expect(page.content).toContain("FOO_KEY=[REDACTED]");
		expect(page.content).not.toContain(secret);
		expect(page.content).not.toContain(genericKeySecret);
		expect(page.content).not.toContain("another-secret");
	});
});

describe("T4.2-C Pipeline ToolGateway integration", () => {
	test("classifies command risk before the runner and keeps archived raw markers out of Evidence", async () => {
		const command = "node --test";
		const task = verificationTask("pipeline-tool-gateway", command);
		const calls: string[] = [];
		const marker = "RAW-MARKER-MUST-STAY-IN-ARTIFACT";
		const stdout = [marker, ...Array.from({ length: 45 }, (_, index) => `test-output-${index}`)].join("\n");
		const { store: artifactStore } = durableArtifactStore("personal-pi-tool-gateway-pipeline");
		const execution = await new PersonalPiPipeline({ artifact_store: artifactStore }).execute({
			...planFor(task),
			requirement: requirementFor("T4.2-C pipeline gateway"),
			task,
			worker: new PiWorker("pi-t4.2", () => ({
				status: "success",
				summary: "worker completed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_risk_classifier: new RecordingCommandRiskClassifier(calls),
			command_runner: (requestedCommand) => {
				calls.push(`run:${requestedCommand}`);
				return { command: requestedCommand, exit_code: 0, stdout, stderr: "" };
			},
			snapshot: captureWorkspaceSnapshot("pipeline-tool-gateway", [], []),
		});

		expect(calls).toEqual([`risk:${command}`, `run:${command}`]);
		expect(execution.evidence.evidence_types).toContain("command-risk:safe:auto_run");
		expect(execution.evidence.tool_results).toHaveLength(1);
		expect(JSON.stringify(execution.evidence)).not.toContain(marker);
		const artifactId = execution.evidence.tool_results?.[0]?.artifact_id;
		expect(artifactId).toBeTruthy();
		expect(artifactStore.get(artifactId as string)?.payload).toMatchObject({ stdout });
	});

	test("uses canonical Command Risk by default and blocks an unknown verification command before its runner", async () => {
		const command = "custom-verify";
		const task = verificationTask("pipeline-default-risk", command);
		let runnerCalls = 0;
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-blocked-risk-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const artifactRoot = join(directory, "artifacts");
		const stateStore = new PersistentStateStore(statePath);
		const artifactStore = new ArtifactStore(artifactRoot);
		const execution = await new PersonalPiPipeline({
			state_store: stateStore,
			artifact_store: artifactStore,
		}).execute({
			...planFor(task),
			requirement: requirementFor("T4.2-C default command risk"),
			task,
			worker: new PiWorker("pi-t4.2-risk", () => ({
				status: "success",
				summary: "worker completed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: (requestedCommand) => {
				runnerCalls += 1;
				return { command: requestedCommand, exit_code: 0, stdout: "unexpected", stderr: "" };
			},
			snapshot: captureWorkspaceSnapshot("pipeline-default-risk", [], []),
		});

		expect(runnerCalls).toBe(0);
		expect(execution.evidence.commands[0]?.exit_code).toBe(125);
		expect(execution.evidence.evidence_types).toContain("command-risk:risky:ask_user");
		expect(execution.evidence.tool_results).toHaveLength(1);
		const blocked = execution.evidence.tool_results?.[0];
		expect(blocked?.status).toBe("blocked");
		expect(Object.keys(blocked ?? {}).sort()).toEqual(
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
		expect(new ArtifactStore(artifactRoot).get(blocked?.artifact_id as string)?.payload).toMatchObject({
			stderr: expect.stringContaining("ask_user"),
		});
		const restarted = new PersistentStateStore(statePath);
		expect(restarted.read().evidence.at(-1)?.tool_results?.[0]).toEqual(blocked);
	});

	test("archives a pre-tool lifecycle block while exposing only a redacted legacy CommandEvidence", async () => {
		const command = "node --test";
		const task = verificationTask("pipeline-lifecycle-block", command);
		const secret = "abcdefghijklmnop-lifecycle-secret";
		const { root, store: artifactStore } = durableArtifactStore("personal-pi-lifecycle-block");
		let runnerCalls = 0;
		const execution = await new PersonalPiPipeline({ artifact_store: artifactStore }).execute({
			...planFor(task),
			requirement: requirementFor("T4.2-C lifecycle block envelope"),
			task,
			worker: new PiWorker("pi-t4.2-lifecycle", () => ({
				status: "success",
				summary: "worker completed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			command_runner: (requestedCommand) => {
				runnerCalls += 1;
				return { command: requestedCommand, exit_code: 0, stdout: "unexpected", stderr: "" };
			},
			lifecycle_hooks: new LifecycleHookManager({
				hooks: [
					{
						id: "deny-sensitive",
						event: "pre_tool_use",
						kind: "static_check",
						run: () => ({ passed: false, detail: `token=${secret}` }),
					},
				],
			}),
			snapshot: captureWorkspaceSnapshot("pipeline-lifecycle-block", [], []),
		});

		expect(runnerCalls).toBe(0);
		expect(execution.evidence.tool_results?.[0]?.status).toBe("blocked");
		expect(execution.evidence.commands[0]?.stderr).toContain("token=[REDACTED]");
		expect(execution.evidence.commands[0]?.stderr).not.toContain(secret);
		const artifactId = execution.evidence.tool_results?.[0]?.artifact_id;
		expect(new ArtifactStore(root).get(artifactId as string)?.payload).toMatchObject({
			stderr: expect.stringContaining(secret),
		});
	});

	test("fails closed before runner execution when the ToolGateway raw archive is in-memory", async () => {
		const command = "node --test";
		const task = verificationTask("pipeline-in-memory-archive", command);
		const artifactStore = new ArtifactStore();
		expect(artifactStore.isDurable()).toBe(false);
		let runnerCalls = 0;

		await expect(
			new PersonalPiPipeline({ artifact_store: artifactStore }).execute({
				...planFor(task),
				requirement: requirementFor("T4.2-C durable archive required"),
				task,
				worker: new PiWorker("pi-t4.2-memory", () => ({
					status: "success",
					summary: "must not execute",
					evidence: ["worker_result"],
					work_receipt: legalNoOpReceipt(),
				})),
				worker_status: AVAILABLE_WORKER_STATUS,
				command_runner: (requestedCommand) => {
					runnerCalls += 1;
					return { command: requestedCommand, exit_code: 0, stdout: "unexpected", stderr: "" };
				},
				snapshot: captureWorkspaceSnapshot("pipeline-in-memory-archive", [], []),
			}),
		).rejects.toThrow("ToolGateway raw archive is not durable");
		expect(runnerCalls).toBe(0);
	});
});
