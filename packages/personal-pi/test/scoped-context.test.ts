import { describe, expect, test } from "vitest";
import { assembleScopedContext } from "../src/index.ts";

describe("T6.2-A scoped context assembly", () => {
	test("applies org then project then directory overrides, including exclusions", () => {
		const result = assembleScopedContext([
			{
				scope: "org",
				entries: [
					{ key: "style", content: "org-style" },
					{ key: "secret-policy", content: "do-not-expose" },
				],
			},
			{
				scope: "project",
				entries: [
					{ key: "style", content: "project-style" },
					{ key: "secret-policy", excluded: true },
				],
			},
			{ scope: "directory", entries: [{ key: "style", content: "directory-style" }] },
		]);

		expect(result.status).toBe("READY");
		expect(result.items).toEqual([
			{ key: "style", content: "directory-style", excluded: false, source_scope: "directory" },
		]);
		expect(result.excluded_keys).toEqual(["secret-policy"]);
		expect(result.source_by_key).toMatchObject({ style: "directory", "secret-policy": "project" });
	});

	test("blocks same-level contradictions instead of guessing", () => {
		const result = assembleScopedContext([
			{ scope: "project", entries: [{ key: "instructions", content: "one" }] },
			{ scope: "project", entries: [{ key: "instructions", content: "two" }] },
		]);
		expect(result.status).toBe("BLOCKED");
		expect(result.conflicts).toEqual(["project:instructions"]);
		expect(result.items).toEqual([]);
	});

	test("keeps a legacy-only directory exception explicit", () => {
		const standard = assembleScopedContext([
			{ scope: "org", entries: [{ key: "parser", content: "modern" }] },
			{
				scope: "directory",
				directory_kind: "standard",
				entries: [{ key: "parser", content: "legacy", legacy_only: true }],
			},
		]);
		const legacy = assembleScopedContext([
			{ scope: "org", entries: [{ key: "parser", content: "modern" }] },
			{
				scope: "directory",
				directory_kind: "legacy",
				entries: [{ key: "parser", content: "legacy", legacy_only: true }],
			},
		]);
		expect(standard.items[0]?.content).toBe("modern");
		expect(legacy.items[0]?.content).toBe("legacy");
	});
});
