import { describe, expect, test } from "vitest";
import { PermissionPhaseError, PhasedPermissionController } from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

function task() {
	return makeV3Task("permission-phase", {
		permissions: {
			filesystem: { read: ["."], write: ["tmp"] },
			shell: { allowed: ["cat", "node"] },
			network: "deny",
			credentials: "deny",
		},
	});
}

describe("T3.2-A phased permission escalation", () => {
	test("rejects a write in Explore, keeps it retryable, then admits the same declared write in Act", () => {
		const controller = new PhasedPermissionController(task());
		const denied = controller.request({ filesystem: { write: ["tmp/output.txt"] } });

		expect(controller.phase()).toBe("exploring");
		expect(denied.allowed).toBe(false);
		expect(denied.retryable_after_phase_advance).toBe(true);
		expect(denied.reasons[0]).toContain("requires acting");

		controller.advanceTo("planning");
		expect(
			controller.request({ filesystem: { read: ["tmp/output.txt"] }, shell: ["cat tmp/output.txt"] }).allowed,
		).toBe(true);
		controller.advanceTo("acting");
		const admitted = controller.request({ filesystem: { write: ["tmp/output.txt"] }, shell: ["node verify.mjs"] });
		expect(admitted).toMatchObject({ phase: "acting", allowed: true, retryable_after_phase_advance: false });
	});

	test("uses a deterministic acting fast path for simple tasks but never exceeds the Task Contract", () => {
		const controller = new PhasedPermissionController(task(), { simple_task: true });
		expect(controller.phase()).toBe("acting");
		expect(controller.request({ filesystem: { write: ["tmp/fast.txt"] } }).allowed).toBe(true);
		const outside = controller.request({ filesystem: { write: ["private/key.txt"] } });
		expect(outside.allowed).toBe(false);
		expect(outside.reasons.join(" ")).toContain("outside scope");
	});

	test("does not allow skipping or reversing phases", () => {
		const controller = new PhasedPermissionController(task());
		expect(() => controller.advanceTo("acting")).toThrow(PermissionPhaseError);
		controller.advanceTo("planning");
		controller.advanceTo("acting");
		expect(() => controller.advanceTo("planning")).toThrow(PermissionPhaseError);
	});
});
