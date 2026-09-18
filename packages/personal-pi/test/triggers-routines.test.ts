import { describe, expect, test } from "vitest";
import {
	captureWorkspaceSnapshot,
	createPlanApproval,
	matchesLocalCron,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	ReferenceArchitecturePlaybook,
	RoutineCapture,
	RoutineCaptureError,
	type TaskContract,
	TriggerGateway,
} from "../src/index.ts";

const AVAILABLE_WORKER_STATUS = {
	worker_capability: "available" as const,
	execution_mode: "normal" as const,
	delivery_status: "normal" as const,
};
const UNKNOWN_MODEL_IDENTITY = {
	requested_model: "unknown",
	platform_accepted_model: "unknown",
	observed_runtime_model: "unknown",
};

function makeTask(id: string, topic = "daily summary"): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Generate a summary",
		objective: "Generate a verified summary",
		requirements: ["Use the requested topic"],
		constraints: [],
		scope: { files: ["docs/summary.md"] },
		inputs: { topic },
		data_sources: ["local repository"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "cheap",
			reasoning_depth: "low",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["summary"],
		acceptance_criteria: ["summary is verified"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: {
			max_attempts: 2,
			max_model_calls: 2,
			max_tool_calls: 4,
			max_handoffs: 1,
			max_elapsed_ms: 60000,
			max_input_tokens: 4000,
			max_output_tokens: 4000,
			max_cost_usd: 1,
			max_state_growth_bytes: 10000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

function pipelineOptions(task: TaskContract) {
	const assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "template",
		testability: "automated",
		business_viability: "internal",
		confidence: 0.9,
		open_risks: [],
		playbook_refs: ["summary-cli"],
	};
	return {
		plan_assessment: assessment,
		plan_checklist: {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		},
		plan_approval: createPlanApproval(assessment, "owner"),
		playbook: new ReferenceArchitecturePlaybook([
			{ id: "summary-cli", task_types: [task.type], clauses: ["verified summary"] },
		]),
	};
}

function legalNoOpReceipt() {
	return {
		work_attempted: true,
		effects_count: 0,
		artifacts_created: [],
		state_changed: false,
		no_op: true,
		no_op_reason: "scheduled check found no new state to change",
		evidence_refs: ["worker_result"],
	};
}

function requirement() {
	return {
		user: "owner",
		data_sources: ["repository"],
		permission_location: ["contract"],
		delivery: "verified summary",
		acceptance: ["summary is independently verified"],
		constraints: ["local only"],
		unknowns: [],
		sustainability: ["reusable"],
		non_functional: ["deterministic"],
		commercialization: ["internal"],
	};
}

describe("T7.3 Trigger Gateway", () => {
	test("creates a Task Contract from a webhook once and rejects duplicate delivery", () => {
		const store = new PersistentStateStore();
		const gateway = new TriggerGateway((contract) => store.createTask(contract));
		const event = { source: "local-webhook", event_id: "evt-1", payload: { severity: "info" } } as const;
		const factory = () => makeTask("webhook-task");

		const first = gateway.createFromWebhook(event, factory, (payload) => {
			return (
				typeof payload === "object" && payload !== null && !Array.isArray(payload) && payload.severity === "info"
			);
		});
		const duplicate = gateway.createFromWebhook(event, factory);

		expect(first.created).toBe(true);
		expect(first.task?.id).toBe("webhook-task");
		expect(duplicate.created).toBe(false);
		expect(duplicate.reason).toContain("duplicate");
		expect(store.listTasks()).toHaveLength(1);
	});

	test("matches a local cron trigger and records task-creation failure as an alert", () => {
		const at = new Date(2026, 8, 13, 8, 0, 0);
		expect(matchesLocalCron("0 8 * * *", at)).toBe(true);
		expect(matchesLocalCron("0 9 * * *", at)).toBe(false);
		const gateway = new TriggerGateway(() => {
			throw new Error("invalid task contract");
		});
		const result = gateway.createFromSchedule({ id: "daily-summary", cron: "0 8 * * *" }, at, () =>
			makeTask("never-persisted"),
		);
		const duplicate = gateway.createFromSchedule({ id: "daily-summary", cron: "0 8 * * *" }, at, () =>
			makeTask("never-persisted"),
		);

		expect(result.created).toBe(false);
		expect(result.reason).toContain("task creation failed");
		expect(duplicate.reason).toContain("duplicate");
		expect(gateway.alerts()).toHaveLength(1);
	});

	test("passes a scheduled task into the normal DoR-to-Verification pipeline", async () => {
		const store = new PersistentStateStore();
		const gateway = new TriggerGateway((contract) => store.createTask(contract));
		const task = makeTask("scheduled-task");
		const at = new Date(2026, 8, 13, 8, 0, 0);
		const trigger = gateway.createFromSchedule({ id: "daily-summary", cron: "0 8 * * *" }, at, () => task);
		const execution = await new PersonalPiPipeline({ state_store: store }).execute({
			...pipelineOptions(task),
			requirement: requirement(),
			task,
			existing_task: trigger.task,
			worker: new PiWorker("pi-scheduled", () => ({
				status: "success",
				summary: "scheduled result passed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("scheduled-commit", [], []),
		});

		expect(trigger.created).toBe(true);
		expect(execution.task.state).toBe("DONE");
		expect(store.listTasks()).toHaveLength(1);
	});
});

describe("T7.4 Demonstration-based Routine Capture", () => {
	test("captures a human-approved successful Run and reuses it for a new task", async () => {
		const store = new PersistentStateStore();
		const pipeline = new PersonalPiPipeline({ state_store: store });
		const task = makeTask("routine-source", "first topic");
		const execution = await pipeline.execute({
			...pipelineOptions(task),
			requirement: requirement(),
			task,
			worker: new PiWorker("pi-routine", () => ({
				status: "success",
				summary: "source summary passed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("routine-commit", [], []),
		});
		const playbook = new ReferenceArchitecturePlaybook();
		const capture = new RoutineCapture(playbook);
		const template = capture.capture({
			task,
			run: execution.run,
			result: execution.result,
			evidence: execution.evidence,
			verification: execution.verification,
			human_approved: true,
			parameter_paths: ["title", "objective", "inputs.topic"],
			approved_at: "2026-09-13T08:00:00.000Z",
		});
		const reused = capture.reuse(template.id, {
			task_id: "routine-reuse",
			title: "Generate a weekly summary",
			objective: "Generate a verified weekly summary",
			topic: "weekly topic",
		});
		const second = await pipeline.execute({
			...pipelineOptions(reused),
			requirement: requirement(),
			task: reused,
			worker: new PiWorker("pi-routine-2", () => ({
				status: "success",
				summary: "reused routine passed",
				evidence: ["worker_result"],
				work_receipt: legalNoOpReceipt(),
			})),
			worker_status: AVAILABLE_WORKER_STATUS,
			snapshot: captureWorkspaceSnapshot("routine-commit", [], []),
		});

		expect(template.parameters.map((parameter) => parameter.name)).toEqual(["title", "objective", "topic"]);
		expect(playbook.find("cli")).toHaveLength(1);
		expect(reused.inputs.topic).toBe("weekly topic");
		expect(second.task.state).toBe("DONE");
	});

	test("requires human approval and keeps reuse failures in a regression list", async () => {
		const task = makeTask("routine-unapproved");
		const capture = new RoutineCapture(new ReferenceArchitecturePlaybook());
		const fakeRun = {
			id: "run",
			task_id: task.id,
			attempt: 1,
			worker_id: "pi",
			lease_epoch: 1,
			worker_status: AVAILABLE_WORKER_STATUS,
			model_identity: UNKNOWN_MODEL_IDENTITY,
			status: "SUCCEEDED" as const,
			started_at: "now",
		};
		const fakeResult = {
			task_id: task.id,
			run_id: fakeRun.id,
			worker_id: "pi",
			lease_epoch: 1,
			status: "success" as const,
			summary: "ok",
			changed_files: [],
			artifacts: [],
			evidence: ["worker_result"],
			errors: [],
			model_identity: UNKNOWN_MODEL_IDENTITY,
		};
		const fakeEvidence = {
			id: "evidence",
			task_id: task.id,
			run_id: fakeRun.id,
			captured_at: "now",
			diff: { files: [], digest: "digest" },
			commands: [],
			stdout: "ok",
			stderr: "",
			artifacts: [],
			evidence_types: ["worker_result"],
		};
		const fakeVerification = {
			id: "verification",
			task_id: task.id,
			status: "PASS" as const,
			verification_confidence: "strong" as const,
			task_revision: task.task_revision,
			commit_hash: "commit",
			diff_digest: "digest",
			artifact_digest: "artifact",
			checked_at: "now",
			checks: [],
			reasons: [],
		};

		expect(() =>
			capture.capture({
				task,
				run: fakeRun,
				result: fakeResult,
				evidence: fakeEvidence,
				verification: fakeVerification,
				human_approved: false,
				parameter_paths: [],
			}),
		).toThrow(RoutineCaptureError);
		const regression = capture.recordReuseFailure("routine-missing", "verification regressed");
		expect(regression.reason).toBe("verification regressed");
		expect(capture.regressions()).toHaveLength(1);
	});
});
