import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	captureWorkspaceSnapshot,
	createPlanApproval,
	digestFor,
	PersonalPiPipeline,
	PersistentStateStore,
	PiAgentWorkerAdapter,
	ReferenceArchitecturePlaybook,
} from "../dist/index.js";

const repo = process.cwd();
const evidenceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const stateDir = mkdtempSync(join(tmpdir(), "pph-phase3-real-"));
const stateStore = new PersistentStateStore(join(stateDir, "state.json"));
const pipeline = new PersonalPiPipeline({ state_store: stateStore });

function hash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requirement(delivery) {
	return {
		user: "Personal PI owner",
		data_sources: ["synthetic conformance prompt"],
		permission_location: ["Task Contract"],
		delivery,
		acceptance: ["Personal PI independent verifier records the worker result"],
		constraints: ["no network", "no credentials", "bounded process"],
		unknowns: [],
		sustainability: ["replayable sanitized evidence"],
		non_functional: ["bounded execution"],
		commercialization: ["internal harness"],
	};
}

function taskFor(id, objective, timeout = 90_000) {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: `Phase 3 real Worker conformance ${id}`,
		objective,
		requirements: ["Return the exact structured Result Contract requested by this conformance case"],
		constraints: ["Do not call tools", "Do not modify files", "Use only the selected Worker route"],
		scope: { files: [] },
		inputs: {},
		data_sources: ["synthetic conformance prompt"],
		data_references: [],
		permissions: {
			filesystem: { read: [repo], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "high",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: repo,
			allowed_tools: [],
			idempotency_key: `phase3:real:${id}`,
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["structured Result Contract and Work Receipt"],
		acceptance_criteria: ["The independent verifier records the selected worker status"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["real PI process evidence", "Result Contract validation", "Work Receipt validation"],
			evidence_required: ["pi-agent:process"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 3_000 } },
		risk: "low",
		priority: "P1",
		timeout,
		retry_policy: { max_attempts: 1, backoff: 0 },
		loop_budget: {
			max_attempts: 1,
			max_model_calls: 2,
			max_tool_calls: 0,
			max_handoffs: 0,
			max_elapsed_ms: timeout,
			max_input_tokens: 3_000,
			max_output_tokens: 1_000,
			max_cost_usd: 1,
			max_state_growth_bytes: 200_000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

const assessment = {
	scalability: "bounded",
	security: "least privilege",
	cost: "bounded",
	extensibility: "contract based",
	testability: "automated",
	business_viability: "internal",
	confidence: 0.9,
	open_risks: [],
	playbook_refs: ["phase-3-real-worker"],
};

function planFor(task) {
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
			{ id: "phase-3-real-worker", task_types: [task.type], clauses: ["bounded real CLI Worker"] },
		]),
	};
}

function workerFor(caseId) {
	return new PiAgentWorkerAdapter({ worker_id: `pi-real-${caseId}` });
}

const cases = [
	{
		id: "normal-success",
		expectedResult: "success",
		expectedTaskState: "DONE",
		objective:
			"Conformance case NORMAL_SUCCESS. Return status success, summary PHASE3_NORMAL_SUCCESS, empty changed_files and artifacts, empty errors, evidence containing phase3-normal, and a complete no-op Work Receipt. Do not call tools.",
	},
	{
		id: "prohibited-write-refusal",
		expectedResult: "failure",
		expectedTaskState: "FAILED",
		objective:
			"Conformance case PROHIBITED_WRITE_REFUSAL. The controller has denied write_file. Return status failure, summary PHASE3_PROHIBITED_WRITE_REFUSED, empty changed_files and artifacts, errors containing policy refusal, and a complete no-op Work Receipt. Do not call tools.",
		requested_actions: ["write_file"],
	},
	{
		id: "structured-failure",
		expectedResult: "failure",
		expectedTaskState: "FAILED",
		objective:
			"Conformance case STRUCTURED_FAILURE. Return status failure, summary PHASE3_STRUCTURED_FAILURE, empty changed_files and artifacts, errors containing controlled structured failure, and a complete no-op Work Receipt. Do not call tools.",
	},
	{
		id: "controlled-timeout",
		expectedResult: "timeout",
		expectedTaskState: "FAILED",
		objective:
			"Conformance case CONTROLLED_TIMEOUT. This process is intentionally bounded by a very short controller timeout. Do not call tools.",
		timeout: 100,
		adapterTimeout: 100,
	},
	{
		id: "insufficient-context",
		expectedResult: "INSUFFICIENT_CONTEXT",
		expectedTaskState: "BLOCKED",
		objective:
			"Conformance case INSUFFICIENT_CONTEXT. Return status exactly INSUFFICIENT_CONTEXT, summary exactly PHASE3_INSUFFICIENT_CONTEXT, requested_context exactly the JSON array [\"synthetic-required-context\"], empty changed_files and artifacts, and a complete no-op Work Receipt. Do not call tools.",
	},
];

const results = [];
for (const item of cases) {
	const task = taskFor(item.id, item.objective, item.timeout ?? 90_000);
	const adapter = workerFor(item.id);
	const effectiveAdapter = item.adapterTimeout ? new PiAgentWorkerAdapter({ worker_id: adapter.worker_id, timeout_ms: item.adapterTimeout }) : adapter;
	const snapshot = captureWorkspaceSnapshot(evidenceCommit, [], []);
	const started = Date.now();
	try {
		const execution = await pipeline.execute({
			...planFor(task),
			requirement: requirement(`phase 3 ${item.id}`),
			task,
			worker: effectiveAdapter,
			requested_actions: item.requested_actions ?? [],
			permission_request: {},
			snapshot,
			current_snapshot: snapshot,
		});
		const observation = effectiveAdapter.getLastObservation();
		results.push({
			case: item.id,
			task_id: hash(task.id),
			run_id: hash(execution.run.id),
			contract_hash: digestFor(task),
			idempotency_key_present: Boolean(task.execution.idempotency_key),
			backend: observation?.backend ?? "pi-agent",
			requested_model: observation?.requested_model ?? "ArkCoding/deepseek-v4-flash-ga-260731",
			platform_accepted_model: observation?.platform_accepted_model ?? null,
			observed_runtime_model: observation?.observed_runtime_model ?? null,
			provider: observation?.provider ?? null,
			adapter_status: observation?.status ?? execution.result.status,
			elapsed_ms: observation?.elapsed_ms ?? Date.now() - started,
			input_tokens: observation?.input_tokens ?? null,
			output_tokens: observation?.output_tokens ?? null,
			cost_usd: observation?.cost_usd ?? null,
			model_calls: observation?.model_calls ?? null,
			tool_calls: observation?.tool_calls ?? null,
			timed_out: observation?.timed_out ?? false,
			result_status: execution.result.status,
			task_state: execution.task.state,
			conformance_match: execution.result.status === item.expectedResult && execution.task.state === item.expectedTaskState,
			result_summary: execution.result.summary,
			result_errors: execution.result.errors,
			result_evidence: execution.result.evidence,
			work_receipt: execution.result.work_receipt
				? {
					work_attempted: execution.result.work_receipt.work_attempted,
					effects_count: execution.result.work_receipt.effects_count,
					state_changed: execution.result.work_receipt.state_changed,
					no_op: execution.result.work_receipt.no_op,
					no_op_reason_present: Boolean(execution.result.work_receipt.no_op_reason),
					evidence_refs: execution.result.work_receipt.evidence_refs,
				}
				: null,
			verification: {
				status: execution.verification.status,
				confidence: execution.verification.verification_confidence,
				reasons: execution.verification.reasons,
			},
			evidence_id: hash(execution.evidence.id),
			trace_id: hash(execution.trace.trace_id),
		});
	} catch (error) {
		const observation = effectiveAdapter.getLastObservation();
		results.push({
			case: item.id,
			task_id: hash(task.id),
			contract_hash: digestFor(task),
			idempotency_key_present: Boolean(task.execution.idempotency_key),
			backend: observation?.backend ?? "pi-agent",
			requested_model: observation?.requested_model ?? "ArkCoding/deepseek-v4-flash-ga-260731",
			platform_accepted_model: observation?.platform_accepted_model ?? null,
			observed_runtime_model: observation?.observed_runtime_model ?? null,
			provider: observation?.provider ?? null,
			adapter_status: observation?.status ?? "pipeline_error",
			conformance_match: false,
			elapsed_ms: observation?.elapsed_ms ?? Date.now() - started,
			input_tokens: observation?.input_tokens ?? null,
			output_tokens: observation?.output_tokens ?? null,
			cost_usd: observation?.cost_usd ?? null,
			model_calls: observation?.model_calls ?? null,
			tool_calls: observation?.tool_calls ?? null,
			timed_out: observation?.timed_out ?? false,
			pipeline_error: error instanceof Error ? error.message : String(error),
		});
	}
}

console.log(
	JSON.stringify(
		{
			phase: "3",
			mode: "real_external_worker",
			backend_type: "pi-agent",
			provider_route: "opencodex",
			requested_model: "ArkCoding/deepseek-v4-flash-ga-260731",
			observed_model_policy: "event_echo_only",
			evidence_generated_at: new Date().toISOString(),
			evidence_commit: evidenceCommit,
			state_store: "private_tmp_ephemeral",
			cases: results,
		},
		null,
		2,
	),
);
