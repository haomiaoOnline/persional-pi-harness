import { describe, expect, test } from "vitest";
import {
	SESSION_HARD_MAX_ELAPSED_MS,
	SESSION_HARD_MAX_TOOL_CALLS,
	SessionHardLimits,
} from "../src/core/session-hard-limits.ts";

describe("PPH ingress fail-closed session hard limits", () => {
	test("blocks after the fixed tool-call ceiling without configuration", () => {
		const limits = new SessionHardLimits(() => 0);
		for (let index = 0; index < SESSION_HARD_MAX_TOOL_CALLS; index += 1) {
			expect(limits.checkBeforeToolCall()).toEqual({ allowed: true });
		}

		expect(limits.checkBeforeToolCall()).toEqual({
			allowed: false,
			reason: expect.stringContaining(`${SESSION_HARD_MAX_TOOL_CALLS} tool calls`),
		});
	});

	test("blocks once the fixed 45-minute elapsed ceiling is exceeded", () => {
		let now = 10_000;
		const limits = new SessionHardLimits(() => now);
		now += SESSION_HARD_MAX_ELAPSED_MS;
		expect(limits.checkBeforeToolCall()).toEqual({ allowed: true });

		now += 1;
		expect(limits.checkBeforeToolCall()).toEqual({
			allowed: false,
			reason: expect.stringContaining("45 minutes"),
		});
	});
});
