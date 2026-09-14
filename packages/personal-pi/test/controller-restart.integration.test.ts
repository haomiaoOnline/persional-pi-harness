import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { LeaseManager, PersistentStateStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];
const controllerScript = fileURLToPath(new URL("../scripts/controller-process.mjs", import.meta.url));

function waitForMarker(path: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 5000;
		const poll = () => {
			if (existsSync(path)) {
				try {
					resolve(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
				} catch (error) {
					reject(error);
				}
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`controller marker was not created: ${path}`));
				return;
			}
			setTimeout(poll, 25);
		};
		poll();
	});
}

function startController(mode: "start" | "inspect", statePath: string, markerPath: string) {
	return spawn(process.execPath, ["--experimental-strip-types", controllerScript, mode, statePath, markerPath], {
		cwd: dirname(controllerScript),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T5.3-T5.5 controller restart and recovery", () => {
	test("persists Run, Lease, Loop Budget, Effect Journal, and Snapshot across SIGKILL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-controller-restart-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const startMarker = join(directory, "start.json");
		const inspectMarker = join(directory, "inspect.json");
		const controller = startController("start", statePath, startMarker);
		const started = await waitForMarker(startMarker);
		const pid = started.pid as number;
		expect(pid).toBe(controller.pid);
		expect(started.run_id).toEqual(expect.any(String));
		const controllerExit = once(controller, "exit");
		controller.kill("SIGKILL");
		await controllerExit;

		const inspected = startController("inspect", statePath, inspectMarker);
		const inspectedExit = once(inspected, "exit");
		const inspection = await waitForMarker(inspectMarker);
		const [closeCode] = (await inspectedExit) as [number | null];
		expect(closeCode).toBe(0);

		const before = inspection.before as { runs: Array<{ status: string }>; tasks: Array<{ state: string }> };
		const after = inspection.after as {
			runs: Array<{ status: string }>;
			tasks: Array<{ state: string }>;
			loop_usage: Record<string, { attempts: number }>;
		};
		expect(before.runs[0]?.status).toBe("RUNNING");
		expect(before.tasks[0]?.state).toBe("RUNNING");
		expect(after.runs[0]?.status).toBe("CRASHED");
		expect(after.tasks[0]?.state).toBe("BLOCKED");

		const oldLease = inspection.oldLease as { lease_epoch: number; worker_id: string };
		expect(oldLease.lease_epoch).toBe(1);
		expect(inspection.staleBefore).toEqual({ accepted: true, reason: "current" });
		expect(inspection.staleAfter).toEqual({ accepted: false, reason: "unknown_lease" });
		expect((inspection.effect as { status: string }).status).toBe("committed");
		expect(inspection.snapshot).toEqual({ id: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(inspection.restored_task_state).toBe("RUNNING");

		expect(after.loop_usage).toBeDefined();
		const state = new PersistentStateStore(statePath).read();
		expect(state.loop_usage["controller-restart-task"]?.attempts).toBe(1);
		expect(
			new LeaseManager(new PersistentStateStore(statePath)).currentLease("controller-restart-task"),
		).toBeUndefined();
		expect((inspection.reconstruction as { snapshot_ids: string[] }).snapshot_ids).toHaveLength(1);
	}, 30000);
});
