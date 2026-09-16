import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	EvidenceCollector,
	HermesCliWorkerAdapter,
	VerificationEngine,
	captureWorkspaceSnapshot,
	createProtocolEnvelope,
	digestFor,
} from "../dist/index.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const defaultOutput = join(repo, "docs/stage-gates/evidence/phase-14-hermes-e2e-2026-09-16.json");
const outputFlag = process.argv.indexOf("--output");
const outputArgument = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
const outputPath = outputArgument
	? isAbsolute(outputArgument)
		? outputArgument
		: resolve(repo, outputArgument)
	: defaultOutput;

const MODEL = "ArkCoding/deepseek-v4-flash-ga-260731";
const PROVIDER = "custom";
const RUN_ID = "pph-t14.2-hermes-e2e-20260916-01";
const TASK_ID = "phase14-hermes-synthetic-e2e";
const OBJECTIVE = "PPH_SYNTHETIC_HERMES_PROBE_v1";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function jsonDigest(value) {
	return sha256(JSON.stringify(value));
}

function boundedLoopBudget() {
	return {
		max_attempts: 1,
		max_model_calls: 2,
		max_tool_calls: 0,
		max_handoffs: 0,
		max_elapsed_ms: 90_000,
		max_input_tokens: 50_000,
		max_output_tokens: 4_000,
		max_cost_usd: 5,
		max_state_growth_bytes: 100_000,
		on_exhaustion: { action: "BLOCKED", escalation: "human" },
	};
}

function taskFor(workspace) {
	return {
		id: TASK_ID,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Phase 14 Hermes synthetic identity E2E",
		objective: OBJECTIVE,
		requirements: ["Return a legal no-op Result Contract and same-run response-side identity"],
		constraints: ["synthetic only", "no credentials", "no tools", "no resolved context", "no workspace effect"],
		scope: { files: [`tmp/${TASK_ID}.txt`] },
		inputs: {},
		data_sources: ["synthetic public probe"],
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
			reasoning_depth: "high",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: workspace,
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["sanitized Hermes runtime identity evidence"],
		acceptance_criteria: ["Result, Work Receipt, Evidence, and Verification all pass"],
		verification: {
			strategy: "automated",
			commands: ["phase14-hermes-identity-shape"],
			checks: ["Result Contract", "Work Receipt", "response-side runtime identity", "heterogeneous backend"],
			evidence_required: ["worker_result", "hermes_identity", "hermes_receipt", "heterogeneous_backend"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 50_000 } },
		risk: "low",
		priority: "P1",
		timeout: 90_000,
		retry_policy: { max_attempts: 1, backoff: 0 },
		loop_budget: boundedLoopBudget(),
		approval: { required: false },
	};
}

function requestFor(task) {
	return {
		task,
		protocol: createProtocolEnvelope(task, 1, "phase14-hermes-e2e"),
		run_id: RUN_ID,
		requested_actions: [],
		permission_request: {},
	};
}

function findPiObservation(value) {
	if (!value || typeof value !== "object") return undefined;
	if (
		value.backend === "pi-agent" &&
		value.provider === "opencodex" &&
		typeof value.observed_runtime_model === "string"
	)
		return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findPiObservation(item);
			if (found) return found;
		}
		return undefined;
	}
	for (const child of Object.values(value)) {
		const found = findPiObservation(child);
		if (found) return found;
	}
	return undefined;
}

function safeObservation(observation) {
	if (!observation) return null;
	const identity = observation.runtime_identity;
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
		runtime_identity: identity
			? {
					pph_run_id: identity.pph_run_id,
					hermes_session_id: identity.hermes_session_id,
					hermes_task_id: identity.hermes_task_id,
					api_call_count: identity.api_call_count,
					started_at: identity.started_at,
					ended_at: identity.ended_at,
					api_duration: identity.api_duration,
					provider: identity.provider,
					configured_model: identity.configured_model,
					response_model: identity.response_model,
					api_mode: identity.api_mode,
					base_url_host: identity.base_url_host,
					response_id: identity.response_id,
					request_id: identity.request_id,
					finish_reason: identity.finish_reason,
					usage: identity.usage,
					cli_path: identity.cli_path,
					cli_version: identity.cli_version,
					identity_source: identity.identity_source,
					source_event: identity.source_event,
				}
			: null,
		result_digest: observation.result_digest,
		work_receipt_digest: observation.work_receipt_digest,
		evidence_digest: observation.evidence_digest,
	};
}

