import { describe, expect, test } from "vitest";
import { CommandRiskClassifier, type DeterministicLifecycleHook, LifecycleHookManager } from "../src/index.ts";

const tool = {
	name: "Bash",
	command: "npm run check",
	risk: new CommandRiskClassifier().classify("npm run check").risk,
} as const;

describe("T4.2-B deterministic lifecycle hooks", () => {
	test("runs deterministic start/cwd hooks and records scoped-rule reload evidence", async () => {
		const calls: string[] = [];
		const manager = new LifecycleHookManager({
			reload_scoped_rules: (cwd) => {
				calls.push(`reload:${cwd}`);
				return ["org", "project"];
			},
			hooks: [
				{
					id: "start-check",
					event: "on_start",
					kind: "static_check",
					run: () => {
						calls.push("start");
						return undefined;
					},
				},
			],
		});

		expect((await manager.run("on_start", { task_id: "hook-task" })).allowed).toBe(true);
		const cwd = await manager.run("on_cwd_change", { task_id: "hook-task", cwd: "/repo/legacy" });
		expect(calls).toEqual(["start", "reload:/repo/legacy"]);
		expect(cwd.evidence).toContain("hook:cwd-reloaded:2");
	});

	test("pre_tool_use failure blocks only the current tool call", async () => {
		const manager = new LifecycleHookManager({
			hooks: [
				{
					id: "static-lint",
					event: "pre_tool_use",
					kind: "static_check",
					run: () => ({ passed: false, detail: "command is not allowed" }),
				},
			],
		});
		const result = await manager.run("pre_tool_use", { task_id: "hook-task", tool });
		expect(result.allowed).toBe(false);
		expect(result.blocked_tool_call).toBe(true);
		expect(result.failures.join(" ")).toContain("command is not allowed");
		expect(result.evidence).toContain("hook:static-lint:failed");
	});

	test("missing post-tool checker warns and emits Evidence without crashing the Run", async () => {
		const result = await new LifecycleHookManager().run("post_tool_use", {
			task_id: "hook-task",
			tool,
			code_changed: true,
			changed_files: ["src/index.ts"],
		});
		expect(result.allowed).toBe(true);
		expect(result.warnings[0]).toContain("checker is missing");
		expect(result.evidence).toContain("hook-checker-missing:post_tool_use");
	});

	test("rejects an LLM hook kind at registration time", () => {
		const manager = new LifecycleHookManager();
		const hook = {
			id: "model-hook",
			event: "on_start",
			kind: "llm",
			run: () => undefined,
		} as unknown as DeterministicLifecycleHook;
		expect(() => manager.register(hook)).toThrow("only deterministic");
	});
});
