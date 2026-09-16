import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgyCliWorkerAdapter,
	captureWorkspaceSnapshot,
	createPlanApproval,
	digestFor,
	PersonalPiPipeline,
	PersistentStateStore,
	ReferenceArchitecturePlaybook,
} from "../dist/index.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const agyPath = process.env.PPH_AGY_BINARY ?? "/Users/chenglong/.local/bin/agy";
const outputFlag = process.argv.indexOf("--output");
const outputArgument = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
const outputPath = outputArgument
	? isAbsolute(outputArgument)
		? outputArgument
		: resolve(repo, outputArgument)
	: undefined;
const temporaryRoot = mkdtempSync(join(tmpdir(), "pph-agy-candidate-"));
const workspace = join(temporaryRoot, "workspace");
mkdirSync(workspace, { recursive: true });

function errorRecord(error) {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
	};
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeObservation(observation) {
	if (!observation) return null;
	return {
		backend: observation.backend,
		requested_model: observation.requested_model,
		platform_accepted_model: observation.platform_accepted_model,
		observed_runtime_model: observation.observed_runtime_model,
		provider: observation.provider,
		session_id_sha256: observation.session_id_sha256,
		process_pid: observation.process_pid,
		status: observation.status,
		elapsed_ms: observation.elapsed_ms,
		input_tokens: observation.input_tokens,
		output_tokens: observation.output_tokens,
		model_calls: observation.model_calls,
		tool_calls: observation.tool_calls,
		timed_out: observation.timed_out,
		protocol_error: observation.protocol_error ?? null,
	};
}

function boundedLoopBudget() {
	return {
		max_attempts: 1,
		max_model_calls: 8,
		max_tool_calls: 0,
		max_handoffs: 0,
		max_elapsed_ms: 90_000,
		max_input_tokens: 30_000,
		max_output_tokens: 4_000,
		max_cost_usd: 5,
		max_state_growth_bytes: 100_000,
		on_exhaustion: { action: "BLOCKED", escalation: "human" },
	};
}

function taskFor() {
	return {
		id: "agy-candidate-real-20260916",
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Agy candidate response-side identity probe",
		objective: "Return one bounded read-only Result Contract for the Agy candidate feasibility probe.",
		requirements: ["Return a valid Result Contract without using tools or changing the workspace."],
		constraints: ["synthetic public probe", "no credentials", "no workspace mutation", "no prompt or response logging"],
		scope: { files: ["candidate-probe-result.txt"] },
		inputs: {},
		data_sources: ["synthetic public candidate probe"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "cli",
			worker_tier: "standard",
			reasoning_depth: "low",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: workspace,
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["verified candidate Result Contract and runtime identity metadata"],
		acceptance_criteria: ["response-side runtime identity is either attested or recorded as unavailable"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["Result Contract", "Work Receipt", "response-side runtime identity"],
			evidence_required: [],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 24_000 } },
		risk: "low",
		priority: "P1",
		timeout: 90_000,
		retry_policy: { max_attempts: 1, backoff: 0 },
		loop_budget: boundedLoopBudget(),
		approval: { required: false },
	};
}

function requirement() {
	return {
		user: "Personal PI owner",
		data_sources: ["synthetic public candidate probe"],
		permission_location: ["Task Contract"],
		delivery: "sanitized Agy feasibility evidence",
		acceptance: ["Result, Work Receipt, Evidence, and Verification are persisted"],
		constraints: ["no credentials", "no workspace mutation", "bounded process"],
		unknowns: ["Agy response-side runtime identity fields may be unavailable"],
		sustainability: ["replayable metadata-only evidence"],
		non_functional: ["process isolation", "fail-closed identity attestation"],
		commercialization: ["internal harness candidate"],
	};
}

function planFor(task) {
	const assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "adapter boundary only",
		testability: "automated",
		business_viability: "internal candidate",
		confidence: 0.9,
		open_risks: ["response-side runtime identity may be unavailable"],
		playbook_refs: ["agy-candidate"],
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
			{ id: "agy-candidate", task_types: [task.type], clauses: ["adapter-only candidate verification"] },
		]),
	};
}

function safeResult(result) {
	if (!result) return null;
	return {
		status: result.status,
		task_id: result.task_id,
		run_id: result.run_id,
		worker_id: result.worker_id,
		lease_epoch: result.lease_epoch,
		evidence: result.evidence,
		errors: result.errors,
		work_receipt: result.work_receipt
			? {
					work_attempted: result.work_receipt.work_attempted,
					effects_count: result.work_receipt.effects_count,
					artifacts_created: result.work_receipt.artifacts_created,
					state_changed: result.work_receipt.state_changed,
					no_op: result.work_receipt.no_op,
					no_op_reason: result.work_receipt.no_op_reason,
					evidence_refs: result.work_receipt.evidence_refs,
				}
			: null,
	};
}

function safeEvidence(evidence) {
	if (!evidence) return null;
	return {
		id: evidence.id,
		task_id: evidence.task_id,
		run_id: evidence.run_id,
		captured_at: evidence.captured_at,
		diff_digest: evidence.diff.digest,
		diff_files: evidence.diff.files,
		command_count: evidence.commands.length,
		stdout_bytes: Buffer.byteLength(evidence.stdout, "utf8"),
		stderr_bytes: Buffer.byteLength(evidence.stderr, "utf8"),
		artifacts: evidence.artifacts,
		evidence_types: evidence.evidence_types,
	};
}

