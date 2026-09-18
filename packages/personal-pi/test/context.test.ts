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
	createEmptyPersistentState,
	evaluateContextReadiness,
	MissingContextReferenceError,
	validateContextCompactionReport,
	validateContextManifest,
} from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

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

	test("emits the exact structured schema without copying raw evidence across ten tasks", () => {
		const state = createEmptyPersistentState();
		for (let index = 0; index < 10; index += 1) {
			const task = makeV3Task(`task-${index + 1}`);
			state.tasks.push({ ...task, state: "DONE", audit_log: [] });
			const evidenceId = `evidence-${index + 1}`;
			state.evidence.push({
				id: evidenceId,
				task_id: task.id,
				run_id: `run-${index + 1}`,
				captured_at: "2026-09-19T00:00:00.000Z",
				diff: { files: [], digest: "diff" },
				commands: [],
				stdout: "raw evidence ".repeat(200),
				stderr: "",
				artifacts: [`artifact-${index + 1}`],
				evidence_types: ["worker_result"],
				delivery_evidence_package: {
					baseline_commit: "base",
					actual_diff: { files: [], digest: "diff" },
					task_revision: task.task_revision,
					workspace_snapshot_ref: "snapshot",
					commands_and_exit_codes: [],
					test_output_summary: "bounded",
					artifact_digest: "artifact-digest",
					browser_or_container_verification: [],
					unfinished_items: [],
					provider_mode: "mock",
				},
			});
			state.verifications.push({
				id: `verification-${index + 1}`,
				task_id: task.id,
				evidence_id: evidenceId,
				status: "PASS",
				verification_confidence: "strong",
				task_revision: task.task_revision,
				commit_hash: "sha",
				diff_digest: "diff",
				artifact_digest: "artifact-digest",
				checked_at: "2026-09-19T00:00:00.000Z",
				checks: [],
				reasons: [],
			});
		}
		const report = new ContextCompactionPolicy().buildReport({
			state,
			next_action: "continue",
			git_sha: "abc123",
		});
		const uncompressedEvidence = state.evidence.map((evidence) => evidence.stdout).join("\n");

		expect(Object.keys(report).sort()).toEqual(
			[
				"facts",
				"decisions",
				"completed_tasks",
				"open_tasks",
				"open_risks",
				"verified_evidence",
				"failed_attempts",
				"next_action",
				"git_sha",
				"artifact_refs",
			].sort(),
		);
		expect(validateContextCompactionReport(report).valid).toBe(true);
		expect(report.facts).toEqual([]);
		expect(report.completed_tasks).toHaveLength(10);
		expect(report.verified_evidence).toHaveLength(10);
		expect(JSON.stringify(report).length).toBeLessThan(uncompressedEvidence.length / 20);
		expect(JSON.stringify(report)).not.toContain("raw evidence");
	});

	test("keeps only the latest decision and never promotes uncertain evidence into facts", () => {
		const state = createEmptyPersistentState();
		const task = makeV3Task("task-a");
		state.tasks.push({ ...task, state: "BLOCKED", audit_log: [] });
		state.runs.push({
			id: "run-current",
			task_id: task.id,
			task_revision: task.task_revision,
			attempt: 1,
			worker_id: "worker",
			lease_epoch: 1,
			worker_status: { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" },
			model_identity: {
				requested_model: "model",
				platform_accepted_model: "model",
				observed_runtime_model: "model",
			},
			status: "FAILED",
			started_at: "2026-09-18T09:00:00.000Z",
			ended_at: "2026-09-18T12:00:00.000Z",
			workspace_commit_hash: "current-sha",
		});
		state.decisions.push(
			{
				id: "old",
				decision_type: "migration_plan",
				decision: "use-old-plan",
				reason: "initial assumption",
				inputs: ["task-a"],
				at: "2026-09-18T10:00:00.000Z",
			},
			{
				id: "new",
				decision_type: "migration_plan",
				decision: "use-new-plan",
				reason: "verified correction",
				inputs: ["task-a"],
				at: "2026-09-18T11:00:00.000Z",
			},
		);
		state.handoff_receipts.push({
			task_id: "task-a",
			status: "BLOCKED",
			git_sha: "current-sha",
			acceptance: "UNKNOWN",
			evidence_refs: [],
			unresolved_risks: ["migration safety remains uncertain"],
			next_action: "reverify",
			work_receipt: {
				work_attempted: true,
				effects_count: 0,
				artifacts_created: [],
				state_changed: false,
				no_op: true,
				no_op_reason: "blocked pending verification",
				evidence_refs: [],
			},
			failure: {
				error_summary: "worker_failure; error_fingerprint=deadbeef",
				artifact_refs: ["failure-artifact"],
			},
		});
		state.handoff_bindings["task-a"] = {
			task_id: "task-a",
			task_revision: task.task_revision,
			run_id: "run-current",
			provenance_stage: "pre_verification",
			git_sha: "current-sha",
			work_receipt_digest: "receipt",
			evidence_refs: [],
		};
		const report = new ContextCompactionPolicy().buildReport({
			state,
			task_ids: ["task-a"],
			anchor_task_id: "task-a",
		});

		expect(report.decisions).toEqual(["task-a:migration_plan:use-new-plan"]);
		expect(report.decisions.join(" ")).not.toContain("use-old-plan");
		expect(report.facts).toEqual([]);
		expect(report.open_risks).toEqual(["migration safety remains uncertain"]);
		expect(report.failed_attempts).toEqual([{ error_fingerprint: "deadbeef" }]);
		expect(JSON.stringify(report.failed_attempts)).not.toContain("worker_failure");
		expect(report.verified_evidence).toEqual([]);
		expect(report.artifact_refs).toEqual(["failure-artifact"]);
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
