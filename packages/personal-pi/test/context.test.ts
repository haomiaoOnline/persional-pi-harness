import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ContextBudgetExceededError,
	ContextCompactionPolicy,
	type ContextManifest,
	ContextManifestError,
	ContextResolver,
	ContextStore,
	contextSourceLabel,
	evaluateContextReadiness,
	MissingContextReferenceError,
	validateContextManifest,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "personal-pi-context-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
	}
});

describe("T6.1 content-addressed context store", () => {
	test("stores source content by digest and detects a changed source", () => {
		const directory = temporaryDirectory();
		const source = join(directory, "requirements.md");
		writeFileSync(source, "first version", "utf8");
		const store = new ContextStore(join(directory, "objects"));
		const first = store.putSource(source);
		writeFileSync(source, "second version", "utf8");
		const second = store.putSource(source);

		expect(second.digest).not.toBe(first.digest);
		expect(store.get(first.digest)?.content).toBe("first version");
		expect(store.get(second.digest)?.content).toBe("second version");
		expect(contextSourceLabel(first)).toBe("requirements.md");
	});

	test("reports an integrity miss after an object is corrupted", () => {
		const directory = temporaryDirectory();
		const store = new ContextStore(directory);
		const reference = store.put("immutable facts");
		writeFileSync(join(directory, reference.digest), "tampered", "utf8");

		// The in-memory copy is authoritative for this live process, so a fresh
		// store represents the controller restart that must re-check the object.
		const restarted = new ContextStore(directory);
		expect(restarted.get(reference.digest)).toBeUndefined();
		expect(restarted.stats().integrity_misses).toBe(1);
	});
});

describe("T6.2 context manifest and resolver", () => {
	test("rejects overlapping required, optional, and excluded references", () => {
		const manifest = { required: ["a"], optional: ["a"], excluded: [], budget: { max_input_tokens: 20 } };
		const validation = validateContextManifest(manifest);

		expect(validation.valid).toBe(false);
		expect(validation.errors.join(" ")).toContain("overlapping");
	});

	test("fails closed for a missing required reference", () => {
		const resolver = new ContextResolver(new ContextStore());
		const manifest: ContextManifest = {
			required: ["missing"],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 20 },
		};

		expect(() => resolver.resolve(manifest)).toThrow(MissingContextReferenceError);
		expect(evaluateContextReadiness(manifest, resolver)).toEqual({
			ready: false,
			state: "NOT_READY",
			reasons: ["context reference not found or failed hash check: missing"],
		});
	});

	test("keeps a 100K-context project under budget and omits optional context when full", () => {
		const store = new ContextStore();
		const required = store.put("a".repeat(100_000));
		const optional = store.put("optional context");
		const resolver = new ContextResolver(store);
		const manifest: ContextManifest = {
			required: [required.digest],
			optional: [optional.digest],
			excluded: [],
			budget: { max_input_tokens: 12 },
		};

		const first = resolver.resolve(manifest);
		const second = resolver.resolve(manifest);

		expect(first.total_tokens).toBeLessThanOrEqual(12);
		expect(first.items[0]?.digest).toBe(required.digest);
		expect(first.omitted_optional).toEqual([optional.digest]);
		expect(second.cache_hit).toBe(true);
		expect(resolver.stats()).toEqual({ hits: 1, misses: 1 });
	});

	test("reuses one resolved context across three task requests and a retry", () => {
		const store = new ContextStore();
		const shared = store.put("shared project facts");
		const resolver = new ContextResolver(store);
		const manifest: ContextManifest = {
			required: [shared.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 20 },
		};

		const results = [
			resolver.resolve(manifest),
			resolver.resolve(manifest),
			resolver.resolve(manifest),
			resolver.resolve(manifest),
		];

		expect(results.map((result) => result.cache_hit)).toEqual([false, true, true, true]);
		expect(resolver.stats()).toEqual({ hits: 3, misses: 1 });
	});

	test("blocks a manifest with more required references than its token budget", () => {
		const store = new ContextStore();
		const first = store.put("one");
		const second = store.put("two");
		const resolver = new ContextResolver(store);
		const manifest: ContextManifest = {
			required: [first.digest, second.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 1 },
		};

		expect(() => resolver.resolve(manifest)).toThrow(ContextBudgetExceededError);
	});

	test("keeps held-out evaluation context out of the resolver", () => {
		const store = new ContextStore();
		const heldOut = store.put("held-out answer", { held_out: true });
		const resolver = new ContextResolver(store);
		const manifest: ContextManifest = {
			required: [heldOut.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 20 },
		};

		expect(() => resolver.resolve(manifest, { evaluation: true })).toThrow(MissingContextReferenceError);
	});

	test("does not expose raw evidence text in a ten-task compact summary", () => {
		const summaries = Array.from({ length: 10 }, (_, index) => ({
			task_id: `task-${index + 1}`,
			status: "PASS" as const,
			summary: "verification passed",
			evidence_ref: `evidence-${index + 1}`,
		}));
		const report = new ContextCompactionPolicy().buildReport(summaries);
		const uncompressedEvidence = summaries
			.map((summary) => `${summary.task_id}: ${"raw evidence ".repeat(200)}${summary.evidence_ref}`)
			.join("\n");

		expect(report).toContain("task-1: PASS — verification passed [evidence:evidence-1]");
		expect(report.split("\n")).toHaveLength(10);
		expect(report.length).toBeLessThan(uncompressedEvidence.length / 20);
		expect(report).not.toContain("secret");
	});
});

describe("T6.3 cache recovery", () => {
	test("can disable a stale cache and rebuild a fresh projection", () => {
		const store = new ContextStore();
		const reference = store.put("stable content");
		const resolver = new ContextResolver(store);
		const manifest: ContextManifest = {
			required: [reference.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 20 },
		};

		resolver.resolve(manifest);
		const rebuilt = resolver.resolve(manifest, { reuse_cache: false });

		expect(rebuilt.cache_hit).toBe(false);
		expect(rebuilt.text).toBe("stable content");
		expect(resolver.stats()).toEqual({ hits: 0, misses: 2 });
	});
});

describe("T6.4 context manifest errors", () => {
	test("raises a typed error for a structurally invalid manifest", () => {
		const resolver = new ContextResolver(new ContextStore());

		expect(() =>
			resolver.resolve({ required: [], optional: [], excluded: [], budget: { max_input_tokens: 0 } }),
		).toThrow(ContextManifestError);
	});
});
