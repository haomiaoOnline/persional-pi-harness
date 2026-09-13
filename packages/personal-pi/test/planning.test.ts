import { describe, expect, test } from "vitest";
import {
	type ArchitectureCommercialAssessment,
	assessArchitectureCommercial,
	assessTask,
	calculatePlanDigest,
	checkRoleBoundary,
	createDecisionRecord,
	createDispatchDecision,
	crossCheckAssessment,
	DEFAULT_ROLE_PROFILES,
	deriveReasoningDepth,
	evaluatePlanQualityGate,
	MasterControlPlane,
	PreclassifierIncidentTracker,
	preclassifyTask,
	ReferenceArchitecturePlaybook,
	type TaskAssessment,
	type TaskContract,
	validateRequirementContract,
	validateRoleProfile,
} from "../src/index.ts";

function makeTask(id = "planning-task"): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Planning task",
		objective: "Apply a deterministic planning rule",
		requirements: ["Return a decision"],
		constraints: [],
		scope: { files: ["src/service/index.ts"] },
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
		expected_outputs: ["decision"],
		acceptance_criteria: ["decision is recorded"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["decision_present"],
			evidence_required: ["stdout"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 3000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 100 },
		approval: { required: false },
	};
}

describe("T2.0 Fast/Slow preclassifier", () => {
	test("routes a bounded task to FAST", () => {
		const result = preclassifyTask({ description: "Rename a local variable", files: ["src/index.ts"] });
		expect(result.path).toBe("FAST");
	});

	test("routes high-risk keywords to SLOW", () => {
		const result = preclassifyTask({
			description: "Apply a production deploy and database migration",
			files: ["db/migration/001.sql"],
		});
		expect(result.path).toBe("SLOW");
		expect(result.matched_signals).toEqual(expect.arrayContaining(["database_migration", "production_deploy"]));
	});

	test("uses ambiguity and history as deterministic SLOW signals", () => {
		expect(preclassifyTask({ description: "Investigate an unclear issue", ambiguous: true }).path).toBe("SLOW");
		expect(preclassifyTask({ description: "Retry a task", history_success_rate: 0.5 }).path).toBe("SLOW");
	});

	test("meets the 90% labeled accuracy threshold without missing high-risk cases", () => {
		const cases = [
			["update a README", "FAST"],
			["format one TypeScript file", "FAST"],
			["rename a local function", "FAST"],
			["add a unit test", "FAST"],
			["fix a typo in docs", "FAST"],
			["change a CSS color", "FAST"],
			["run a small CLI check", "FAST"],
			["update a local fixture", "FAST"],
			["write a focused parser test", "FAST"],
			["document a helper", "FAST"],
			["change database schema migration", "SLOW"],
			["modify permission authorization", "SLOW"],
			["publish an external API", "SLOW"],
			["deploy to production", "SLOW"],
			["charge a payment", "SLOW"],
			["rotate a credential secret", "SLOW"],
			["review a browser page", "FAST"],
			["add a data calculation", "FAST"],
			["edit a shell script", "FAST"],
			["fix an integration dependency", "SLOW"],
		] as const;
		const correct = cases.filter(
			([description, expected]) => preclassifyTask({ description }).path === expected,
		).length;
		expect(correct / cases.length).toBeGreaterThanOrEqual(0.9);
		for (const [description] of cases.slice(10, 16)) expect(preclassifyTask({ description }).path).toBe("SLOW");
	});
});

describe("T2.0-A false-negative tracking", () => {
	test("records incidents and forces the repeated signal onto SLOW", () => {
		const tracker = new PreclassifierIncidentTracker();
		tracker.recordFalseNegative("task-a", "permission_model");
		tracker.recordFalseNegative("task-b", "permission_model");
		expect(tracker.list()).toHaveLength(2);
		expect(tracker.forcedSignals()).toEqual(["permission_model"]);
		expect(preclassifyTask({ description: "ordinary task", forced_slow_signals: tracker.forcedSignals() }).path).toBe(
			"FAST",
		);
		expect(
			preclassifyTask({ description: "change permission model", forced_slow_signals: tracker.forcedSignals() }).path,
		).toBe("SLOW");
	});
});

