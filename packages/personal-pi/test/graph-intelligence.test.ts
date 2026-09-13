import { describe, expect, test } from "vitest";
import {
	ArtifactStore,
	BudgetController,
	BudgetExceededError,
	createArtifactDependencyEdge,
	createTaskRecord,
	DecompositionContractError,
	DependencyResolver,
	DynamicDecomposer,
	graphNodeForTask,
	type TaskContract,
	TaskGraphStore,
	type TaskRecord,
	TaskStateMachine,
} from "../src/index.ts";

function makeTask(id: string, dependencies: string[] = []): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: `Task ${id}`,
		objective: "Complete a bounded graph task",
		requirements: ["Return a verified result"],
		constraints: [],
		scope: { files: [`src/${id}.ts`] },
		inputs: {},
		data_sources: ["repository"],
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
		dependencies,
		artifact_dependencies: [],
		expected_outputs: ["result"],
		acceptance_criteria: ["result passes verification"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
	};
}

function doneTask(task: TaskContract): TaskRecord {
	const machine = new TaskStateMachine();
	let record = createTaskRecord(task);
	for (const state of ["READY", "RUNNING", "VERIFYING", "DONE"] as const) record = machine.transition(record, state);
	return record;
}

describe("T8.1 dynamic decomposition", () => {
	test("atomically adds three valid child contracts and their DAG edges", () => {
		const parent = makeTask("parent");
		const children = [makeTask("prepare"), makeTask("execute"), makeTask("verify")];
		const graph = new TaskGraphStore({ revision: 0, nodes: [graphNodeForTask(parent.id)], edges: [] });
		const decomposer = new DynamicDecomposer(graph, undefined, [parent]);

		const result = decomposer.decompose(parent, children);

		expect(result.child_task_ids).toEqual(["prepare", "execute", "verify"]);
		expect(graph.read().nodes).toHaveLength(4);
		expect(graph.read().edges).toHaveLength(3);
		expect(graph.topologicalOrder()).toEqual(["node:parent", "node:prepare", "node:execute", "node:verify"]);
	});

	test("rejects an invalid child before changing the graph", () => {
		const parent = makeTask("parent");
		const graph = new TaskGraphStore({ revision: 0, nodes: [graphNodeForTask(parent.id)], edges: [] });
		const decomposer = new DynamicDecomposer(graph, undefined, [parent]);
		const invalid = { ...makeTask("invalid"), acceptance_criteria: [] };

		expect(() => decomposer.decompose(parent, [invalid])).toThrow(DecompositionContractError);
		expect(graph.read()).toEqual({ revision: 0, nodes: [graphNodeForTask(parent.id)], edges: [] });
		expect(decomposer.getTask("invalid")).toBeUndefined();
	});
});

describe("T8.2 dependency resolver", () => {
	test("marks C READY only when both A and B are DONE", () => {
		const a = doneTask(makeTask("a"));
		const b = doneTask(makeTask("b"));
		const c = createTaskRecord(makeTask("c", ["a", "b"]));
		const resolver = new DependencyResolver([a, b, c]);

		expect(resolver.resolve("c")).toEqual({ ready: true, state: "READY", reasons: [] });
		expect(resolver.resolveAll()).toEqual({ a: "DONE", b: "DONE", c: "READY" });
	});

	test("keeps a dependent task BLOCKED while one dependency is unfinished", () => {
		const a = doneTask(makeTask("a"));
		const b = createTaskRecord(makeTask("b"));
		const c = createTaskRecord(makeTask("c", ["a", "b"]));
		const result = new DependencyResolver([a, b, c]).resolve("c");

		expect(result.state).toBe("BLOCKED");
		expect(result.reasons.join(" ")).toContain("b");
	});
});

describe("T8.3 artifact dependency", () => {
	test("unblocks a consumer only after the Handoff Contract validates", () => {
		const producer = doneTask(makeTask("producer"));
		const consumer = createTaskRecord(makeTask("consumer", ["producer"]));
		const artifacts = new ArtifactStore();
		artifacts.registerSchema("api_contract", 1, (payload) => {
			return typeof payload === "object" && payload !== null && "paths" in payload;
		});
		const artifact = artifacts.put("api_contract", 1, { paths: {} }, producer.id, producer.task_revision);
		const edge = createArtifactDependencyEdge("producer-consumer", "node:producer", "node:consumer", {
			readiness: { requires_artifact: { type: "api_contract", schema_version: 1 } },
			binding: { artifact_digest: artifact.digest, producer_task_revision: producer.task_revision },
		});

		const result = new DependencyResolver([producer, consumer]).resolve("consumer", [edge], artifacts);

		expect(result).toEqual({ ready: true, state: "READY", reasons: [] });
	});
});

describe("T8.4 decomposition and coordination budgets", () => {
	test("stops recursive decomposition at max_depth and records manual increases", () => {
		const budget = new BudgetController(
			{ max_depth: 1, max_children_per_task: 3, max_total_open_tasks: 4, max_replan_count: 1 },
			{ max_active_workers: 1, max_handoffs_per_task: 1, max_concurrent_roles: 1 },
		);
		const parent = makeTask("root");
		const children = [makeTask("one"), makeTask("two"), makeTask("three")];
		const graph = new TaskGraphStore({ revision: 0, nodes: [graphNodeForTask(parent.id)], edges: [] });
		const decomposer = new DynamicDecomposer(graph, budget, [parent]);
		decomposer.decompose(parent, children);

		expect(() => decomposer.decompose(children[0], [makeTask("nested")])).toThrow(BudgetExceededError);
		expect(graph.read().nodes).toHaveLength(4);
		expect(() => budget.increase({}, {}, { approved_by: "", reason: "" })).toThrow("human_approval");
		const decision = budget.increase(
			{ max_depth: 2 },
			{},
			{ approved_by: "owner", reason: "approved bounded expansion" },
		);
		expect(decision.action).toBe("INCREASE");
		expect(budget.decisionsList().at(-1)?.approved_by).toBe("owner");
		expect(budget.decisionsList().some((decision) => decision.action === "DENY")).toBe(true);
	});

	test("blocks coordination expansion beyond active worker, handoff, or role limits", () => {
		const budget = new BudgetController(
			{ max_depth: 2, max_children_per_task: 2, max_total_open_tasks: 5, max_replan_count: 2 },
			{ max_active_workers: 1, max_handoffs_per_task: 1, max_concurrent_roles: 1 },
		);

		budget.reserveDispatch("task-1", 1, 1, 1);
		expect(() => budget.reserveDispatch("task-1", 2, 1, 1)).toThrow("max_active_workers");
		expect(() => budget.reserveDispatch("task-1", 1, 2, 1)).toThrow("max_handoffs_per_task");
		expect(() => budget.reserveDispatch("task-1", 1, 1, 2)).toThrow("max_concurrent_roles");
		budget.recordReplan();
		budget.recordReplan();
		expect(() => budget.recordReplan()).toThrow("max_replan_count");
	});
});
