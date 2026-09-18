import { describe, expect, test } from "vitest";
import {
	captureWorkspaceSnapshot,
	createPlanApproval,
	DeterministicTaskCompiler,
	IngressGate,
	type IngressReadinessError,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	type TaskIngressRequest,
} from "../src/index.ts";

const planAssessment = {
	scalability: "bounded",
	security: "least privilege",
	cost: "bounded",
	extensibility: "contract based",
	testability: "automated",
	business_viability: "internal",
	confidence: 0.9,
	open_risks: [],
	playbook_refs: [],
};

function makeIngress(id = "ingress-task"): TaskIngressRequest {
	return {
		id,
		type: "cli",
		title: "Ingress task",
		objective: "Return a bounded verified result",
		requirements: ["produce a verified result"],
		scope: { files: ["packages/personal-pi/src/index.ts"] },
		expected_outputs: ["verified result"],
		acceptance_criteria: ["worker result is independently verified"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: ["worker_result"],
			strength: "strong",
		},
	};
}

function makeRequest(
	ingress: TaskIngressRequest,
	workerExecutions: { count: number },
	toolExecutions: { count: number },
) {
	return {
		ingress,
		readiness: { dependencies_ready: true, artifact_edges: [] },
		requirement: {
			user: "Personal PI owner",
			data_sources: ["local repository"],
			permission_location: ["Task Contract"],
			delivery: "verified local result",
			acceptance: ["independent verification passes"],
			constraints: ["no network"],
			unknowns: [],
			sustainability: ["replayable evidence"],
			non_functional: ["bounded execution"],
			commercialization: ["internal core"],
		},
		plan_assessment: planAssessment,
		plan_checklist: {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		},
		plan_approval: createPlanApproval(planAssessment, "owner"),
		worker: new PiWorker("ingress-worker", () => {
			workerExecutions.count += 1;
			return {
				status: "success" as const,
				summary: "ingress execution passed",
				evidence: ["worker_result"],
				work_receipt: {
					work_attempted: true,
					effects_count: 0,
					artifacts_created: [],
					state_changed: false,
					no_op: true,
					no_op_reason: "verification-only task",
					evidence_refs: ["worker_result"],
				},
			};
		}),
		worker_status: {
			worker_capability: "available" as const,
			execution_mode: "normal" as const,
			delivery_status: "normal" as const,
		},
		command_runner: () => {
			toolExecutions.count += 1;
			return { command: "should-not-run", exit_code: 0, stdout: "", stderr: "" };
		},
		snapshot: captureWorkspaceSnapshot("ingress-commit", [], []),
		at: "2026-09-18T07:00:00.000Z",
	};
}

function expectNoExecution(
	store: PersistentStateStore,
	workerExecutions: { count: number },
	toolExecutions: { count: number },
) {
	const state = store.read();
	expect(workerExecutions.count).toBe(0);
	expect(toolExecutions.count).toBe(0);
	expect(state.tasks).toEqual([]);
	expect(state.dispatches).toEqual([]);
	expect(state.runs).toEqual([]);
	expect(state.loop_usage).toEqual({});
}

