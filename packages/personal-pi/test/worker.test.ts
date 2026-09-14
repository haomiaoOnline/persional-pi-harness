import { describe, expect, test } from "vitest";
import {
	createProtocolEnvelope,
	createWorkReceipt,
	DEFAULT_ROLE_PROFILES,
	EffectJournal,
	MissingIdempotencyKeyError,
	PiWorker,
	type ResultContract,
	requireIdempotencyKey,
	type TaskContract,
	validateBatchResultEnvelope,
	validateResultContract,
} from "../src/index.ts";

function makeTask(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		id: "worker-task",
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Worker task",
		objective: "Run a bounded operation",
		requirements: ["Return a result"],
		constraints: [],
		scope: { files: ["src/index.ts"] },
		inputs: {},
		data_sources: [],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "medium",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["result"],
		acceptance_criteria: ["result is valid"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["result_valid"],
			evidence_required: ["stdout"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
		...overrides,
	};
}

function requestFor(task: TaskContract, workerId = "pi-1") {
	return {
		task,
		protocol: createProtocolEnvelope(task, 1),
		run_id: "run-1",
		role_profile: task.role_profile_ref
			? DEFAULT_ROLE_PROFILES.find((role) => role.id === task.role_profile_ref)
			: undefined,
		requested_actions: [],
		workerId,
	};
}

function result(status: ResultContract["status"]): ResultContract {
	return {
		task_id: "task-1",
		run_id: "run-1",
		worker_id: "worker-1",
		lease_epoch: 1,
		status,
		summary: status,
		changed_files: [],
		artifacts: [],
		evidence: ["stdout"],
		errors: status === "failure" ? ["failed"] : [],
	};
}

describe("T3.3 Result Contract", () => {
	test.each(["success", "failure", "timeout", "INSUFFICIENT_CONTEXT"] as const)("accepts %s results", (status) => {
		const candidate = result(status);
		if (status === "INSUFFICIENT_CONTEXT") candidate.requested_context = ["context:api-contract"];
		expect(validateResultContract(candidate).valid).toBe(true);
	});

	test("requires a reason for an explicit no-op receipt", () => {
		const candidate = result("success");
		candidate.work_receipt = { ...createWorkReceipt([], [], ["stdout"]), no_op: true };
		expect(validateResultContract(candidate).valid).toBe(false);
		candidate.work_receipt.no_op_reason = "no new work was available";
		expect(validateResultContract(candidate).valid).toBe(true);
	});

	test("accepts the BatchResult envelope without collapsing child results", () => {
		const envelope = {
			batch_id: "batch-1",
			worker_id: "worker-1",
			lease_epoch: 1,
			results: [
				{ task_id: "a", status: "success", changed_files: [], artifacts: [], evidence: ["test"], errors: [] },
				{
					task_id: "b",
					status: "INSUFFICIENT_CONTEXT",
					changed_files: [],
					artifacts: [],
					evidence: [],
					errors: [],
					requested_context: ["ref-1"],
				},
			],
		};
		expect(validateBatchResultEnvelope(envelope).valid).toBe(true);
	});
});

describe("T3.1–T3.2 Worker Adapter and PI Worker", () => {
	test("executes a valid task and injects a Role Profile only as an explicit input", async () => {
		let observedPromptObjective = "";
		const role = DEFAULT_ROLE_PROFILES[0];
		const task = makeTask({ role_profile_ref: role.id });
		const worker = new PiWorker("pi-1", ({ prompt, role_profile }) => {
			observedPromptObjective = prompt.objective;
			expect(role_profile?.id).toBe(role.id);
			return { status: "success", summary: "completed", evidence: ["test"] };
		});
		const request = requestFor(task);
		const output = await worker.execute({ ...request, protocol: createProtocolEnvelope(task, 1) });
		expect(output).toMatchObject({ task_id: task.id, worker_id: "pi-1", status: "success", lease_epoch: 1 });
		expect(observedPromptObjective).toBe(task.objective);
	});

	test("returns INSUFFICIENT_CONTEXT without treating it as failure", async () => {
		const task = makeTask();
		const worker = new PiWorker("pi-1", () => ({
			status: "INSUFFICIENT_CONTEXT",
			summary: "need API contract",
			requested_context: ["api"],
		}));
		const output = await worker.execute(requestFor(task));
		expect(output.status).toBe("INSUFFICIENT_CONTEXT");
		expect(output.requested_context).toEqual(["api"]);
	});

	test("rejects a prohibited action before the executor runs", async () => {
		let called = false;
		const role = DEFAULT_ROLE_PROFILES[0];
		const task = makeTask({ role_profile_ref: role.id });
		const worker = new PiWorker("pi-1", () => {
			called = true;
			return { status: "success", summary: "should not run" };
		});
		const output = await worker.execute({ ...requestFor(task), requested_actions: ["production_deploy"] });
		expect(output.status).toBe("failure");
		expect(output.summary).toContain("DENIED");
		expect(called).toBe(false);
	});

	test("converts missing roles, malformed output, and thrown errors to valid failure results", async () => {
		const task = makeTask({ role_profile_ref: "qa" });
		const missingRole = new PiWorker("pi-1", () => ({ status: "success", summary: "no" }));
		expect((await missingRole.execute({ ...requestFor(task), role_profile: undefined })).status).toBe("failure");

		const malformed = new PiWorker("pi-1", () => ({ status: "invalid" as never, summary: "bad" }));
		const malformedResult = await malformed.execute({
			...requestFor(makeTask()),
			protocol: createProtocolEnvelope(makeTask(), 1),
		});
		expect(malformedResult.summary).toContain("worker returned malformed result");

		const throwing = new PiWorker("pi-1", () => {
			throw new Error("executor exploded");
		});
		const throwingResult = await throwing.execute(requestFor(makeTask()));
		expect(throwingResult.status).toBe("failure");
		expect(throwingResult.errors).toEqual(["executor exploded"]);
	});
});

describe("T3.4 Effect Journal", () => {
	test("does not repeat a committed effect after a retry", async () => {
		const journal = new EffectJournal();
		let sent = 0;
		const first = await journal.run("mail-1", "email:owner", () => {
			sent += 1;
		});
		const second = await journal.run("mail-1", "email:owner", () => {
			sent += 1;
		});
		expect(sent).toBe(1);
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(journal.get("mail-1")?.status).toBe("committed");
	});

	test("serializes concurrent calls that carry the same idempotency key", async () => {
		const journal = new EffectJournal();
		let sent = 0;
		const action = async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			sent += 1;
		};
		const [first, second] = await Promise.all([
			journal.run("mail-concurrent", "email:owner", action),
			journal.run("mail-concurrent", "email:owner", action),
		]);
		expect(sent).toBe(1);
		expect(first.committed).toBe(true);
		expect(second.reused).toBe(true);
	});

	test("requires an idempotency key for external effects and keeps failed records", async () => {
		const task = makeTask();
		expect(() => requireIdempotencyKey(task)).toThrow(MissingIdempotencyKeyError);
		const journal = new EffectJournal();
		await expect(journal.run("effect-1", "external", () => Promise.reject(new Error("network")))).rejects.toThrow(
			"network",
		);
		expect(journal.get("effect-1")?.status).toBe("failed");
	});
});
