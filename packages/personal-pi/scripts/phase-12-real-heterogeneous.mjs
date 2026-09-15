import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CodexCliWorkerAdapter,
	PersonalPiPipeline,
	PiAgentWorkerAdapter,
	PersistentStateStore,
	ReferenceArchitecturePlaybook,
	WorkerPool,
	WorkerRegistry,
	captureWorkspaceSnapshot,
	createPlanApproval,
	parseWorkerPluginManifest,
	validateResultContract,
} from "../dist/index.js";

const repo = process.cwd();
const scriptPath = fileURLToPath(import.meta.url);
const evidenceBaseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const fixedProviderInputTokens = 29_705;
const pphProjectedInputBudget = 1_500;
const effectiveProviderInputBudget = fixedProviderInputTokens + pphProjectedInputBudget;
const temporaryRoots = [];
const cases = [
	["json-shape", "Return a compact JSON object with keys alpha and beta; use values 1 and 2."],
	["list-order", "Return the exact ordered list [\"one\",\"two\",\"three\"] in the summary."],
	["bounded-explanation", "Explain in one short sentence why a read-only task has no workspace effect."],
	["contract-fields", "State that the controller, not the Worker, owns permissions and model choice."],
	["verification-note", "Return a short note saying that an independent verifier must check the result."],
];

const manifestText = (name) => readFileSync(join(repo, "packages/personal-pi/examples/worker-plugins", name), "utf8");
const manifestA = parseWorkerPluginManifest(manifestText("pi-agent-deepseek-v4-flash.plugin_manifest.yaml"));
const manifestB = parseWorkerPluginManifest(manifestText("codex-cli-existing-session.plugin_manifest.yaml"));
if (!manifestA.valid || !manifestA.value || !manifestB.valid || !manifestB.value)
	throw new Error("real heterogeneous runner could not parse static Worker manifests");

function safeChildEnvironment() {
	const environment = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		LANG: "C",
		LC_ALL: "C",
		NO_COLOR: "1",
	};
	if (process.env.HOME) environment.HOME = process.env.HOME;
	if (process.env.CODEX_HOME) environment.CODEX_HOME = process.env.CODEX_HOME;
	return environment;
}

function codexRuntimeMetadata() {
	let binary = null;
	let version = null;
	let loginStatus = "unavailable";
	try {
		binary = execFileSync("which", ["codex"], { cwd: repo, encoding: "utf8", env: safeChildEnvironment() }).trim();
	} catch {
		// Keep the metadata explicit and secret-free when PATH lookup fails.
	}
	try {
		version = execFileSync("codex", ["--version"], {
			cwd: repo,
			encoding: "utf8",
			env: safeChildEnvironment(),
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// A missing version is a hard evidence gap, not an inferred value.
	}
	try {
		execFileSync("codex", ["login", "status"], {
			cwd: repo,
			env: safeChildEnvironment(),
			stdio: ["ignore", "ignore", "ignore"],
		});
		loginStatus = "authenticated_or_session_available";
	} catch {
		loginStatus = "not_available_or_unauthenticated";
	}
	return { binary, version, login_status: loginStatus };
}

function runLocalConformance() {
	try {
		execFileSync("npm", ["exec", "--workspace", "@personal-pi/core", "vitest", "--", "run", "test/cli-adapters.test.ts"], {
			cwd: repo,
			env: safeChildEnvironment(),
			stdio: ["ignore", "ignore", "ignore"],
		});
		return { status: "PASS", command: "npm exec --workspace @personal-pi/core vitest -- run test/cli-adapters.test.ts" };
	} catch {
		return { status: "FAIL", command: "npm exec --workspace @personal-pi/core vitest -- run test/cli-adapters.test.ts" };
	}
}

function requirementFor(delivery) {
	return {
		user: "Personal PI owner",
		data_sources: ["synthetic public conformance prompt"],
		permission_location: ["Task Contract"],
		delivery,
		acceptance: ["the independent verifier accepts the structured Worker result"],
		constraints: ["no tools", "no workspace mutation", "no network", "no credentials", "bounded process"],
		unknowns: ["Codex CLI may not echo runtime model identity"],
		sustainability: ["replayable sanitized Evidence"],
		non_functional: ["bounded execution"],
		commercialization: ["internal harness conformance"],
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
	open_risks: ["Codex runtime model identity may be unknown"],
	playbook_refs: ["phase-12-real-heterogeneous"],
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
			{ id: "phase-12-real-heterogeneous", task_types: [task.type], clauses: ["same bounded Task Contract"] },
		]),
	};
}

