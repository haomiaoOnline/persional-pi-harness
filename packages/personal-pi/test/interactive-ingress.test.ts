import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { routeInteractiveSubmission } from "../../coding-agent/src/modes/interactive/interactive-ingress.ts";
import { createPersonalPiInteractiveIngressFactory, PersistentStateStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "personal-pi-interactive-ingress-"));
	temporaryDirectories.push(directory);
	return directory;
}

function initializeGitRepository(directory: string): void {
	execFileSync("git", ["init", "-q"], { cwd: directory });
	writeFileSync(join(directory, "README.md"), "fixture\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: directory });
	execFileSync(
		"git",
		["-c", "user.name=PPH Test", "-c", "user.email=pph-test@example.invalid", "commit", "-q", "-m", "fixture"],
		{ cwd: directory },
	);
}

function writeFakePiCli(directory: string): string {
	const scriptPath = join(directory, "fake-pi-worker.mjs");
	writeFileSync(
		scriptPath,
		`import { writeFileSync } from "node:fs";
	const markerPath = process.argv[2];
	const args = process.argv.slice(3);
	writeFileSync(markerPath, JSON.stringify(args));
	const prompt = args.at(-1) ?? "";
	const contractMarker = "CONTRACT_PAYLOAD_JSON:\\n";
	const contractIndex = prompt.lastIndexOf(contractMarker);
	const payload = contractIndex >= 0 ? JSON.parse(prompt.slice(contractIndex + contractMarker.length)) : {};
	const taskId = String(payload.id ?? "unknown-task");
	const result = JSON.stringify({
	  status: "success",
	  summary: "TRANSCRIPT_ONLY_MARKER:" + taskId,
	  changed_files: [],
	  artifacts: [],
	  evidence: ["fake-child-process"],
  errors: [],
  work_receipt: {
    work_attempted: true,
    effects_count: 0,
    artifacts_created: [],
    state_changed: false,
    no_op: true,
    no_op_reason: "deterministic test worker",
    evidence_refs: ["fake-child-process"]
  }
});
process.stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant" } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    provider: "fake-provider",
    model: "fake-model",
    stopReason: "stop",
    usage: { input: 12, output: 8, totalTokens: 20, cost: { total: 0 } },
    content: [{ type: "text", text: result }]
  }
}) + "\\n");
`,
		"utf8",
	);
	return scriptPath;
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T7.0 bundled interactive Personal PI composition", () => {
	test("uses a real non-interactive PiAgentWorkerAdapter child and persists the governed control-plane chain", async () => {
		const cwd = temporaryDirectory();
		initializeGitRepository(cwd);
		const workerFixtureDirectory = temporaryDirectory();
		const statePath = join(workerFixtureDirectory, "state.json");
		const markerPath = join(workerFixtureDirectory, "worker-argv.json");
		const fakeCli = writeFakePiCli(workerFixtureDirectory);
		const permissionGateUrl = new URL("../src/adapters/pi-permission-gate.ts", import.meta.url);
		const session = SessionManager.inMemory(cwd);
		const handler = createPersonalPiInteractiveIngressFactory({
			state_path: statePath,
			task_id_factory: () => "interactive-task-1",
			permission_gate_path: permissionGateUrl,
			provider_mode: "mock",
			execution_surface: { pph_commit: "pph-commit-fixture", bundle_sha256: "bundle-sha-fixture" },
		})({
			recordExecutionSurface: (metadata) => session.appendCustomEntry("personal-pi.execution-surface", metadata),
			getWorkerRoute: () => ({
				cwd,
				command: process.execPath,
				command_args_prefix: [fakeCli, markerPath],
				provider: "fake-provider",
				model: "fake-model",
				thinking: "low",
				active_tools: ["read"],
				worker_status: {
					worker_capability: "available",
					execution_mode: "normal",
					delivery_status: "normal",
				},
			}),
		});
		const rawFallback = vi.fn(async () => ({ summary: "must not run" }));

		await routeInteractiveSubmission(handler, { text: "Implement the bounded interactive task" }, rawFallback);

		expect(rawFallback).not.toHaveBeenCalled();
		const workerArgs = JSON.parse(readFileSync(markerPath, "utf8")) as string[];
		expect(workerArgs.slice(0, 4)).toEqual(["-p", "--mode", "json", "--no-session"]);
		expect(workerArgs.filter((arg) => arg === "--mode")).toHaveLength(1);
		expect(workerArgs).not.toContain("interactive");
		expect(workerArgs).toContain("--no-extensions");
		expect(workerArgs).not.toContain("--no-tools");
		const toolsIndex = workerArgs.indexOf("--tools");
		expect(workerArgs[toolsIndex + 1]).toBe("read");
		const extensionIndex = workerArgs.indexOf("--extension");
		expect(workerArgs[extensionIndex + 1]).toBe(fileURLToPath(permissionGateUrl));
		const state = new PersistentStateStore(statePath).read();
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.id).toBe("interactive-task-1");
		expect(state.tasks[0]?.state).toBe("DONE");
		expect(state.dispatches).toHaveLength(1);
		expect(state.dispatches[0]?.task_id).toBe("interactive-task-1");
		expect(state.runs).toHaveLength(1);
		expect(state.runs[0]?.task_id).toBe("interactive-task-1");
		expect(state.loop_usage["interactive-task-1"]?.attempts).toBe(1);
		const surfaceEntry = session
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "personal-pi.execution-surface");
		expect(surfaceEntry?.type === "custom" ? surfaceEntry.data : undefined).toEqual({
			entrypoint: "interactive",
			pph_commit: "pph-commit-fixture",
			bundle_sha256: "bundle-sha-fixture",
			ingress_bound: true,
			pipeline_bound: true,
			scheduler_enabled: true,
			scheduler_kind: "direct",
		});
		expect(JSON.stringify(session.buildSessionContext().messages)).not.toContain("pph-commit-fixture");
	});

	test("fans explicit multi-entity research out through WorkerPool and fans in through receipt-only context", async () => {
		const cwd = temporaryDirectory();
		initializeGitRepository(cwd);
		const fixtureDirectory = temporaryDirectory();
		const statePath = join(fixtureDirectory, "state.json");
		const markerPath = join(fixtureDirectory, "worker-argv.json");
		const fakeCli = writeFakePiCli(fixtureDirectory);
		const permissionGateUrl = new URL("../src/adapters/pi-permission-gate.ts", import.meta.url);
		const session = SessionManager.inMemory(cwd);
		const handler = createPersonalPiInteractiveIngressFactory({
			state_path: statePath,
			task_id_factory: () => "multi-research",
			permission_gate_path: permissionGateUrl,
			provider_mode: "mock",
			max_parallel_workers: 2,
			execution_surface: { pph_commit: "pph-v3.5", bundle_sha256: "bundle-v3.5" },
		})({
			recordExecutionSurface: (metadata) => session.appendCustomEntry("personal-pi.execution-surface", metadata),
			getWorkerRoute: () => ({
				cwd,
				command: process.execPath,
				command_args_prefix: [fakeCli, markerPath],
				provider: "fake-provider",
				model: "fake-model",
				thinking: "low",
				active_tools: ["read"],
				worker_status: { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" },
			}),
		});

		await handler({ text: "分别调研以下厂商并汇总同一组指标：\n1. OpenAI\n2. Anthropic" });

		const state = new PersistentStateStore(statePath).read();
		const leafTasks = state.tasks.filter((task) => task.id.startsWith("multi-research:unit-"));
		expect(leafTasks).toHaveLength(2);
		expect(leafTasks.every((task) => task.state === "DONE")).toBe(true);
		expect(state.tasks.find((task) => task.id === "multi-research:fan-in")?.state).toBe("DONE");
		expect(state.graphs).toHaveLength(1);
		expect(state.graphs[0]?.nodes.map((node) => node.task_id)).toEqual(
			expect.arrayContaining(["multi-research", "multi-research:unit-1", "multi-research:unit-2"]),
		);
		const leafDispatches = state.dispatches.filter((dispatch) => dispatch.task_id.startsWith("multi-research:unit-"));
		expect(leafDispatches).toHaveLength(2);
		for (const dispatch of leafDispatches) {
			expect(dispatch.requested_mode).toBe("parallel");
			expect(dispatch.effective_mode).toBe("parallel");
			expect(dispatch.effective_worker_count).toBeGreaterThanOrEqual(2);
			expect(dispatch.overlap_proof_ref).toMatch(/^[a-f0-9]{64}$/);
		}
		const fanInArgs = JSON.parse(readFileSync(markerPath, "utf8")) as string[];
		const fanInPrompt = fanInArgs.at(-1) ?? "";
		for (const leaf of leafTasks) {
			expect(fanInPrompt).not.toContain(`TRANSCRIPT_ONLY_MARKER:${leaf.id}`);
			expect(fanInPrompt).toContain(leaf.id);
		}
		const fanInTrace = state.traces.find((trace) => trace.task_id === "multi-research:fan-in");
		expect(fanInTrace).toBeTruthy();
		const surface = session
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "personal-pi.execution-surface");
		expect(surface?.type === "custom" ? surface.data : undefined).toMatchObject({
			entrypoint: "interactive",
			ingress_bound: true,
			pipeline_bound: true,
			scheduler_enabled: true,
			scheduler_kind: "worker_pool",
		});
		expect(JSON.stringify(session.buildSessionContext().messages)).not.toContain("pph-v3.5");
	});

	test("persists degraded dispatch and fails closed before raw fallback when the worker is unavailable", async () => {
		const cwd = temporaryDirectory();
		initializeGitRepository(cwd);
		const statePath = join(cwd, ".pph", "state.json");
		const handler = createPersonalPiInteractiveIngressFactory({
			state_path: statePath,
			task_id_factory: () => "blocked-task",
			provider_mode: "mock",
		})({
			getWorkerRoute: () => ({
				cwd,
				command: process.execPath,
				command_args_prefix: [],
				provider: "fake-provider",
				model: "fake-model",
				active_tools: [],
				worker_status: {
					worker_capability: "unavailable",
					execution_mode: "root_only",
					delivery_status: "degraded",
				},
			}),
		});
		const rawFallback = vi.fn(async () => ({ summary: "must not run" }));

		await expect(routeInteractiveSubmission(handler, { text: "blocked work" }, rawFallback)).rejects.toThrow();
		expect(rawFallback).not.toHaveBeenCalled();
		const state = new PersistentStateStore(statePath).read();
		expect(state.dispatches).toHaveLength(1);
		expect(state.dispatches[0]?.worker_status.worker_capability).toBe("unavailable");
		expect(state.dispatches[0]?.lease_epoch).toBeUndefined();
		expect(state.runs).toEqual([]);
	});

	test("fails closed before route or state execution when provider mode is omitted", async () => {
		const cwd = temporaryDirectory();
		const statePath = join(cwd, ".pph", "state.json");
		const getWorkerRoute = vi.fn(() => {
			throw new Error("worker route must not be resolved");
		});
		const handler = createPersonalPiInteractiveIngressFactory({
			state_path: statePath,
			task_id_factory: () => "missing-provider-mode",
		})({ getWorkerRoute });
		const rawFallback = vi.fn(async () => ({ summary: "must not run" }));

		await expect(
			routeInteractiveSubmission(handler, { text: "blocked before execution" }, rawFallback),
		).rejects.toThrow("interactive PPH requires an explicit provider_mode (mock|local|real)");
		expect(rawFallback).not.toHaveBeenCalled();
		expect(getWorkerRoute).not.toHaveBeenCalled();
		expect(existsSync(statePath)).toBe(false);
	});
});
