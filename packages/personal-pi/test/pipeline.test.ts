import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	ContextResolver,
	ContextStore,
	captureWorkspaceSnapshot,
	createPlanApproval,
	PersistentStateStore,
	PersonalPiPipeline,
	PiWorker,
	ReferenceArchitecturePlaybook,
	type TaskContract,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

function makeTask(id: string, objective = "Return a verified result"): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Pipeline task",
		objective,
		requirements: ["Produce the requested result"],
		constraints: [],
		scope: { files: ["packages/personal-pi/src/index.ts"] },
		inputs: {},
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
		expected_outputs: ["verified result"],
		acceptance_criteria: ["independent verification passes"],
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
		approval: { required: false },
	};
}

function requirement() {
	return {
		user: "Personal PI owner",
		data_sources: ["repository"],
		permission_location: ["task contract"],
		delivery: "verified local result",
		acceptance: ["result is independently verified"],
		constraints: ["no network"],
		unknowns: [],
		sustainability: ["replayable evidence"],
		non_functional: ["deterministic"],
		commercialization: ["internal core"],
	};
}

function planFor(task: TaskContract) {
	const assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "contract based",
		testability: "automated",
		business_viability: "internal",
		confidence: 0.9,
		open_risks: [],
		playbook_refs: ["core-cli"],
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
			{ id: "core-cli", task_types: [task.type], clauses: ["bounded local execution"] },
		]),
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T7.1 complete Personal PI pipeline", () => {
	test("runs three different small requirements through DONE with persisted evidence", async () => {
		const store = new PersistentStateStore();
		const pipeline = new PersonalPiPipeline({ state_store: store });

		for (const [index, objective] of ["verify docs", "verify tests", "verify package"].entries()) {
			const task = makeTask(`e2e-${index + 1}`, objective);
			const worker = new PiWorker(`pi-${index + 1}`, (_input) => ({
				status: "success" as const,
				summary: `${objective} passed`,
				evidence: ["worker_result"],
				changed_files: [],
			}));
			const execution = await pipeline.execute({
				...planFor(task),
				requirement: requirement(),
				task,
				worker,
				snapshot: captureWorkspaceSnapshot("e2e-commit", [], []),
				at: `2026-09-13T10:0${index}:00.000Z`,
			});

			expect(execution.task.state).toBe("DONE");
			expect(execution.result.status).toBe("success");
			expect(execution.verification.status).toBe("PASS");
			expect(execution.evidence.evidence_types).toEqual(["worker_result"]);
		}

		expect(store.listTasks().map((task) => task.state)).toEqual(["DONE", "DONE", "DONE"]);
		expect(store.read().runs).toHaveLength(3);
		expect(store.read().evidence).toHaveLength(3);
		expect(store.read().verifications).toHaveLength(3);
		expect(store.read().decisions.filter((decision) => decision.decision_type === "dispatch_policy")).toHaveLength(3);
	});

	test("projects resolved context into the Worker without putting protocol metadata in it", async () => {
		const contextStore = new ContextStore();
		const reference = contextStore.put("authoritative project fact");
		const contextResolver = new ContextResolver(contextStore);
		const task = makeTask("e2e-context");
		task.context = {
			required: [reference.digest],
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 50 },
		};
		const seen: string[] = [];
		const worker = new PiWorker("pi-context", (input) => {
			seen.push(input.resolved_context?.text ?? "");
			return { status: "success", summary: "context consumed", evidence: ["worker_result"] };
		});
		const execution = await new PersonalPiPipeline().execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			context_resolver: contextResolver,
			snapshot: captureWorkspaceSnapshot("context-commit", [], []),
		});

		expect(execution.task.state).toBe("DONE");
		expect(seen).toEqual(["authoritative project fact"]);
	});
});

describe("T7.2 self-development", () => {
	test("lets a contracted Worker modify a small self-owned function and verifies it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-self-development-"));
		temporaryDirectories.push(directory);
		const target = join(directory, "self-owned-function.ts");
		writeFileSync(target, "export function value(): string { return 'old'; }\n", "utf8");
		const task = makeTask("self-development", "update the self-owned function");
		task.scope = { files: [target] };
		const worker = new PiWorker("pi-self", (_input) => {
			writeFileSync(target, "export function value(): string { return 'new'; }\n", "utf8");
			return {
				status: "success",
				summary: "self-owned function updated",
				changed_files: [target],
				evidence: ["worker_result"],
			};
		});
		const execution = await new PersonalPiPipeline().execute({
			...planFor(task),
			requirement: requirement(),
			task,
			worker,
			snapshot: captureWorkspaceSnapshot("self-commit", [target], []),
			current_snapshot: captureWorkspaceSnapshot("self-commit", [target], []),
		});

		expect(execution.task.state).toBe("DONE");
		expect(readFileSync(target, "utf8")).toContain("return 'new'");
	});
});