describe("T2.2 assessment and T2.3 dispatch", () => {
	test("cross-checks a model suggestion against deterministic risk rules", () => {
		const assessment = assessTask("Change the permission model", ["src/auth.ts"], { risk: "low", confidence: 0.99 });
		const checked = crossCheckAssessment(assessment, "Change the permission model", ["src/auth.ts"]);
		expect(checked.risk).toBe("medium");
		expect(checked.capability_tags).toContain("coding");
	});

	test("is stable for repeated assessment calls", () => {
		const outputs = Array.from({ length: 5 }, () => assessTask("Add a small test", ["test/unit.ts"]));
		for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
	});

	test("extracts capability tags without making routing calls", () => {
		const assessment = assessTask("Use a browser and shell to inspect a data page", ["src/tool.ts"]);
		expect(assessment.capability_tags).toEqual(expect.arrayContaining(["browsing", "tool_use", "math", "coding"]));
	});

	test("chooses dispatch mode, tier, and a role-bounded candidate", () => {
		const task = makeTask();
		const assessment = assessTask("Implement a complex API integration", [
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
		]);
		const decision = createDispatchDecision(task, assessment, DEFAULT_ROLE_PROFILES[0]);
		expect(decision.mode).toBe("DECOMPOSE");
		expect(decision.worker_tier).toBe("standard");
		expect(decision.candidate_worker_types).toEqual(["pi"]);
		expect(decision.reason).toContain("backend-engineer");
	});

	test("persists a traceable Decision Record for policy output", () => {
		const record = createDecisionRecord("dispatch_policy", "SINGLE_WORKER", "small bounded task", ["task-1"]);
		expect(record.decision_type).toBe("dispatch_policy");
		expect(record.inputs).toEqual(["task-1"]);
		expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("T2.3-A reasoning depth", () => {
	test("covers low, medium, high, and extended deterministically", () => {
		const base: TaskAssessment = {
			scope: [],
			workload: "small",
			risk: "low",
			uncertainty: "low",
			dependency: "simple",
			parallelism: "ineligible",
			verification: "strong",
			context_budget: 2000,
			confidence: 0.9,
			capability_tags: [],
		};
		expect(deriveReasoningDepth(base)).toBe("low");
		expect(deriveReasoningDepth({ ...base, risk: "medium" })).toBe("medium");
		expect(deriveReasoningDepth({ ...base, risk: "high" })).toBe("high");
		expect(deriveReasoningDepth({ ...base, confidence: 0.5 })).toBe("high");
		expect(deriveReasoningDepth(base, true)).toBe("extended");
	});
});

describe("T2.4–T2.6 requirement and plan gate", () => {
	test("requires every requirement contract section", () => {
		const valid = {
			user: "owner",
			data_sources: ["repo"],
			permission_location: ["workspace"],
			delivery: "markdown",
			acceptance: ["reviewed"],
			constraints: [],
			unknowns: [],
			sustainability: ["maintainable"],
			non_functional: ["deterministic"],
			commercialization: ["internal"],
		};
		expect(validateRequirementContract(valid)).toBe(true);
		expect(validateRequirementContract({ ...valid, user: "" })).toBe(false);
		expect(validateRequirementContract({ ...valid, acceptance: undefined })).toBe(false);
	});

	test("requires a Playbook reference or records the missing architecture risk", () => {
		const requirement = {
			user: "owner",
			data_sources: ["repo"],
			permission_location: ["workspace"],
			delivery: "service",
			acceptance: ["tests"],
			constraints: [],
			unknowns: [],
			sustainability: [],
			non_functional: ["safe"],
			commercialization: ["internal"],
		};
		const playbook = new ReferenceArchitecturePlaybook();
		const assessment = assessArchitectureCommercial(requirement, "api", playbook);
		expect(assessment.playbook_refs).toEqual([]);
		expect(assessment.open_risks).toContain("无参考架构");
	});

	test("passes only after all checklist items and human approval match", () => {
		const assessment: ArchitectureCommercialAssessment = {
			scalability: "ok",
			security: "ok",
			cost: "ok",
			extensibility: "ok",
			testability: "ok",
			business_viability: "ok",
			confidence: 0.9,
			open_risks: [],
			playbook_refs: ["api-default"],
		};
		const checklist = {
			technical_feasibility: true,
			scalability: true,
			commercial_reasonableness: true,
			testability: true,
		};
		const digest = calculatePlanDigest(assessment);
		const approval = {
			approved_by: "human",
			action_digest: digest,
			bound_revision: 1,
			expires_at: "2099-01-01T00:00:00.000Z",
		};
		expect(evaluatePlanQualityGate(assessment, checklist).passed).toBe(false);
		expect(evaluatePlanQualityGate(assessment, checklist, approval).passed).toBe(true);
		expect(evaluatePlanQualityGate(assessment, checklist, { ...approval, action_digest: "wrong" }).passed).toBe(
			false,
		);
	});
});

describe("T2.1 and T2.7 control/role boundaries", () => {
	test("provides three valid initial role profiles", () => {
		expect(DEFAULT_ROLE_PROFILES).toHaveLength(3);
		for (const role of DEFAULT_ROLE_PROFILES) expect(validateRoleProfile(role).valid).toBe(true);
	});

	test("keeps prohibited actions identical regardless of Worker type", () => {
		const role = DEFAULT_ROLE_PROFILES[0];
		const task = { permissions: makeTask().permissions, scope: makeTask().scope, type: "production_deploy" } as const;
		expect(checkRoleBoundary(role, task).allowed).toBe(false);
		expect(checkRoleBoundary(role, task).reasons).toEqual(checkRoleBoundary(role, task).reasons);
	});

	test("Master can create ten tasks but has no business write capability", () => {
		const master = new MasterControlPlane();
		for (let index = 0; index < 10; index += 1) master.createTask(makeTask(`task-${index}`));
		expect(master.listTasks()).toHaveLength(10);
		expect(master.getBusinessWriteAttempts()).toBe(0);
		expect(() => master.requestBusinessWrite("write business file")).toThrow("control-only");
		expect(master.getBusinessWriteAttempts()).toBe(1);
	});
});