function safeVerification(verification) {
	if (!verification) return null;
	return {
		id: verification.id,
		task_id: verification.task_id,
		status: verification.status,
		verification_confidence: verification.verification_confidence,
		reasons: verification.reasons,
		checked_at: verification.checked_at,
	};
}

let execution;
let executionError;
let store;
let adapter;
try {
	const task = taskFor();
	const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	store = new PersistentStateStore(join(temporaryRoot, "state.json"));
	adapter = new AgyCliWorkerAdapter({
		worker_id: "agy-cli-existing-session",
		command: agyPath,
		model: "gemini-3.8-flash-low",
		effort: "low",
		timeout_ms: 90_000,
		home_dir: process.env.HOME ?? homedir(),
	});
	const pipeline = new PersonalPiPipeline({ state_store: store });
	const snapshot = captureWorkspaceSnapshot(baseCommit, [], []);
	execution = await pipeline.execute({
		...planFor(task),
		requirement: requirement(),
		task,
		worker: adapter,
		snapshot,
		current_snapshot: snapshot,
		at: new Date().toISOString(),
	});
} catch (error) {
	executionError = errorRecord(error);
}

const runtime = adapter?.getLastAgyRun() ?? null;
const observation = adapter?.getLastObservation() ?? null;
const state = store?.read() ?? null;
const hasResponseIdentity = Boolean(runtime?.observed_runtime_model && runtime?.provider_backend);
const candidateVerdict = hasResponseIdentity && execution?.result?.status === "success" && execution?.verification?.status === "PASS"
	? "PASS_CANDIDATE"
	: runtime?.conversation_id_sha256 && !hasResponseIdentity
		? "BLOCKED_TELEMETRY"
		: executionError
			? "BLOCKED_AUTH"
			: "NOT_SUITABLE";
const report = {
	schema_version: 1,
	captured_at: new Date().toISOString(),
	candidate: "Apy CLI (actual binary: agy)",
	actual_cli: {
		binary_name: "agy",
		path: agyPath,
		version: "1.2.3",
		architecture: "arm64",
		output_formats: ["text", "json", "stream-json"],
		input_formats: ["text", "stream-json"],
		supported_efforts: ["low", "medium", "high"],
		noninteractive: ["--print", "-p"],
		trace_or_telemetry_surface: ["stream-json event stream", "--log-file"],
		subcommands: [
			"agent",
			"agents",
			"changelog",
			"help",
			"install",
			"mcp",
			"mic-serve",
			"models",
			"plugin",
			"plugins",
			"remote-control",
			"update",
		],
	},
	pph_run_id: execution?.run?.id ?? null,
	agy_runtime: runtime,
	request_prompt_id: runtime?.request_id_sha256 ?? null,
	requested_model: runtime?.requested_model ?? "gemini-3.8-flash-low",
	observed_runtime_model: runtime?.observed_runtime_model ?? null,
	provider_backend: runtime?.provider_backend ?? null,
	identity_source: runtime?.identity_source ?? "none",
	identity_fields_seen: runtime?.identity_fields_seen ?? [],
	started_at: runtime?.started_at ?? null,
	ended_at: runtime?.ended_at ?? null,
	finish_reason: runtime?.finish_reason ?? null,
	result_digest: execution?.result ? digestFor(execution.result) : null,
	work_receipt_digest: execution?.result?.work_receipt ? digestFor(execution.result.work_receipt) : null,
	evidence_digest: execution?.evidence ? digestFor(execution.evidence) : null,
	verification_digest: execution?.verification ? digestFor(execution.verification) : null,
	e2e: {
		status: execution ? "completed" : "failed_before_pipeline_return",
		execution_error: executionError ?? null,
		task_state: execution?.task?.state ?? null,
		run: execution?.run
			? {
					id: execution.run.id,
					task_id: execution.run.task_id,
					worker_id: execution.run.worker_id,
					status: execution.run.status,
					started_at: execution.run.started_at,
					ended_at: execution.run.ended_at ?? null,
					failure_reason: execution.run.failure_reason ?? null,
				}
			: null,
		result: safeResult(execution?.result),
		evidence: safeEvidence(execution?.evidence),
		verification: safeVerification(execution?.verification),
		persisted_counts: state
			? {
					tasks: state.tasks.length,
					runs: state.runs.length,
					results: state.results.length,
					evidence: state.evidence.length,
					verifications: state.verifications.length,
				}
			: null,
	},
	observation,
	heterogeneity: {
		baseline_backend: "pi-agent",
		baseline_cli: "pi",
		candidate_backend: "agy-cli",
		candidate_cli: "agy",
		separate_executable: true,
		separate_adapter: true,
	},
	decision: {
		candidate_verdict: candidateVerdict,
		phase_14_overall: "NOT_READY_UNCHANGED",
		phase_12_13: "PASS_UNCHANGED",
		formal_line: "independent Agy candidate only; does not coordinate or overwrite Hermes evidence",
		gap_id: candidateVerdict === "BLOCKED_TELEMETRY" ? "GAP-03" : null,
	},
	privacy: {
		prompt_recorded: false,
		response_recorded: false,
		credential_content_recorded: false,
		conversation_ids_hashed: true,
		request_ids_hashed: true,
		temporary_workspace: "ephemeral (removed after run)",
	},
};

const body = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, body, "utf8");
}
console.log(body);
rmSync(temporaryRoot, { recursive: true, force: true });
