import { describe, expect, test } from "vitest";
import {
	AcceptanceGate,
	AcceptanceGateError,
	buildVerifierInput,
	canUnlockDownstream,
	captureWorkspaceSnapshot,
	createDeliveryEvidencePackage,
	createTaskRecord,
	DEFAULT_VERIFICATION_RECIPES,
	EvidenceCollector,
	PersistentStateStore,
	type ResultContract,
	replayEvidence,
	type TaskContract,
	TaskStateMachine,
	VerificationEngine,
	VerificationRecipeRegistry,
	validateDeliveryEvidencePackage,
	validateVerificationRecipe,
} from "../src/index.ts";

function makeTask(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		id: "verification-task",
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Verification task",
		objective: "Run a deterministic verification",
		requirements: ["Produce evidence"],
		constraints: [],
		scope: { files: ["src/index.ts"] },
		inputs: {},
		data_sources: [],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: ["npm test"] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "medium",
			capability_tags: ["test_runner"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["test result"],
		acceptance_criteria: ["verification passes"],
		verification: {
			strategy: "automated",
			commands: ["npm test"],
			checks: ["exit_code_zero"],
			evidence_required: ["stdout", "test_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P0",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
		...overrides,
	};
}

function evidence(
	task: TaskContract,
	types = ["stdout", "test_result"],
	changedFiles: string[] = ["src/index.ts"],
	providerMode: "mock" | "local" | "real" = "mock",
) {
	const snapshot = captureWorkspaceSnapshot("commit-1", changedFiles, []);
	return new EvidenceCollector().collect({
		task_id: task.id,
		run_id: "run-1",
		changed_files: changedFiles,
		stdout: "ok",
		stderr: "",
		test_result: "14 passed",
		commands: [],
		evidence_types: types,
		delivery_evidence_package: createDeliveryEvidencePackage({
			baseline_commit: "baseline-1",
			task_revision: task.task_revision,
			snapshot,
			changed_files: changedFiles,
			commands: [],
			test_output_summary: "14 passed",
			provider_mode: providerMode,
		}),
	});
}

function acceptedResult(task: TaskContract, noOp = true): ResultContract {
	return {
		task_id: task.id,
		run_id: "run-1",
		worker_id: "worker-1",
		lease_epoch: 1,
		status: "success",
		summary: "green",
		changed_files: [],
		artifacts: [],
		evidence: ["stdout", "test_result"],
		errors: [],
		model_identity: {
			requested_model: "unknown",
			platform_accepted_model: "unknown",
			observed_runtime_model: "unknown",
		},
		work_receipt: {
			work_attempted: true,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: noOp,
			...(noOp ? { no_op_reason: "verification-only no-op" } : {}),
			evidence_refs: [],
		},
	};
}

describe("T4.1 Evidence System", () => {
	test("collects all required evidence fields and can replay offline", () => {
		const task = makeTask();
		const record = new EvidenceCollector().collect({
			task_id: task.id,
			run_id: "run-1",
			changed_files: ["src/index.ts"],
			commands: [{ command: "npm test", exit_code: 0, stdout: "14 passed", stderr: "" }],
			stdout: "14 passed",
			stderr: "",
			test_result: "PASS",
			build_result: "PASS",
			artifacts: ["artifact:1"],
			evidence_types: ["test_report"],
		});
		expect(record.diff.files).toEqual(["src/index.ts"]);
		expect(record.diff.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(replayEvidence(record)).toEqual(record);
	});

	test("freezes the exact v3.4 standardized package and requires explicit provider_mode", () => {
		const task = makeTask();
		const snapshot = captureWorkspaceSnapshot("commit-1", ["src/index.ts"], ["artifact:1"]);
		const packageValue = createDeliveryEvidencePackage({
			baseline_commit: "baseline-commit",
			task_revision: task.task_revision,
			snapshot,
			changed_files: ["src/index.ts"],
			commands: [{ command: "npm test", exit_code: 0, stdout: "large output", stderr: "" }],
			test_output_summary: "14 passed",
			browser_or_container_verification: ["browser_e2e"],
			unfinished_items: [],
			provider_mode: "mock",
		});
		expect(Object.keys(packageValue).sort()).toEqual(
			[
				"baseline_commit",
				"actual_diff",
				"task_revision",
				"workspace_snapshot_ref",
				"commands_and_exit_codes",
				"test_output_summary",
				"artifact_digest",
				"browser_or_container_verification",
				"unfinished_items",
				"provider_mode",
			].sort(),
		);
		expect(packageValue.commands_and_exit_codes).toEqual([{ command: "npm test", exit_code: 0 }]);
		expect(packageValue).not.toHaveProperty("stdout");
		expect(packageValue.provider_mode).toBe("mock");
		expect(validateDeliveryEvidencePackage(packageValue).valid).toBe(true);
		const { provider_mode: _providerMode, ...missingMode } = packageValue;
		expect(validateDeliveryEvidencePackage(missingMode).valid).toBe(false);
		expect(validateDeliveryEvidencePackage({ ...packageValue, provider_mode: "production" }).valid).toBe(false);
		expect(validateDeliveryEvidencePackage({ ...packageValue, extra: true }).valid).toBe(false);
	});
});

describe("T4.2 Verification Engine", () => {
	test("trusts deterministic command evidence instead of Worker claims", async () => {
		const task = makeTask();
		const record = await new VerificationEngine().verify({
			task,
			evidence: evidence(task),
			snapshot: captureWorkspaceSnapshot("commit-1", ["src/index.ts"], []),
			commandRunner: (command) => ({ command, exit_code: 0, stdout: "pass", stderr: "" }),
			workerStatus: "success",
		});
		expect(record.status).toBe("PASS");
		expect(record.verification_confidence).toBe("strong");
	});

	test("reports FAIL when a command fails even if the Worker claims success", async () => {
		const task = makeTask();
		const record = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, ["stdout", "test_result"], []),
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			commandRunner: (command) => ({ command, exit_code: 1, stdout: "", stderr: "assertion failed" }),
			workerStatus: "success",
		});
		expect(record.status).toBe("FAIL");
		expect(record.reasons.join(" ")).toContain("command failed");
	});

	test("does not expose Worker explanation text to the Verifier input", async () => {
		const task = makeTask();
		const workerResult = {
			task_id: task.id,
			run_id: "run-1",
			worker_id: "worker-1",
			lease_epoch: 1,
			status: "success" as const,
			summary: "I think this passes because the hidden scratchpad says so",
			changed_files: [],
			artifacts: [],
			evidence: ["stdout"],
			errors: [],
		};
		const verifierInput = buildVerifierInput({
			task,
			evidence: evidence(task, ["stdout", "test_result"], []),
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			result: workerResult,
		});

		expect(verifierInput.result).not.toHaveProperty("summary");
		expect(JSON.stringify(verifierInput)).not.toContain("hidden scratchpad");
		const record = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, ["stdout", "test_result"], []),
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			result: workerResult,
			commandRunner: (command) => ({ command, exit_code: 1, stdout: "", stderr: "actual failure" }),
		});
		expect(record.status).toBe("FAIL");
	});

	test("reports UNKNOWN when evidence or the verification environment is incomplete", async () => {
		const task = makeTask();
		const legacyEvidence = new EvidenceCollector().collect({ task_id: task.id, run_id: "run-1" });
		const missing = await new VerificationEngine().verify({
			task,
			evidence: legacyEvidence,
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
		});
		expect(missing.status).toBe("UNKNOWN");
		expect(missing.reasons.join(" ")).toContain("delivery evidence package is incomplete");
		const legacyStore = new PersistentStateStore();
		legacyStore.saveEvidence(legacyEvidence);
		legacyStore.saveVerification(missing);
		expect(legacyStore.read().verifications[0]).toMatchObject({
			id: missing.id,
			status: "UNKNOWN",
			evidence_id: legacyEvidence.id,
		});
		const brokenEnvironment = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, ["stdout", "test_result"], []),
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			commandRunner: () => {
				throw new Error("runner unavailable");
			},
		});
		expect(brokenEnvironment.status).toBe("UNKNOWN");
	});

	test("does not unlock a high-risk downstream task with weak verification", async () => {
		const task = makeTask({ verification: { ...makeTask().verification, strength: "weak" } });
		const record = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, ["stdout", "test_result"], []),
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			commandRunner: (command) => ({ command, exit_code: 0, stdout: "pass", stderr: "" }),
		});
		expect(record.status).toBe("PASS");
		expect(record.verification_confidence).toBe("weak");
		expect(canUnlockDownstream(record, "high")).toBe(false);
	});
});