async function main() {
	const workspace = mkdtempSync(join(tmpdir(), "pph-phase14-hermes-"));
	try {
		const task = taskFor(workspace);
		const adapter = new HermesCliWorkerAdapter({
			worker_id: "phase14-hermes-cli",
			command: "/Users/chenglong/.local/bin/hermes",
			python_command: "/Users/chenglong/.hermes/hermes-agent/venv/bin/python",
			model: MODEL,
			provider: PROVIDER,
			home_dir: "/Users/chenglong",
			timeout_ms: 90_000,
		});
		const result = await adapter.execute(requestFor(task));
		const observation = adapter.getLastObservation();
		const identity = observation?.runtime_identity ?? null;
		const identityPass = Boolean(
			result.status === "success" &&
			identity?.pph_run_id === RUN_ID &&
			identity.hermes_session_id &&
			identity.hermes_task_id &&
			identity.api_call_count >= 1 &&
			identity.provider === PROVIDER &&
			identity.configured_model === MODEL &&
			identity.response_model === MODEL &&
			identity.base_url_host === "127.0.0.1" &&
			identity.identity_source === "post_api_request.response_model" &&
			identity.source_event === "post_api_request" &&
			identity.finish_reason,
		);
		const baseline = JSON.parse(
			readFileSync(join(repo, "docs/stage-gates/evidence/phase-12-real-heterogeneous-2026-09-15.json"), "utf8"),
		);
		const piBaseline = findPiObservation(baseline);
		const heterogeneousPass =
			Boolean(piBaseline) &&
			observation?.backend === "hermes-cli" &&
			observation.provider === "custom" &&
			piBaseline.backend !== observation.backend &&
			piBaseline.provider !== observation.provider;
		const evidenceTypes = ["worker_result"];
		if (identityPass) evidenceTypes.push("hermes_identity", "hermes_receipt");
		if (heterogeneousPass) evidenceTypes.push("heterogeneous_backend");
		const identityCommandPass = Boolean(identityPass && heterogeneousPass && result.work_receipt?.no_op);
		const evidence = new EvidenceCollector().collect({
			task_id: TASK_ID,
			run_id: RUN_ID,
			changed_files: result.changed_files,
			commands: [
				{
					command: "phase14-hermes-identity-shape",
					exit_code: identityCommandPass ? 0 : 1,
					stdout: identityCommandPass ? "sanitized same-run identity shape verified" : "identity shape not verified",
					stderr: "",
				},
			],
			test_result: "real Hermes CLI synthetic Worker execution completed through Adapter",
			artifacts: [],
			evidence_types: evidenceTypes,
		});
		const snapshot = captureWorkspaceSnapshot("phase14-hermes-e2e", [], []);
		const verification = await new VerificationEngine().verify({
			task,
			evidence,
			snapshot,
			workerStatus: result.status,
			result,
		});
		const resultContractDigest = jsonDigest(result);
		const workReceiptDigest = result.work_receipt ? jsonDigest(result.work_receipt) : null;
		const evidenceRecordDigest = jsonDigest(evidence);
		const verificationDigest = jsonDigest(verification);
		const phase14Pass =
			identityPass &&
			heterogeneousPass &&
			result.status === "success" &&
			result.changed_files.length === 0 &&
			result.artifacts.length === 0 &&
			result.work_receipt?.no_op === true &&
			verification.status === "PASS";
		const evidenceDocument = {
			schema_version: "1.0",
			phase: "Phase 14",
			stage: "T14.2",
			captured_at: new Date().toISOString(),
			evidence_base_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
			baseline: {
				architecture_sha256: "31386a4490498665fbea0d580826acf11f767699a4b991ab03b49b930dc06480",
				task_list_sha256: "a48607de82aca989df6279c3b80d6ca27d58032558dcf3c75092eb3b8c24e99b",
			},
			safety_boundary: {
				data_class: "synthetic_public_conformance_only",
				provider_allowlist: ["custom"],
				repository_data_sent: false,
				resolved_context_sent: false,
				credentials_read_or_recorded: false,
				worker_tools_allowed: [],
				actions_requested: [],
				external_side_effects: false,
				auth_action: "none; existing Hermes runtime authentication was used without inspecting credentials",
			},
			run: {
				task_id: TASK_ID,
				pph_run_id: RUN_ID,
				worker_id: "phase14-hermes-cli",
				adapter_backend: "hermes-cli",
				provider_route: "custom@127.0.0.1",
				requested_model: MODEL,
				platform_accepted_model: observation?.platform_accepted_model ?? null,
				observed_runtime_model: observation?.observed_runtime_model ?? null,
				cli_version: identity?.cli_version ?? null,
				hermes_session_id: identity?.hermes_session_id ?? null,
				hermes_task_id: identity?.hermes_task_id ?? null,
				request_id: identity?.request_id ?? null,
				response_id: identity?.response_id ?? null,
				identity_source: identity?.identity_source ?? null,
				source_event: identity?.source_event ?? null,
				api_call_count: identity?.api_call_count ?? null,
				started_at: identity?.started_at ?? null,
				ended_at: identity?.ended_at ?? null,
				finish_reason: identity?.finish_reason ?? null,
				api_mode: identity?.api_mode ?? null,
				base_url_host: identity?.base_url_host ?? null,
				usage: identity?.usage ?? null,
				prompt_response_captured: false,
				result_status: result.status,
				result_contract_digest: resultContractDigest,
				result_digest: observation?.result_digest ?? null,
				work_receipt_digest: observation?.work_receipt_digest ?? workReceiptDigest,
				evidence_digest: observation?.evidence_digest ?? evidenceRecordDigest,
				evidence_record_digest: evidenceRecordDigest,
				verification_id: verification.id,
				verification_digest: verificationDigest,
			},
			result_receipt_evidence_verification: {
				result_status: result.status,
				changed_files: result.changed_files,
				artifacts: result.artifacts,
				work_receipt: result.work_receipt
					? {
						work_attempted: result.work_receipt.work_attempted,
						effects_count: result.work_receipt.effects_count,
						state_changed: result.work_receipt.state_changed,
						no_op: result.work_receipt.no_op,
						no_op_reason_present: Boolean(result.work_receipt.no_op_reason),
						evidence_ref_count: result.work_receipt.evidence_refs.length,
					}
					: null,
				evidence_id: evidence.id,
				evidence_types: evidence.evidence_types,
				verification_status: verification.status,
				verification_confidence: verification.verification_confidence,
				verification_checks: verification.checks,
			},
			identity_attestation: {
				pph_run_id_equals_hermes_event_run_id: identity?.pph_run_id === RUN_ID,
				hermes_session_id_present: Boolean(identity?.hermes_session_id),
				hermes_task_id_present: Boolean(identity?.hermes_task_id),
				response_side_model_equals_requested: identity?.response_model === MODEL,
				configured_model_not_used_as_observed_identity: true,
				provider_backend_observed_in_same_event: identity?.provider === PROVIDER,
				api_request_event_count_positive: (identity?.api_call_count ?? 0) > 0,
			},
			heterogeneous_backend_comparison: {
				current: {
					adapter_backend: "hermes-cli",
					provider: observation?.provider ?? null,
					base_url_host: identity?.base_url_host ?? null,
					observed_runtime_model: observation?.observed_runtime_model ?? null,
				},
				phase12_pi_baseline_evidence: "docs/stage-gates/evidence/phase-12-real-heterogeneous-2026-09-15.json",
				baseline: piBaseline
					? {
						backend: piBaseline.backend,
						provider: piBaseline.provider,
						observed_runtime_model: piBaseline.observed_runtime_model,
					}
					: null,
				different_adapter_backend: Boolean(piBaseline && piBaseline.backend !== observation?.backend),
				different_provider_route: Boolean(piBaseline && piBaseline.provider !== observation?.provider),
			},
			boundary_attestation: {
				phase12_phase13_retested_or_redefined: false,
				controller_dag_verification_persistent_state_files_touched: [],
				phase14_code_scope: [
					"packages/personal-pi/src/adapters/hermes-cli.ts",
					"packages/personal-pi/adapters/hermes-cli.ts",
					"packages/personal-pi/examples/worker-plugins/hermes-cli-custom.plugin_manifest.yaml",
					"packages/personal-pi/scripts/hermes-worker-bridge.py",
					"packages/personal-pi/test/hermes-cli-adapter.test.ts",
					"packages/personal-pi/scripts/phase-14-hermes-e2e.mjs",
				],
				core_boundaries_untouched: [
					"Controller",
					"DAG",
					"Verification implementation",
					"Persistent State implementation",
				],
			},
			gate_checks: {
				real_hermes_cli_execution: result.status === "success",
				same_run_pph_hermes_binding: identityPass,
				response_side_runtime_model: identity?.response_model === MODEL,
				provider_backend_identity: identity?.provider === PROVIDER,
				result_receipt_evidence_verification: verification.status === "PASS",
				heterogeneous_backend: heterogeneousPass,
				no_tool_or_action_escalation: result.evidence.includes("policy_refusal") === false,
				no_workspace_effect: result.changed_files.length === 0 && result.artifacts.length === 0,
			},
			phase14_t14_2: phase14Pass ? "PASS" : "NOT_READY",
			phase14_overall: phase14Pass ? "PASS" : "NOT_READY",
			phase12: "PASS_UNCHANGED",
			phase13_t13_4: "PASS_UNCHANGED",
			p0_multi_worker_mvp: "PASS_UNCHANGED",
			known_external_gaps: {
				GAP_01_codex_runtime_identity: "OPEN_NON_BLOCKING",
				GAP_03_agy_runtime_identity: "OPEN_NON_BLOCKING",
			},
		};
		mkdirSync(resolve(outputPath, ".."), { recursive: true });
		writeFileSync(outputPath, `${JSON.stringify(evidenceDocument, null, 2)}\n`, "utf8");
		console.log(
			JSON.stringify({
				phase14_t14_2: evidenceDocument.phase14_t14_2,
				phase14_overall: evidenceDocument.phase14_overall,
				result: result.status,
				verification: verification.status,
				identity_source: identity?.identity_source ?? null,
				observed_runtime_model: observation?.observed_runtime_model ?? null,
				provider: observation?.provider ?? null,
				output: outputPath,
			}),
		);
		if (!phase14Pass) process.exitCode = 2;
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

await main();
