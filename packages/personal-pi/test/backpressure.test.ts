import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ArtifactStore, ExecutionBackpressureController, ToolGateway } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T12.6-A domain/provider backpressure", () => {
	test("queues only the pressured domain while another READY domain can continue", () => {
		const controller = new ExecutionBackpressureController({ base_backoff_ms: 100, max_backoff_ms: 1_000 });
		const signal = controller.report({
			scope: "domain",
			key: "api.example.com",
			status: 429,
			retry_after_ms: 500,
			at: 1_000,
		});
		expect(signal).toMatchObject({ action: "QUEUE", wait_ms: 500 });
		expect(controller.admit({ scope: "domain", key: "api.example.com" }, 1_100)).toMatchObject({
			action: "QUEUE",
			wait_ms: 400,
		});
		expect(controller.admit({ scope: "domain", key: "other.example.com" }, 1_100)).toMatchObject({
			action: "ALLOW",
			wait_ms: 0,
		});
	});

	test("ToolGateway returns a durable queued envelope without invoking sleep or the runner", async () => {
		const root = mkdtempSync(join(tmpdir(), "personal-pi-backpressure-"));
		temporaryDirectories.push(root);
		const now = 1_000;
		const controller = new ExecutionBackpressureController({ base_backoff_ms: 100, max_backoff_ms: 1_000 });
		controller.report({ scope: "domain", key: "limited.example.com", status: 429, retry_after_ms: 500, at: now });
		const gateway = new ToolGateway({
			artifact_store: new ArtifactStore(root),
			backpressure_controller: controller,
			clock_ms: () => now,
		});
		let calls = 0;
		const queued = await gateway.executeCommand({
			command: "fetch limited",
			task_id: "limited-task",
			task_revision: 1,
			backpressure_key: { scope: "domain", key: "limited.example.com" },
			runner: () => {
				calls += 1;
				return { command: "fetch limited", exit_code: 0, stdout: "ok", stderr: "" };
			},
		});
		expect(calls).toBe(0);
		expect(queued.envelope.status).toBe("blocked");
		expect(queued.envelope.stderr_summary).toContain("backpressure queued");
		expect(queued.envelope.stderr_summary).toContain("wait_ms=500");

		const ready = await gateway.executeCommand({
			command: "fetch other",
			task_id: "other-task",
			task_revision: 1,
			backpressure_key: { scope: "domain", key: "other.example.com" },
			runner: () => {
				calls += 1;
				return { command: "fetch other", exit_code: 0, stdout: "ok", stderr: "" };
			},
		});
		expect(calls).toBe(1);
		expect(ready.envelope.status).toBe("success");
	});
});
