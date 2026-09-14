import { describe, expect, test } from "vitest";
import {
	DEFAULT_BUILTIN_TOOL_SET,
	handleWorkerNotice,
	measureBashReplacement,
	ProgressiveToolExpander,
	reviewToolDesign,
	validateWorkerNotice,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

describe("T10.5/T12.1-T12.3 progressive tools and Worker notices", () => {
	test("keeps the default built-in set narrow and hides extensions for simple tasks", () => {
		const expander = new ProgressiveToolExpander([
			{ id: "browser-search", purpose: "search a browser page", capability_tags: ["browser"], origin: "mcp" },
			{ id: "remote-shell", purpose: "run a remote shell", capability_tags: ["shell"], origin: "remote" },
		]);
		const result = expander.expose(makeV3Task("simple-tools"), { simple_task: true });
		expect(DEFAULT_BUILTIN_TOOL_SET.length).toBeLessThan(20);
		expect(result.tools.map((tool) => tool.id)).toEqual(DEFAULT_BUILTIN_TOOL_SET.map((tool) => tool.id));
		expect(result.registry_hidden_for_simple_task).toBe(true);
	});

	test("adds only capability-matched extensions and puts remote tools last", () => {
		const expander = new ProgressiveToolExpander([
			{ id: "browser-search", purpose: "search a browser page", capability_tags: ["browser"], origin: "mcp" },
			{ id: "browser-local", purpose: "inspect a local browser", capability_tags: ["browser"], origin: "extension" },
			{ id: "remote-shell", purpose: "run a remote shell", capability_tags: ["shell"], origin: "remote" },
		]);
		const result = expander.expose(
			makeV3Task("browser-tools", {
				execution: { ...makeV3Task("browser-tools").execution, capability_tags: ["browser"] },
			}),
		);
		expect(result.tools.map((tool) => tool.id)).toEqual([
			...DEFAULT_BUILTIN_TOOL_SET.map((tool) => tool.id),
			"browser-local",
			"browser-search",
		]);
		expect(result.tools.some((tool) => tool.id === "remote-shell")).toBe(false);
		expect(result.remote_tools_last).toBe(true);
	});

	test("uses Bash only as a fallback when no dedicated capability tool matches", () => {
		const expander = new ProgressiveToolExpander([
			{ id: "shell-extension", purpose: "run a narrow shell task", capability_tags: ["shell"], origin: "extension" },
		]);
		const task = makeV3Task("shell-tools", {
			execution: { ...makeV3Task("shell-tools").execution, capability_tags: ["shell"] },
		});
		expect(expander.expose(task, { include_bash_fallback: true }).tools.some((tool) => tool.id === "Bash")).toBe(
			false,
		);
		const fallback = new ProgressiveToolExpander().expose(task, { include_bash_fallback: true });
		expect(fallback.tools.at(-1)?.id).toBe("Bash");
	});

	test("produces a review checklist and Bash replacement baseline", () => {
		const review = reviewToolDesign([...DEFAULT_BUILTIN_TOOL_SET]);
		expect(review.passed).toBe(true);
		expect(measureBashReplacement(["cat a", "rg x", "git status", "custom-tool"]).replaceable_rate).toBe(0.5);
	});

	test("accepts only structured HANDOFF_READY and makes Controller recheck state and artifact readiness", () => {
		const notice = {
			kind: "HANDOFF_READY" as const,
			handoff_id: "handoff-1",
			task_id: "task-1",
			artifact_digest: "artifact-1",
			producer_task_revision: 2,
		};
		expect(validateWorkerNotice(notice).valid).toBe(true);
		expect(validateWorkerNotice({ ...notice, message: "free-form chat" }).valid).toBe(false);
		const calls: string[] = [];
		const result = handleWorkerNotice(notice, {
			read_persistent_state: (taskId) => calls.push(`state:${taskId}`),
			check_artifact_readiness: (input) => {
				calls.push(`artifact:${input.artifact_digest}`);
				return { ready: true, state: "READY", reasons: [] };
			},
		});
		expect(result).toMatchObject({
			accepted: true,
			wake_controller: true,
			state_rechecked: true,
			artifact_ready: true,
		});
		expect(calls).toEqual(["state:task-1", "artifact:artifact-1"]);
	});
});
