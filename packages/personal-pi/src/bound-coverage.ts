export interface FeedbackPathCoverage {
	path_id: string;
	feedback_path: string;
	deterministic_bound: string;
	runtime_enforcement: string;
	persistence: string;
	exhaustion_behavior: string;
	test_evidence: string;
	active?: boolean;
}

export interface BoundCoverageAudit {
	passed: boolean;
	paths: FeedbackPathCoverage[];
	uncovered_paths: string[];
	reasons: string[];
}

const REQUIRED_FIELDS: readonly (keyof Omit<FeedbackPathCoverage, "active">)[] = [
	"path_id",
	"feedback_path",
	"deterministic_bound",
	"runtime_enforcement",
	"persistence",
	"exhaustion_behavior",
	"test_evidence",
];

export const V3_FEEDBACK_PATHS: readonly FeedbackPathCoverage[] = [
	{
		path_id: "worker-verifier-repair-retry",
		feedback_path: "Worker -> Verifier FAIL -> Repair/Recovery -> Worker",
		deterministic_bound: "TaskContract.loop_budget.max_attempts",
		runtime_enforcement: "LoopBudgetController.beforeRun before every Run",
		persistence: "PersistentStateStore.loop_usage keyed by task_id",
		exhaustion_behavior: "BLOCKED decision with human escalation; no next Run",
		test_evidence: "loop-budget.integration.test.ts: repair retry exhaustion",
	},
	{
		path_id: "repeated-model-calls",
		feedback_path: "Worker adapter -> repeated model calls",
		deterministic_bound: "TaskContract.loop_budget.max_model_calls",
		runtime_enforcement: "LoopBudgetController.beforeModelCall at adapter boundary",
		persistence: "PersistentStateStore.loop_usage.model_calls",
		exhaustion_behavior: "call rejected with LoopBudgetExhaustedError",
		test_evidence: "loop-budget.integration.test.ts: model-call exhaustion",
	},
	{
		path_id: "repeated-tool-calls",
		feedback_path: "Worker/Verifier -> repeated shell or tool calls",
		deterministic_bound: "TaskContract.loop_budget.max_tool_calls",
		runtime_enforcement: "LoopBudgetController.beforeToolCall before Verification command",
		persistence: "PersistentStateStore.loop_usage.tool_calls",
		exhaustion_behavior: "BLOCKED decision; command is not invoked",
		test_evidence: "loop-budget.integration.test.ts: tool-call exhaustion",
	},
	{
		path_id: "handoff-reassign",
		feedback_path: "Worker -> handoff/reassign -> Worker",
		deterministic_bound: "TaskContract.loop_budget.max_handoffs plus persistent lease epoch",
		runtime_enforcement: "RecoveryManager.recover(REASSIGN) calls beforeHandoff before acquiring the next lease",
		persistence: "PersistentStateStore.lease_epochs and leases",
		exhaustion_behavior: "handoff rejected or stale result fenced; human escalation",
		test_evidence:
			"loop-budget.integration.test.ts: reassign handoff exhaustion; controller-restart.integration.test.ts: epoch fencing",
	},
	{
		path_id: "decomposer-replan",
		feedback_path: "Decomposer -> replan -> Decomposer",
		deterministic_bound: "DecompositionBudget.max_replan_count",
		runtime_enforcement: "DynamicDecomposer.replan calls BudgetController.checkDecomposition and recordReplan",
		persistence: "PersistentStateStore.budget_usage and budget_decisions keyed by budget scope",
		exhaustion_behavior: "BudgetExceededError with DENY decision",
		test_evidence: "graph-intelligence.test.ts and loop-budget.integration.test.ts: persisted replan exhaustion",
	},
];

export function auditBoundCoverage(entries: readonly FeedbackPathCoverage[]): BoundCoverageAudit {
	const paths = entries.map((entry) => ({ ...entry }));
	const uncovered: string[] = [];
	const reasons: string[] = [];
	for (const entry of paths) {
		if (entry.active === false) continue;
		const missing = REQUIRED_FIELDS.filter((field) => entry[field].trim().length === 0);
		if (missing.length > 0) {
			uncovered.push(entry.path_id);
			reasons.push(`${entry.path_id}: missing ${missing.join(", ")}`);
		}
		if (entry.persistence.startsWith("BLOCKED:")) {
			uncovered.push(entry.path_id);
			reasons.push(`${entry.path_id}: persistence is not implemented`);
		}
	}
	return {
		passed: paths.length > 0 && uncovered.length === 0,
		paths,
		uncovered_paths: [...new Set(uncovered)],
		reasons,
	};
}
