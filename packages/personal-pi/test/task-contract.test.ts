import { describe, expect, test } from "vitest";
import {
	ArtifactStore,
	assertProtocolMetadataIsolation,
	buildPromptPayload,
	createGraphEdge,
	createProtocolEnvelope,
	createTaskRecord,
	evaluateDefinitionOfReady,
	GraphCycleError,
	LeaseManager,
	type TaskContract,
	TaskGraphStore,
	TaskStateMachine,
	validateTaskContract,
} from "../src/index.ts";

function makeTask(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		id: "task-1",
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Test task",
		objective: "Run a deterministic check",
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
			reasoning_depth: "low",
			capability_tags: ["test_runner"],
			mode: "single",
			working_directory: ".",
			allowed_tools: ["shell"],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["test result"],
		acceptance_criteria: ["exit code is zero"],
		verification: {
			strategy: "automated",
			commands: ["npm test"],
			checks: ["exit_code_zero"],
			evidence_required: ["stdout"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P0",
		timeout: 1000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
		...overrides,
	};
}

describe("T1.1 Task Contract", () => {
	test("accepts the complete v2.1 contract", () => {
		const result = validateTaskContract(makeTask());
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("rejects missing permissions and verification", () => {
		const task = makeTask();
		const incomplete = { ...task } as Record<string, unknown>;
		delete incomplete.permissions;
		delete incomplete.verification;
		const result = validateTaskContract(incomplete);
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("permissions");
		expect(result.errors.join("\n")).toContain("verification");
	});

	test("rejects illegal enum values and revisions", () => {
		const result = validateTaskContract({ ...makeTask(), schema_version: 1, risk: "urgent" });
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

describe("T1.1-A DoR", () => {
	test("requires both a valid contract and acceptance criteria", () => {
		const result = evaluateDefinitionOfReady(makeTask({ acceptance_criteria: [] }), true);
		expect(result).toEqual({
			ready: false,
			state: "NOT_READY",
			reasons: ["/acceptance_criteria: must contain at least one criterion"],
		});
	});

	test("blocks a valid task while dependencies are incomplete", () => {
		const result = evaluateDefinitionOfReady(makeTask(), false);
		expect(result.state).toBe("BLOCKED");
		expect(result.ready).toBe(false);
	});
});

describe("T1.2 task state machine", () => {
	test("allows the normal path and records every transition", () => {
		const machine = new TaskStateMachine();
		let task = createTaskRecord(makeTask());
		task = machine.transition(task, "READY", "DoR passed", "2026-09-13T00:00:00.000Z");
		task = machine.transition(task, "RUNNING");
		task = machine.transition(task, "VERIFYING");
		task = machine.transition(task, "DONE", "verification passed");
		expect(task.state).toBe("DONE");
		expect(task.audit_log).toHaveLength(4);
		expect(() => machine.transition(task, "READY")).toThrow("invalid task transition");
	});

	test("supports a VERIFYING rework path but never bypasses the table", () => {
		const machine = new TaskStateMachine();
		let task = createTaskRecord(makeTask());
		task = machine.transition(task, "READY");
		task = machine.transition(task, "RUNNING");
		task = machine.transition(task, "VERIFYING");
		task = machine.transition(task, "READY", "verification needs rework");
		expect(task.state).toBe("READY");
	});
});

describe("T1.3 graph and T1.3-A atomic mutation", () => {
	test("supports a DAG and returns a topological order", () => {
		const graph = new TaskGraphStore();
		graph.applyMutation({
			nodes: [
				{ id: "a", task_id: "a" },
				{ id: "b", task_id: "b" },
				{ id: "c", task_id: "c" },
			],
			edges: [createGraphEdge("a-c", "a", "c", "DEPENDS_ON"), createGraphEdge("b-c", "b", "c", "DEPENDS_ON")],
		});
		expect(graph.topologicalOrder()).toEqual(["a", "b", "c"]);
	});

	test("rejects cycles and preserves the previous graph", () => {
		const graph = new TaskGraphStore();
		graph.applyMutation({
			nodes: [
				{ id: "a", task_id: "a" },
				{ id: "b", task_id: "b" },
			],
			edges: [],
		});
		graph.addEdge(createGraphEdge("a-b", "a", "b", "DEPENDS_ON"));
		expect(() => graph.addEdge(createGraphEdge("b-a", "b", "a", "DEPENDS_ON"))).toThrow(GraphCycleError);
		expect(graph.read().edges).toHaveLength(1);
	});

	test("rolls back a whole mutation when its commit hook fails", () => {
		const graph = new TaskGraphStore();
		expect(() =>
			graph.applyMutation({ nodes: [{ id: "a", task_id: "a" }], edges: [] }, () => {
				throw new Error("simulated process crash");
			}),
		).toThrow("simulated process crash");
		expect(graph.read()).toEqual({ revision: 0, nodes: [], edges: [] });
	});
});

describe("T1.3-B artifact handoff", () => {
	test("keeps the downstream task blocked for an invalid artifact", () => {
		const artifacts = new ArtifactStore();
		artifacts.registerSchema("api_contract", 1, (payload) => {
			return typeof payload === "object" && payload !== null && "paths" in payload;
		});
		const invalid = artifacts.put("api_contract", 1, { openapi: "3.0.0" }, "backend", 1);
		const edge = {
			id: "backend-frontend-api",
			from: "backend",
			to: "frontend",
			type: "PRODUCES_ARTIFACT" as const,
			handoff: {
				readiness: { requires_artifact: { type: "api_contract", schema_version: 1 } },
				binding: { artifact_digest: invalid.digest, producer_task_revision: 1 },
			},
		};
		const result = evaluateDefinitionOfReady(makeTask({ id: "frontend" }), true, [edge], artifacts);
		expect(result.state).toBe("BLOCKED");
		expect(result.reasons.join(" ")).toContain("产物契约不匹配");
	});

	test("unblocks only after schema, digest, and producer revision all match", () => {
		const artifacts = new ArtifactStore();
		artifacts.registerSchema("api_contract", 1, (payload) => {
			return typeof payload === "object" && payload !== null && "paths" in payload;
		});
		const valid = artifacts.put("api_contract", 1, { openapi: "3.0.0", paths: {} }, "backend", 2);
		const edge = {
			id: "backend-frontend-api",
			from: "backend",
			to: "frontend",
			type: "PRODUCES_ARTIFACT" as const,
			handoff: {
				readiness: { requires_artifact: { type: "api_contract", schema_version: 1 } },
				binding: { artifact_digest: valid.digest, producer_task_revision: 2 },
			},
		};
		const result = evaluateDefinitionOfReady(makeTask({ id: "frontend" }), true, [edge], artifacts);
		expect(result).toEqual({ ready: true, state: "READY", reasons: [] });
	});
});

describe("T1.4 fencing and T1.5 protocol isolation", () => {
	test("rejects a stale worker result after reassignment", () => {
		const leases = new LeaseManager();
		const workerA = leases.acquire("task-1", "worker-a");
		const workerB = leases.acquire("task-1", "worker-b");
		expect(leases.acceptResult(workerA)).toEqual({ accepted: false, reason: "stale_result" });
		expect(leases.acceptResult(workerB)).toEqual({ accepted: true, reason: "current" });
	});

	test("keeps protocol metadata in the envelope and out of the prompt", () => {
		const task = makeTask({ execution: { ...makeTask().execution, idempotency_key: "effect-1" } });
		const envelope = createProtocolEnvelope(task, 3, "digest-1");
		const prompt = buildPromptPayload(task);
		expect(envelope.lease_epoch).toBe(3);
		expect(prompt).not.toHaveProperty("task_revision");
		expect(() => assertProtocolMetadataIsolation({ objective: "x", task_revision: 1 })).toThrow("leaked");
	});
});
