import {
	createPlanApproval,
	type ModelIdentity,
	type PlanQualityChecklist,
	ReferenceArchitecturePlaybook,
	type RequirementContract,
	type TaskContract,
	type WorkerStatus,
} from "../src/index.ts";

export const AVAILABLE_WORKER_STATUS: WorkerStatus = {
	worker_capability: "available",
	execution_mode: "normal",
	delivery_status: "normal",
};

export const UNAVAILABLE_WORKER_STATUS: WorkerStatus = {
	worker_capability: "unavailable",
	execution_mode: "root_only",
	delivery_status: "degraded",
};

export const UNKNOWN_MODEL_IDENTITY: ModelIdentity = {
	requested_model: "unknown",
	platform_accepted_model: "unknown",
	observed_runtime_model: "unknown",
};

export function boundedLoopBudget(overrides: Partial<NonNullable<TaskContract["loop_budget"]>> = {}) {
	return {
		max_attempts: 2,
		max_model_calls: 2,
		max_tool_calls: 2,
		max_handoffs: 1,
		max_elapsed_ms: 60000,
		max_input_tokens: 4000,
		max_output_tokens: 4000,
		max_cost_usd: 1,
		max_state_growth_bytes: 10000,
		on_exhaustion: { action: "BLOCKED" as const, escalation: "human" as const },
		...overrides,
	};
}

export function makeV3Task(id: string, overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: `V3 task ${id}`,
		objective: "Complete a bounded local verification task",
		requirements: ["Produce an independently verified result"],
		constraints: ["local only"],
		scope: { files: [`tmp/${id}.txt`] },
		inputs: {},
		data_sources: ["local test fixture"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: ["tmp"] },
			shell: { allowed: ["node"] },
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
			allowed_tools: ["shell"],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["verified local result"],
		acceptance_criteria: ["independent command exits zero"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["independent command"],
			evidence_required: ["independent_command"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 4000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: boundedLoopBudget(),
		approval: { required: false },
		...overrides,
	};
}

export function requirementFor(delivery = "verified local result"): RequirementContract {
	return {
		user: "Personal PI owner",
		data_sources: ["local test fixture"],
		permission_location: ["Task Contract"],
		delivery,
		acceptance: ["independent verification passes"],
		constraints: ["no network", "deterministic"],
		unknowns: [],
		sustainability: ["replayable evidence"],
		non_functional: ["bounded execution"],
		commercialization: ["internal harness"],
	};
}

export function planFor(task: TaskContract) {
	const assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "contract based",
		testability: "automated",
		business_viability: "internal",
		confidence: 0.9,
		open_risks: [],
		playbook_refs: ["v3-local"],
	};
	const plan_checklist: PlanQualityChecklist = {
		technical_feasibility: true,
		scalability: true,
		commercial_reasonableness: true,
		testability: true,
	};
	return {
		plan_assessment: assessment,
		plan_checklist,
		plan_approval: createPlanApproval(assessment, "owner"),
		playbook: new ReferenceArchitecturePlaybook([
			{ id: "v3-local", task_types: [task.type], clauses: ["bounded local execution"] },
		]),
	};
}