describe("T4.3–T4.4 Acceptance Gate and revision binding", () => {
	test("allows DONE only from VERIFYING with a matching PASS", async () => {
		const task = makeTask();
		let record = createTaskRecord(task);
		const stateMachine = new TaskStateMachine();
		record = stateMachine.transition(record, "READY");
		record = stateMachine.transition(record, "RUNNING");
		record = stateMachine.transition(record, "VERIFYING");
		const snapshot = captureWorkspaceSnapshot("commit-1", ["src/index.ts"], []);
		const canonicalEvidence = evidence(task);
		const verification = await new VerificationEngine().verify({
			task,
			evidence: canonicalEvidence,
			snapshot,
			commandRunner: (command) => ({ command, exit_code: 0, stdout: "pass", stderr: "" }),
		});
		const accepted = new AcceptanceGate().markDone(
			record,
			verification,
			snapshot,
			acceptedResult(task),
			canonicalEvidence,
		);
		expect(accepted.state).toBe("DONE");
	});

	test("rejects stale PASS after a workspace change or task revision change", async () => {
		const task = makeTask();
		let record = createTaskRecord(task);
		const stateMachine = new TaskStateMachine();
		record = stateMachine.transition(record, "READY");
		record = stateMachine.transition(record, "RUNNING");
		record = stateMachine.transition(record, "VERIFYING");
		const snapshot = captureWorkspaceSnapshot("commit-1", [], []);
		const canonicalEvidence = evidence(task, ["stdout", "test_result"], []);
		const verification = await new VerificationEngine().verify({
			task,
			evidence: canonicalEvidence,
			snapshot,
			commandRunner: (command) => ({ command, exit_code: 0, stdout: "pass", stderr: "" }),
		});
		expect(() =>
			new AcceptanceGate().markDone(
				record,
				verification,
				captureWorkspaceSnapshot("commit-2", [], []),
				acceptedResult(task),
				canonicalEvidence,
			),
		).toThrow("invalidated");
		const changedRevision = { ...record, task_revision: 2 };
		expect(() =>
			new AcceptanceGate().markDone(
				changedRevision,
				verification,
				snapshot,
				acceptedResult(task),
				canonicalEvidence,
			),
		).toThrow("stale");
		expect(() =>
			new AcceptanceGate().markDone(
				{ ...record, state: "READY" },
				verification,
				snapshot,
				acceptedResult(task),
				canonicalEvidence,
			),
		).toThrow(AcceptanceGateError);
	});

	test("blocks a successful result with no observable work and accepts an explicit no-op", async () => {
		const task = makeTask();
		let record = createTaskRecord(task);
		const stateMachine = new TaskStateMachine();
		record = stateMachine.transition(record, "READY");
		record = stateMachine.transition(record, "RUNNING");
		record = stateMachine.transition(record, "VERIFYING");
		const snapshot = captureWorkspaceSnapshot("commit-1", [], []);
		const canonicalEvidence = evidence(task, ["stdout", "test_result"], []);
		const verification = await new VerificationEngine().verify({
			task,
			evidence: canonicalEvidence,
			snapshot,
			commandRunner: (command) => ({ command, exit_code: 0, stdout: "pass", stderr: "" }),
		});
		const anomaly = acceptedResult(task, false);
		expect(() => new AcceptanceGate().markDone(record, verification, snapshot, anomaly, canonicalEvidence)).toThrow(
			"work_receipt_anomaly",
		);
		const legalNoOp: ResultContract = {
			...anomaly,
			work_receipt: {
				...(anomaly.work_receipt as NonNullable<ResultContract["work_receipt"]>),
				no_op: true,
				no_op_reason: "没有新的消息",
			},
		};
		expect(new AcceptanceGate().markDone(record, verification, snapshot, legalNoOp, canonicalEvidence).state).toBe(
			"DONE",
		);
	});

	test("never accepts legacy Evidence that lacks the standardized delivery package", () => {
		const task = makeTask();
		let record = createTaskRecord(task);
		const machine = new TaskStateMachine();
		record = machine.transition(record, "READY");
		record = machine.transition(record, "RUNNING");
		record = machine.transition(record, "VERIFYING");
		const snapshot = captureWorkspaceSnapshot("commit-1", [], []);
		const legacyEvidence = new EvidenceCollector().collect({
			task_id: task.id,
			run_id: "run-1",
			changed_files: [],
		});
		const forgedLegacyPass = {
			id: "legacy-pass",
			task_id: task.id,
			evidence_id: legacyEvidence.id,
			status: "PASS" as const,
			verification_confidence: "strong" as const,
			task_revision: task.task_revision,
			commit_hash: snapshot.commit_hash,
			diff_digest: snapshot.diff_digest,
			artifact_digest: snapshot.artifact_digest,
			checked_at: "2026-09-18T00:00:00.000Z",
			checks: [],
			reasons: [],
		};
		expect(() =>
			new AcceptanceGate().markDone(record, forgedLegacyPass, snapshot, acceptedResult(task), legacyEvidence),
		).toThrow("delivery evidence package is incomplete");
	});
});

