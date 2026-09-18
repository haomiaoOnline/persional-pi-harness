import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
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
const result = JSON.stringify({
  status: "success",
  summary: "deterministic child worker completed",
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
		const handler = createPersonalPiInteractiveIngressFactory({
			state_path: statePath,
			task_id_factory: () => "interactive-task-1",
			permission_gate_path: permissionGateUrl,
			provider_mode: "mock",
		})({
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