describe("T2.0-B Task Compiler and Ingress Gate", () => {
	test("compiles deterministically with conservative defaults and executes only after readiness passes", async () => {
		const compiler = new DeterministicTaskCompiler();
		const ingress = makeIngress();
		const first = compiler.compile(ingress);
		const second = compiler.compile(ingress);
		expect(first).toEqual(second);
		expect(first.permissions).toMatchObject({
			filesystem: { read: [], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		});
		expect(first.loop_budget).toBeDefined();
		expect(first.loop_budget?.max_attempts).toBe(1);
		expect(first.loop_budget?.max_handoffs).toBe(0);

		const store = new PersistentStateStore();
		const gate = new IngressGate({ pipeline: new PersonalPiPipeline({ state_store: store }), compiler });
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };
		const request = makeRequest(ingress, workerExecutions, toolExecutions);
		const probe = gate.probe(request);
		expect(probe.ready).toBe(true);
		expect(store.listTasks()).toEqual([]);
		expect(store.read().dispatches).toEqual([]);

		const execution = await gate.execute(request);
		expect(execution.task.state).toBe("DONE");
		expect(workerExecutions.count).toBe(1);
		expect(toolExecutions.count).toBe(0);
		expect(store.read().dispatches).toHaveLength(1);
		expect(store.listTasks()).toHaveLength(1);
	});

	test("fails closed when dependency or artifact readiness evidence is missing", () => {
		const store = new PersistentStateStore();
		const gate = new IngressGate({ pipeline: new PersonalPiPipeline({ state_store: store }) });
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };

		const dependencyRequest = makeRequest(
			{ ...makeIngress("blocked-dependency"), dependencies: ["prerequisite"] },
			workerExecutions,
			toolExecutions,
		);
		dependencyRequest.readiness.dependencies_ready = false;
		expect(gate.probe(dependencyRequest)).toMatchObject({
			ready: false,
			failure: { stage: "definition_of_ready" },
		});

		const artifactRequest = makeRequest(
			{ ...makeIngress("blocked-artifact"), artifact_dependencies: ["api-contract"] },
			workerExecutions,
			toolExecutions,
		);
		expect(gate.probe(artifactRequest)).toMatchObject({
			ready: false,
			failure: { stage: "definition_of_ready" },
		});
		expectNoExecution(store, workerExecutions, toolExecutions);
	});

	test("compiler failure blocks before dispatch, model, tool, or Task persistence", async () => {
		const store = new PersistentStateStore();
		const gate = new IngressGate({
			pipeline: new PersonalPiPipeline({ state_store: store }),
			compiler: {
				compile: () => {
					throw new Error("injected compiler failure");
				},
			},
		});
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };
		const execution = gate.execute(makeRequest(makeIngress("compiler-failure"), workerExecutions, toolExecutions));
		await expect(execution).rejects.toMatchObject({ stage: "compiler" } satisfies Partial<IngressReadinessError>);
		expectNoExecution(store, workerExecutions, toolExecutions);
	});

	test("worker capability failure blocks before dispatch, model, tool, or Task persistence", async () => {
		const store = new PersistentStateStore();
		const gate = new IngressGate({
			pipeline: new PersonalPiPipeline({ state_store: store }),
			probes: {
				worker_execute: () => {
					throw new Error("injected worker probe failure");
				},
			},
		});
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };
		const execution = gate.execute(makeRequest(makeIngress("worker-failure"), workerExecutions, toolExecutions));
		await expect(execution).rejects.toMatchObject({ stage: "worker" } satisfies Partial<IngressReadinessError>);
		expectNoExecution(store, workerExecutions, toolExecutions);
	});

	test("dispatch capability failure blocks before Task dispatch, model, tool, or Task persistence", async () => {
		const store = new PersistentStateStore();
		const gate = new IngressGate({
			pipeline: new PersonalPiPipeline({ state_store: store }),
			probes: {
				dispatch: () => {
					throw new Error("injected dispatch probe failure");
				},
			},
		});
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };
		const execution = gate.execute(makeRequest(makeIngress("dispatch-failure"), workerExecutions, toolExecutions));
		await expect(execution).rejects.toMatchObject({ stage: "dispatch" } satisfies Partial<IngressReadinessError>);
		expectNoExecution(store, workerExecutions, toolExecutions);
	});

	test("loop-budget controller failure blocks before dispatch, model, tool, or Task persistence", async () => {
		const store = new PersistentStateStore();
		const gate = new IngressGate({
			pipeline: new PersonalPiPipeline({ state_store: store }),
			probes: {
				loop_budget: () => {
					throw new Error("injected budget probe failure");
				},
			},
		});
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };
		const execution = gate.execute(makeRequest(makeIngress("budget-failure"), workerExecutions, toolExecutions));
		await expect(execution).rejects.toMatchObject({ stage: "budget" } satisfies Partial<IngressReadinessError>);
		expectNoExecution(store, workerExecutions, toolExecutions);
	});

	test("PersistentState write failure blocks before dispatch, model, tool, or Task persistence", async () => {
		const store = new PersistentStateStore();
		const gate = new IngressGate({
			pipeline: new PersonalPiPipeline({ state_store: store }),
			probes: {
				state_write: () => {
					throw new Error("injected state probe failure");
				},
			},
		});
		const workerExecutions = { count: 0 };
		const toolExecutions = { count: 0 };
		const execution = gate.execute(makeRequest(makeIngress("state-failure"), workerExecutions, toolExecutions));
		await expect(execution).rejects.toMatchObject({ stage: "state" } satisfies Partial<IngressReadinessError>);
		expectNoExecution(store, workerExecutions, toolExecutions);
	});
});