describe("T4.5 Verification Recipe", () => {
	test("validates both default recipes and enforces the referenced recipe", async () => {
		for (const recipe of DEFAULT_VERIFICATION_RECIPES) expect(validateVerificationRecipe(recipe).valid).toBe(true);
		const registry = new VerificationRecipeRegistry();
		const task = makeTask({
			type: "web_feature",
			verification: {
				strategy: "automated",
				commands: [],
				checks: [],
				evidence_required: [],
				strength: "strong",
				recipe_ref: "web-feature-v1",
			},
		});
		const completeEvidence = evidence(
			task,
			[
				"unit_test",
				"integration_test",
				"browser_e2e",
				"network_trace",
				"screenshot",
				"video",
				"console_log",
				"request_trace",
			],
			[],
		);
		const complete = await new VerificationEngine().verify({
			task,
			evidence: completeEvidence,
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			recipeRegistry: registry,
		});
		expect(complete.status).toBe("PASS");
		const incomplete = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, ["unit_test"], []),
			snapshot: captureWorkspaceSnapshot("commit-1", [], []),
			recipeRegistry: registry,
		});
		expect(incomplete.status).toBe("UNKNOWN");
	});

	test("supports explicit real-only recipes without relabeling mock/local evidence", async () => {
		const registry = new VerificationRecipeRegistry([
			{ id: "real-only", task_type: "cli", required: [], evidence: [], required_provider_mode: "real" },
		]);
		const task = makeTask({
			verification: {
				strategy: "automated",
				commands: [],
				checks: [],
				evidence_required: [],
				strength: "strong",
				recipe_ref: "real-only",
			},
		});
		const snapshot = captureWorkspaceSnapshot("commit-1", [], []);
		const mock = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, [], [], "mock"),
			snapshot,
			recipeRegistry: registry,
		});
		expect(mock.status).toBe("UNKNOWN");
		expect(mock.reasons.join(" ")).toContain("does not satisfy recipe requirement real");
		const real = await new VerificationEngine().verify({
			task,
			evidence: evidence(task, [], [], "real"),
			snapshot,
			recipeRegistry: registry,
		});
		expect(real.status).toBe("PASS");
	});
});