function taskIdFor(caseDefinition) {
	return `phase12-${caseDefinition[0]}`;
}

function taskFor(caseDefinition, mode, recordPath) {
	const [caseId, objective] = caseDefinition;
	const verificationCommand = `phase12-independent-verifier:${recordPath}`;
	return {
		id: taskIdFor(caseDefinition),
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: `Phase 12 heterogeneous ${caseId}`,
		objective,
		requirements: ["Return exactly one structured Result Contract with a legal no-op Work Receipt"],
		constraints: ["Do not call tools", "Do not modify files", "Use only the selected Worker backend"],
		scope: { files: [] },
		inputs: {},
		data_sources: ["synthetic public conformance prompt"],
		data_references: [],
		permissions: {
			filesystem: { read: [], write: [] },
			shell: { allowed: ["node"] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "cli",
			worker_tier: "standard",
			reasoning_depth: "high",
			capability_tags: ["coding"],
			mode,
			working_directory: repo,
			allowed_tools: [],
			idempotency_key: `phase12:${caseId}`,
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["structured Result Contract and Work Receipt"],
		acceptance_criteria: ["the independent verifier accepts the selected Worker result"],
		verification: {
			strategy: "automated",
			commands: [verificationCommand],
			checks: ["Result Contract identity", "Work Receipt", "independent verifier"],
			evidence_required: ["independent_command"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 1_000 } },
		risk: "low",
		priority: "P1",
		timeout: 90_000,
		retry_policy: { max_attempts: 1, backoff: 0 },
		loop_budget: {
			max_attempts: 1,
			max_model_calls: 2,
			max_tool_calls: 1,
			max_handoffs: 0,
			max_elapsed_ms: 90_000,
			max_input_tokens: pphProjectedInputBudget,
			max_output_tokens: 1_000,
			max_cost_usd: 1,
			max_state_growth_bytes: 200_000,
			on_exhaustion: { action: "BLOCKED", escalation: "human" },
		},
		approval: { required: false },
	};
}

function recordingAdapter(delegate, root) {
	return {
		worker_id: delegate.worker_id,
		backend: delegate.backend,
		async execute(request, controls) {
			const result = await delegate.execute(request, controls);
			const recordPath = join(root, `${request.task.id}.json`);
			const safeResult = {
				task_id: result.task_id,
				run_id: result.run_id,
				worker_id: result.worker_id,
				lease_epoch: result.lease_epoch,
				status: result.status,
				changed_files: result.changed_files,
				artifacts: result.artifacts,
				work_receipt: result.work_receipt,
			};
			writeFileSync(recordPath, JSON.stringify(safeResult), "utf8");
			return result;
		},
		getLastObservation() {
			return delegate.getLastObservation?.();
		},
	};
}

function independentVerify(recordPath, taskId, workerId, command) {
	try {
		const stdout = execFileSync(process.execPath, [scriptPath, "--verify", recordPath, taskId, workerId], {
			cwd: repo,
			encoding: "utf8",
			env: safeChildEnvironment(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { command, exit_code: 0, stdout: stdout.trim(), stderr: "" };
	} catch (error) {
		return {
			command,
			exit_code: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message.slice(0, 512) : "independent verifier failed",
		};
	}
}

function registerWorkers(registry, pool, root) {
	const typeADelegate = new PiAgentWorkerAdapter({
		worker_id: "phase12-type-a-pi-agent",
		timeout_ms: 90_000,
	});
	const typeBDelegate = new CodexCliWorkerAdapter({
		worker_id: "phase12-type-b-codex-cli",
		timeout_ms: 90_000,
		provider_fixed_input_tokens: fixedProviderInputTokens,
	});
	const typeA = recordingAdapter(typeADelegate, root);
	const typeB = recordingAdapter(typeBDelegate, root);
	registry.register({
		worker_id: typeA.worker_id,
		worker_type: "pi",
		manifest: manifestA.value,
		adapter: typeA,
		capabilities: { languages: ["typescript"], latency_ms: 120 },
	});
	registry.register({
		worker_id: typeB.worker_id,
		worker_type: "codex",
		manifest: manifestB.value,
		adapter: typeB,
		capabilities: { languages: ["typescript"], latency_ms: 180 },
	});
	pool.register({ worker_id: typeA.worker_id, kind: "cli_ephemeral_worker", adapter: typeA });
	pool.register({ worker_id: typeB.worker_id, kind: "cli_ephemeral_worker", adapter: typeB });
	return { typeA, typeB };
}

function selectionProof(registry, task) {
	const runs = Array.from({ length: 3 }, () => registry.selectCandidates(task).map((candidate) => candidate.worker_id));
	const restrictedA = { ...task, execution: { ...task.execution, worker_type: "pi" } };
	const restrictedB = { ...task, execution: { ...task.execution, worker_type: "codex" } };
	const candidates = registry.selectCandidates(task);
	return {
		candidate_order: runs[0] ?? [],
		stable_across_three_reads: runs.every((run) => JSON.stringify(run) === JSON.stringify(runs[0] ?? [])),
		candidate_count: candidates.length,
		candidates: candidates.map((candidate) => ({
			worker_id: candidate.worker_id,
			worker_type: candidate.worker_type,
			manifest_id: candidate.registration.manifest.worker_plugin.id,
			adapter_backend: candidate.registration.adapter.backend ?? "unknown",
		})),
		selection_by_explicit_worker_type: {
			pi: registry.select(restrictedA).worker_id,
			codex: registry.select(restrictedB).worker_id,
		},
	};
}

function summarizeRecord(caseDefinition, workerId, execution, adapter) {
	const result = execution?.result;
	const validation = result ? validateResultContract(result) : { valid: false };
	const observation = adapter?.getLastObservation?.() ?? null;
	return {
		case_id: caseDefinition[0],
		worker_id: workerId,
		task_state: execution?.task.state ?? "ERROR",
		result_status: result?.status ?? "ERROR",
		verification_status: execution?.verification.status ?? "UNKNOWN",
		result_identity: result
			? {
				valid: validation.valid,
				task_id: result.task_id,
				run_id: result.run_id,
				worker_id: result.worker_id,
				lease_epoch: result.lease_epoch,
			}
			: null,
		work_receipt: result?.work_receipt
			? {
				valid: validation.valid,
				no_op: result.work_receipt.no_op,
				effects_count: result.work_receipt.effects_count,
				state_changed: result.work_receipt.state_changed,
			}
			: null,
		result_errors: result?.errors ?? [],
		evidence: result?.evidence ?? [],
		trace_outcome: execution?.trace.outcome ?? "ERROR",
		trace_metrics: execution?.trace.metrics.graph_efficiency ?? null,
		observation,
	};
}

function modeMetrics(mode, records, elapsedMs) {
	const verified = records.filter((record) => record.task_state === "DONE");
	const handoffs = records.reduce((sum, record) => sum + (record.trace_metrics?.handoff_count ?? 0), 0);
	const retries = records.reduce((sum, record) => sum + (record.trace_metrics?.retry_depth ?? 0), 0);
	const agentCalls = records.reduce((sum, record) => sum + (record.observation?.model_calls ?? 0), 0);
	const knownCosts = verified.every((record) => typeof record.observation?.cost_usd === "number");
	const totalCost = verified.reduce((sum, record) => sum + (record.observation?.cost_usd ?? 0), 0);
	const firstPass = records.filter(
		(record) => record.task_state === "DONE" && record.verification_status === "PASS" && (record.trace_metrics?.retry_depth ?? 0) === 0,
	).length;
	const byBackend = new Map();
	for (const record of records) {
		const observation = record.observation;
		if (!observation) continue;
		const key = observation.backend;
		const current = byBackend.get(key) ?? {
			backend: key,
			worker_ids: [],
			requested_models: [],
			platform_accepted_models: [],
			observed_runtime_models: [],
			providers: [],
			session_id_sha256: [],
			provider_input_tokens: 0,
			output_tokens: 0,
			cost_usd: 0,
			cost_available: true,
			pph_projected_input_tokens: 0,
		};
		current.worker_ids = [...new Set([...current.worker_ids, record.worker_id])];
		current.requested_models = [...new Set([...current.requested_models, observation.requested_model])];
		current.platform_accepted_models = [...new Set([...current.platform_accepted_models, observation.platform_accepted_model])];
		current.observed_runtime_models = [...new Set([...current.observed_runtime_models, observation.observed_runtime_model])];
		current.providers = [...new Set([...current.providers, observation.provider])];
		if (observation.session_id_sha256) current.session_id_sha256.push(observation.session_id_sha256);
		current.provider_input_tokens += observation.input_tokens ?? 0;
		current.output_tokens += observation.output_tokens ?? 0;
		current.pph_projected_input_tokens += observation.input_accounting?.pph_projected_input_tokens ?? 0;
		if (observation.cost_usd === null) current.cost_available = false;
		else current.cost_usd += observation.cost_usd;
		byBackend.set(key, current);
	}
	for (const value of byBackend.values()) value.session_id_sha256 = [...new Set(value.session_id_sha256)];
	return {
		mode,
		worker_count: new Set(records.map((record) => record.worker_id)).size,
		verified_success_rate: verified.length / Math.max(1, records.length),
		time_per_verified_task: elapsedMs / Math.max(1, verified.length),
		cost_per_verified_task: verified.length > 0 && knownCosts ? totalCost / verified.length : null,
		cost_unavailable: verified.length === 0 || !knownCosts,
		handoffs,
		retries,
		verification_first_pass_rate: firstPass / Math.max(1, records.length),
		coordination_efficiency: verified.length / Math.max(1, handoffs + retries + agentCalls),
		graph_width: mode === "heterogeneous_multi" ? 2 : 1,
		peak_active_workers: mode === "heterogeneous_multi" ? 2 : 1,
		provider_model_token_usage: [...byBackend.values()],
	};
}

async function runMode(mode, assignments, caseDefinitions) {
	const root = mkdtempSync(join(tmpdir(), `pph-phase12-${mode}-`));
	temporaryRoots.push(root);
	const registry = new WorkerRegistry();
	const pool = new WorkerPool();
	const adapters = registerWorkers(registry, pool, root);
	pool.warmAll();
	const sampleTask = taskFor(caseDefinitions[0] ?? cases[0], mode === "heterogeneous_multi" ? "parallel" : "single", join(root, "selection.json"));
	const selection = selectionProof(registry, sampleTask);
	const store = new PersistentStateStore(join(root, "state.json"));
	const pipeline = new PersonalPiPipeline({ state_store: store });
	const startedAt = performance.now();
	const executeCase = async (caseDefinition, index) => {
		const workerId = assignments[index];
		const adapter = registry.get(workerId)?.adapter;
		if (!adapter) return { case_id: caseDefinition[0], worker_id: workerId, task_state: "ERROR", error: "unregistered worker" };
		const recordPath = join(root, `${taskIdFor(caseDefinition)}.json`);
		const task = taskFor(
			caseDefinition,
			mode === "heterogeneous_multi" ? "parallel" : "single",
			recordPath,
		);
		const poolLease = pool.acquire(task.id, [workerId]);
		pool.markBusy(poolLease);
		try {
			const execution = await pipeline.execute({
				...planFor(task),
				requirement: requirementFor(`verified ${caseDefinition[0]} result`),
				task,
				worker: adapter,
				command_runner: (verificationCommand) => independentVerify(recordPath, task.id, workerId, verificationCommand),
				snapshot: captureWorkspaceSnapshot(evidenceBaseSha, [], []),
				current_snapshot: captureWorkspaceSnapshot(evidenceBaseSha, [], []),
			});
			return summarizeRecord(caseDefinition, workerId, execution, adapter);
		} catch (error) {
			return {
				case_id: caseDefinition[0],
				worker_id: workerId,
				task_state: "ERROR",
				result_status: "ERROR",
				verification_status: "UNKNOWN",
				error: error instanceof Error ? error.message.slice(0, 512) : "pipeline execution failed",
			};
		} finally {
			pool.release(poolLease);
		}
	};
	const records = [];
	if (mode === "heterogeneous_multi") {
		for (let index = 0; index < caseDefinitions.length; index += 2) {
			const batch = await Promise.all(
				caseDefinitions.slice(index, index + 2).map((item, offset) => executeCase(item, index + offset)),
			);
			records.push(...batch);
		}
	} else {
		for (let index = 0; index < caseDefinitions.length; index += 1) records.push(await executeCase(caseDefinitions[index], index));
	}
	const elapsedMs = Math.max(1, performance.now() - startedAt);
	return {
		mode,
		selection,
		case_ids: caseDefinitions.map(([caseId]) => caseId),
		assignments,
		records,
		metrics: modeMetrics(mode, records, elapsedMs),
	};
}

function verifyRecord() {
	const [, , mode, recordPath, taskId, workerId] = process.argv;
	if (mode !== "--verify") {
		process.exitCode = 1;
		return;
	}
	try {
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		const receipt = record.work_receipt;
		const valid =
			record.task_id === taskId &&
			record.worker_id === workerId &&
			record.status === "success" &&
			Array.isArray(record.changed_files) &&
			record.changed_files.length === 0 &&
			Array.isArray(record.artifacts) &&
			record.artifacts.length === 0 &&
			receipt?.no_op === true &&
			receipt.effects_count === 0 &&
			receipt.state_changed === false &&
			typeof receipt.no_op_reason === "string" &&
			receipt.no_op_reason.length > 0;
		if (!valid) process.exitCode = 1;
		process.stdout.write(valid ? "phase12-independent-verifier:PASS\n" : "phase12-independent-verifier:FAIL\n");
	} catch {
		process.exitCode = 1;
		process.stdout.write("phase12-independent-verifier:ERROR\n");
	}
}

async function main() {
	const conformance = runLocalConformance();
	const runtime = codexRuntimeMetadata();
	const beforeClean = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() === "";
	let smoke = null;
	let single = null;
	let heterogeneous = null;
	if (conformance.status === "PASS") {
		smoke = await runMode("type-b-smoke", ["phase12-type-b-codex-cli"], [cases[0]]);
		const smokePassed = smoke.metrics.verified_success_rate === 1;
		if (smokePassed) {
			single = await runMode(
				"single",
				Array.from({ length: cases.length }, () => "phase12-type-a-pi-agent"),
				cases,
			);
			heterogeneous = await runMode(
				"heterogeneous_multi",
				[
					"phase12-type-a-pi-agent",
					"phase12-type-b-codex-cli",
					"phase12-type-a-pi-agent",
					"phase12-type-b-codex-cli",
					"phase12-type-a-pi-agent",
				],
				cases,
			);
		}
	}
	const bRecords = [
		...(smoke?.records ?? []),
		...(heterogeneous?.records ?? []).filter((record) => record.worker_id === "phase12-type-b-codex-cli"),
	];
	const bModelUnknown = bRecords.some((record) => record.observation?.observed_runtime_model === null);
	const allBenchmarkDone =
		single?.metrics.verified_success_rate === 1 && heterogeneous?.metrics.verified_success_rate === 1;
	const bothCandidates =
		heterogeneous?.selection.candidate_count === 2 &&
		heterogeneous.selection.stable_across_three_reads &&
		heterogeneous.selection.selection_by_explicit_worker_type.pi === "phase12-type-a-pi-agent" &&
		heterogeneous.selection.selection_by_explicit_worker_type.codex === "phase12-type-b-codex-cli";
	const typeBBackendAudited =
		bRecords.length > 0 &&
		bRecords.every(
			(record) =>
				record.observation?.backend === "codex-cli" &&
				record.observation?.session_id_sha256 &&
				record.observation?.input_accounting?.mode === "fixed_overhead_calibrated",
		);
	const phase12Status = conformance.status === "PASS" && allBenchmarkDone && bothCandidates && typeBBackendAudited
		? bModelUnknown
			? "PASS_EXECUTION_MODEL_IDENTITY_UNKNOWN"
			: "PASS"
		: "BLOCKED_EXTERNAL";
	const afterClean = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() === "";
	const result = {
		schema_version: "1.0",
		captured_at: new Date().toISOString(),
		purpose: "Phase 12 real heterogeneous Worker closure; T13 excluded",
		repository: {
			path: repo,
			branch: execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim(),
			evidence_base_sha: evidenceBaseSha,
			working_tree_clean_before_runner: beforeClean,
			working_tree_clean_after_runner: afterClean,
		},
		safety_boundary: {
			data_class: "synthetic_public_conformance_only",
			provider_allowlist: ["openai-codex-cli", "opencodex-synthetic-only"],
			repository_data_sent: false,
			credentials_read_or_recorded: false,
			external_side_effects: false,
			reset_credits_consumed: 0,
			account_switch_or_login_performed: false,
		},
		codex_runtime: {
			backend: "codex-cli",
			binary: runtime.binary,
			version: runtime.version,
			login_status: runtime.login_status,
			requested_model: "gpt-5.6-sol",
			platform_accepted_model: "unknown",
			observed_runtime_model: bModelUnknown ? "unknown" : "captured_in_events",
			session_evidence: "per-run session_id_sha256 is recorded below; raw thread/session identifiers are not recorded",
		},
		input_accounting: {
			measurement: {
				provider_fixed_input_tokens: fixedProviderInputTokens,
				source: "current-session minimal real codex exec --json probe after manual session switch",
				probe_observed_input_tokens: 29_705,
				probe_observed_output_tokens: 11,
				probe_runtime_model: "unknown",
			},
				pph_projected_input_budget: pphProjectedInputBudget,
				effective_provider_input_budget: effectiveProviderInputBudget,
				rationale: "Keep provider-reported total; subtract only the explicitly measured fixed baseline for PPH task admission; fail closed without calibration.",
		},
		conformance: {
			local_type_b_adapter_tests: conformance,
			coverage: ["normal success", "permission boundary", "structured/invalid output", "timeout", "budget admission", "receipt/result identity"],
			real_type_b_smoke: smoke
				? { status: smoke.metrics.verified_success_rate === 1 ? "PASS" : "FAIL", records: smoke.records }
				: "NOT_RUN",
		},
		registry_selection: heterogeneous?.selection ?? smoke?.selection ?? null,
		benchmark: {
			case_set: cases.map(([caseId, objective]) => ({ case_id: caseId, objective })),
			single_worker_baseline: single,
			heterogeneous_multi: heterogeneous,
			metrics_note: "No superiority claim; metrics are reported from the bounded sample. Cost is null when the runtime did not return cost.",
		},
		phase_gate: {
			status: phase12Status,
			type_a_backend: "pi-agent/opencodex/ArkCoding-deepseek-v4-flash-ga-260731",
			type_b_backend: "codex-cli/current authenticated session",
			model_identity_limit: bModelUnknown ? "Type B observed_runtime_model=unknown; no model guess was made" : null,
			t13_entered: false,
		},
		final_verdict: phase12Status === "PASS" ? "PHASE_12_PASS" : "PHASE_12_NOT_CLOSED",
	};
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	const serialized = `${JSON.stringify(result, null, 2)}\n`;
	if (process.argv[2] === "--output" && process.argv[3]) writeFileSync(process.argv[3], serialized, "utf8");
	process.stdout.write(serialized);
}

if (process.argv[2] === "--verify") verifyRecord();
else await main();
