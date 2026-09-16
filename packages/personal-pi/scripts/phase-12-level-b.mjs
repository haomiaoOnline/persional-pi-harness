import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BudgetController,
	LeaseManager,
	PersonalPiPipeline,
	PersistentStateStore,
	PiAgentWorkerAdapter,
	ProcessWorkerAdapter,
	ProviderResilienceController,
	ProviderResilientWorkerAdapter,
	ReferenceArchitecturePlaybook,
	WorkerPool,
	WorkerRegistry,
	auditBoundCoverage,
	captureWorkspaceSnapshot,
	createPlanApproval,
	createProtocolEnvelope,
	loadKnownExternalGapRegistry,
	parseWorkerPluginManifest,
	V3_FEEDBACK_PATHS,
} from "../dist/index.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const outputFlag = process.argv.indexOf("--output");
const outputArgument = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
const outputPath = outputArgument ? (isAbsolute(outputArgument) ? outputArgument : resolve(repo, outputArgument)) : undefined;
const evidenceBaseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const temporaryRoots = [];

function safeEnvironment() {
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

function boundedLoopBudget() {
	return {
		max_attempts: 2,
		max_model_calls: 2,
		max_tool_calls: 2,
		max_handoffs: 1,
		max_elapsed_ms: 60_000,
		max_input_tokens: 50_000,
		max_output_tokens: 2_000,
		max_cost_usd: 5,
		max_state_growth_bytes: 100_000,
		on_exhaustion: { action: "BLOCKED", escalation: "human" },
	};
}

function taskFor(id, workspace, action, overrides = {}) {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: `Phase 12 Level-B ${id}`,
		objective: "Execute a bounded synthetic public conformance action in an isolated Worker workspace",
		requirements: ["Return a valid Result Contract with an observable or explicitly legal no-op Work Receipt"],
		constraints: ["synthetic public data", "no credentials", "no shared workspace"],
		scope: { files: [`tmp/${id}.txt`] },
		inputs: { level_b_action: action },
		data_sources: ["synthetic public conformance input"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: ["tmp"] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "high",
			capability_tags: ["coding"],
			mode: "parallel",
			working_directory: workspace,
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["verified synthetic Worker output"],
		acceptance_criteria: ["independent verification accepts the result"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["Result Contract", "Work Receipt"],
			evidence_required: [],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 50_000 } },
		risk: "low",
		priority: "P1",
		timeout: 60_000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		loop_budget: boundedLoopBudget(),
		approval: { required: false },
		...overrides,
	};
}

function requestFor(task, epoch, runId = `run-${task.id}-${epoch}`) {
	return { task, protocol: createProtocolEnvelope(task, epoch), run_id: runId };
}

function processWorker(root, workerId) {
	return new ProcessWorkerAdapter({
		worker_id: workerId,
		worker_instance_id: `level-b-instance-${workerId}`,
		adapter_id: "pi-same-adapter",
		workspace_path: join(root, workerId),
		timeout_ms: 2_000,
	});
}

function planFor(task) {
	const assessment = {
		scalability: "bounded",
		security: "least privilege",
		cost: "bounded",
		extensibility: "contract based",
		testability: "automated",
		business_viability: "internal conformance",
		confidence: 0.9,
		open_risks: [],
		playbook_refs: ["phase-12-level-b"],
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
			{ id: "phase-12-level-b", task_types: [task.type], clauses: ["same bounded Task Contract"] },
		]),
	};
}

function requirementFor(delivery) {
	return {
		user: "Personal PI owner",
		data_sources: ["synthetic public conformance input"],
		permission_location: ["Task Contract"],
		delivery,
		acceptance: ["independent verifier accepts the Result Contract"],
		constraints: ["no credentials", "no shared workspace", "bounded process"],
		unknowns: ["external Provider may be unavailable"],
		sustainability: ["replayable sanitized Evidence"],
		non_functional: ["process isolation", "bounded execution"],
		commercialization: ["internal harness conformance"],
	};
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
	};
}

async function runRealProviderPair(root) {
	const workspaceA = mkdtempSync(join(root, "pi-provider-a-"));
	const workspaceB = mkdtempSync(join(root, "pi-provider-b-"));
	const adapterA = new PiAgentWorkerAdapter({ worker_id: "pi-provider-a", timeout_ms: 90_000 });
	const adapterB = new PiAgentWorkerAdapter({ worker_id: "pi-provider-b", timeout_ms: 90_000 });
	const controller = new ProviderResilienceController();
	controller.register({
		provider_id: "opencodex",
		rate_limit: { max_requests: 2, interval_ms: 60_000 },
		quota_limit: 2,
		failure_threshold: 3,
		cooldown_ms: 1_000,
	});
	const resilientA = new ProviderResilientWorkerAdapter({ adapter: adapterA, provider_id: "opencodex", controller });
	const resilientB = new ProviderResilientWorkerAdapter({ adapter: adapterB, provider_id: "opencodex", controller });
	const taskA = taskFor("real-provider-a", workspaceA, {}, {
		objective: "Return a short JSON object with summary text saying provider conformance A.",
		execution: { ...taskFor("real-provider-a", workspaceA, {}).execution, working_directory: workspaceA },
	});
	const taskB = taskFor("real-provider-b", workspaceB, {}, {
		objective: "Return a short JSON object with summary text saying provider conformance B.",
		execution: { ...taskFor("real-provider-b", workspaceB, {}).execution, working_directory: workspaceB },
	});

	async function run(adapter, baseAdapter, task) {
		const started = Date.now();
		let result;
		try {
			result = await adapter.execute(requestFor(task, 1), undefined);
		} catch {
			result = { status: "failure", task_id: task.id };
		}
		return {
			started_at: new Date(started).toISOString(),
			ended_at: new Date(Date.now()).toISOString(),
			status: result.status,
			admission_evidence: result.evidence?.filter((entry) => entry.startsWith("opencodex:")) ?? [],
			observation: safeObservation(baseAdapter.getLastObservation?.()),
		};
	}

	const [first, second] = await Promise.all([
		run(resilientA, adapterA, taskA),
		run(resilientB, adapterB, taskB),
	]);
	const observations = [adapterA.getLastObservation(), adapterB.getLastObservation()];
	const pids = observations.map((observation) => observation?.process_pid).filter((pid) => typeof pid === "number");
	const pass =
		[first, second].every((item) => item.status === "success") &&
		observations.every(
			(observation) =>
				observation?.provider === "opencodex" &&
				observation.observed_runtime_model === observation.requested_model &&
				typeof observation.process_pid === "number",
		) &&
		new Set(pids).size === 2 &&
		new Date(first.started_at).getTime() < new Date(second.ended_at).getTime() &&
		new Date(second.started_at).getTime() < new Date(first.ended_at).getTime() &&
		controller.status("opencodex").requests_used === 2;
	return {
		status: pass ? "PASS" : "NOT_READY",
		provider_id: "opencodex",
		requested_model: adapterA.requested_model,
		instances: [
			{ worker_instance_id: "pi-provider-instance-a", adapter_id: "pi-agent", workspace_path: workspaceA, ...safeObservation(observations[0]) },
			{ worker_instance_id: "pi-provider-instance-b", adapter_id: "pi-agent", workspace_path: workspaceB, ...safeObservation(observations[1]) },
		],
		executions: [first, second],
		quota: controller.status("opencodex"),
		session_isolation: "Pi adapter uses --no-session for each bounded execution; raw session identifiers are not recorded",
	};
}

async function main() {
	const gapRegistry = loadKnownExternalGapRegistry(join(repo, "docs/stage-gates/known_gaps.yaml"));
	const root = mkdtempSync(join(tmpdir(), "pph-phase12-level-b-"));
	temporaryRoots.push(root);
	const statePath = join(root, "state.json");
	const state = new PersistentStateStore(statePath);
	const leaseManager = new LeaseManager(state);
	const budget = new BudgetController(
		{ max_depth: 5, max_children_per_task: 8, max_total_open_tasks: 32, max_replan_count: 8 },
		{ max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
		{},
		{ store: state, scope: "phase-12-level-b" },
	);
	const adapterA = processWorker(root, "level-b-a");
	const adapterB = processWorker(root, "level-b-b");
	const pool = new WorkerPool({
		lease_manager: leaseManager,
		instance_store: state,
		coordination_budget: { max_active_workers: 2, max_handoffs_per_task: 2, max_concurrent_roles: 2 },
		budget_controller: budget,
	});
	pool.register({ worker_id: "level-b-a", kind: "local_process_worker", adapter: adapterA, idle_timeout_ms: 1 });
	pool.register({ worker_id: "level-b-b", kind: "local_process_worker", adapter: adapterB, idle_timeout_ms: 1 });
	const warmed = await pool.warmAllAsync();

	const manifest = parseWorkerPluginManifest(
		readFileSync(join(repo, "packages/personal-pi/examples/worker-plugins/pi-agent-deepseek-v4-flash.plugin_manifest.yaml"), "utf8"),
	);
	if (!manifest.valid || !manifest.value) throw new Error("could not load the static PI Worker manifest");
	const workerRegistry = new WorkerRegistry();
	workerRegistry.register({ worker_id: "level-b-a", worker_type: "pi", manifest: manifest.value, adapter: adapterA });
	workerRegistry.register({ worker_id: "level-b-b", worker_type: "pi", manifest: manifest.value, adapter: adapterB });
	const selectionTask = taskFor("selection", join(root, "selection"), {}, {
		execution: { ...taskFor("selection", join(root, "selection"), {}).execution, worker_tier: "standard", reasoning_depth: "high" },
	});
	const candidates = workerRegistry.selectCandidates(selectionTask).map((candidate) => candidate.worker_id);

	const duplicateClaims = await Promise.allSettled([pool.acquireAsync("duplicate-task"), pool.acquireAsync("duplicate-task")]);
	const duplicateLease = duplicateClaims.find((claim) => claim.status === "fulfilled")?.value;
	const duplicateRejected = duplicateClaims.filter((claim) => claim.status === "rejected").length === 1;
	if (duplicateLease) pool.release(duplicateLease);

	const [leaseA, leaseB] = await Promise.all([
		pool.acquireAsync("level-b-task-a", ["level-b-a"]),
		pool.acquireAsync("level-b-task-b", ["level-b-b"]),
	]);
	const taskA = taskFor("level-b-task-a", adapterA.workspace_path, { kind: "write", target: "tmp/a.txt", content: "worker-a", delay_ms: 250 });
	const taskB = taskFor("level-b-task-b", adapterB.workspace_path, { kind: "write", target: "tmp/b.txt", content: "worker-b", delay_ms: 250 });
	const [resultA, resultB] = await Promise.all([
		pool.execute(leaseA, requestFor(taskA, leaseA.lease.lease_epoch)),
		pool.execute(leaseB, requestFor(taskB, leaseB.lease.lease_epoch)),
	]);
	const executedA = pool.get("level-b-a");
	const executedB = pool.get("level-b-b");
	const independentProcessPass =
		warmed.every((snapshot) => typeof snapshot.pid === "number" && snapshot.pid > 0) &&
		warmed[0].pid !== warmed[1].pid &&
		warmed[0].adapter_id === warmed[1].adapter_id &&
		warmed[0].worker_instance_id !== warmed[1].worker_instance_id &&
		warmed[0].session_id !== warmed[1].session_id &&
		warmed[0].workspace_path !== warmed[1].workspace_path &&
		resultA.status === "success" &&
		resultB.status === "success" &&
		executedA?.loop_usage.elapsed_ms > 0 &&
		executedB?.loop_usage.elapsed_ms > 0 &&
		new Date(executedA.execution_started_at).getTime() < new Date(executedB.execution_ended_at).getTime() &&
		new Date(executedB.execution_started_at).getTime() < new Date(executedA.execution_ended_at).getTime();
	pool.setSessionContext("level-b-a", { marker: "clear-on-release" });
	pool.release(leaseA);
	pool.release(leaseB);

	const oldLease = await pool.acquireAsync("recovery-task", ["level-b-b"]);
	const oldTask = taskFor("recovery-task", adapterB.workspace_path, { kind: "sleep", delay_ms: 1_000 });
	const oldResultPromise = pool.execute(oldLease, requestFor(oldTask, oldLease.lease.lease_epoch));
	await new Promise((resolve) => setTimeout(resolve, 50));
	const crashPromise = adapterB.crash();
	const reclaimed = await pool.reclaim(oldLease, "intentional conformance crash");
	await crashPromise;
	const reassigned = await pool.acquireAsync("recovery-task", ["level-b-a"]);
	const staleRejection = await oldResultPromise.then(
		() => false,
		(error) => error?.message === "REJECTED_STALE_EPOCH",
	);
	const recoveryTask = taskFor("recovery-task", adapterA.workspace_path, { kind: "write", target: "tmp/recovered.txt", content: "reassigned" });
	const recoveryResult = await pool.execute(reassigned, requestFor(recoveryTask, reassigned.lease.lease_epoch));
	const recoveryPass =
		reclaimed &&
		reassigned.lease.lease_epoch === oldLease.lease.lease_epoch + 1 &&
		staleRejection &&
		recoveryResult.status === "success" &&
		pool.get("level-b-b")?.state === "DEAD";
	pool.release(reassigned);

	const pipelineTask = taskFor("pipeline-level-b", adapterA.workspace_path, { kind: "write", target: "tmp/pipeline.txt", content: "pipeline-verified" }, {
		verification: {
			strategy: "automated",
			commands: ["level-b-independent-verifier"],
			checks: ["Result Contract", "Work Receipt", "independent command"],
			evidence_required: ["independent_command"],
			strength: "strong",
		},
	});
	const pipeline = new PersonalPiPipeline({ state_store: state, lease_manager: new LeaseManager(state) });
	const pipelineSnapshot = captureWorkspaceSnapshot("phase-12-level-b", ["tmp/pipeline.txt"], []);
	const pipelineExecution = await pipeline.execute({
		task: pipelineTask,
		requirement: requirementFor("a Result→Receipt→Evidence→Verification revalidation"),
		worker: adapterA,
		requested_actions: [],
		...planFor(pipelineTask),
		snapshot: pipelineSnapshot,
		current_snapshot: pipelineSnapshot,
		command_runner: async (command) => ({
			command,
			exit_code: readFileSync(join(adapterA.workspace_path, "tmp/pipeline.txt"), "utf8") === "pipeline-verified" ? 0 : 1,
			stdout: "independent verifier observed pipeline-verified",
			stderr: "",
		}),
	});
	const resultReceiptVerificationPass =
		pipelineExecution.result.status === "success" &&
		pipelineExecution.result.work_receipt?.state_changed === true &&
		pipelineExecution.evidence.evidence_types.includes("independent_command") &&
		pipelineExecution.verification.status === "PASS" &&
		pipelineExecution.task.state === "DONE";

	const breaker = new ProviderResilienceController();
	breaker.register({
		provider_id: "controlled-provider",
		rate_limit: { max_requests: 3, interval_ms: 10_000 },
		failure_threshold: 2,
		cooldown_ms: 50,
	});
	const faultAdapter = new ProviderResilientWorkerAdapter({
		adapter: adapterA,
		provider_id: "controlled-provider",
		controller: breaker,
		response_status: () => 429,
	});
	await faultAdapter.execute(requestFor(taskFor("breaker-a", adapterA.workspace_path, { kind: "sleep" }), 1));
	await faultAdapter.execute(requestFor(taskFor("breaker-b", adapterA.workspace_path, { kind: "sleep" }), 1));
	const opened = breaker.status("controlled-provider");
	const blocked = await faultAdapter.execute(requestFor(taskFor("breaker-c", adapterA.workspace_path, { kind: "sleep" }), 1));
	const probe = breaker.admit("controlled-provider", { at: (opened.opened_until ?? 0) + 1 });
	if (probe.action === "ALLOW") breaker.recordResponse("controlled-provider", 200, (opened.opened_until ?? 0) + 1);
	const controlledBreakerPass =
		opened.state === "OPEN" &&
		blocked.status === "failure" &&
		blocked.evidence.includes("controlled-provider:admission=QUEUE") &&
		breaker.status("controlled-provider").state === "CLOSED";

	const realProvider = await runRealProviderPair(root);
	const boundCoverage = auditBoundCoverage(V3_FEEDBACK_PATHS);
	await pool.reapIdleAsync(0, Date.now() + 300_001);
	const persistedInstances = state.listWorkerInstances();
	const persistedLeasePass =
		state.read().leases &&
		state.read().lease_epochs["recovery-task"] === 2 &&
		persistedInstances.some((instance) => instance.worker_instance_id === "level-b-instance-level-b-a");

	const checks = {
		t0_3_known_external_gap_registry: gapRegistry.known_gaps.some(
			(gap) => gap.id === "GAP-01" && gap.resolution === "Phase 14 Multi-CRI" && gap.mvp_impact === "NON_BLOCKING",
		),
		registry_capability_selection: candidates.length === 2 && candidates.includes("level-b-a") && candidates.includes("level-b-b"),
		real_independent_worker_instances: independentProcessPass,
		atomic_lease_no_double_dispatch: duplicateRejected,
		persistent_lease_epoch_and_fencing: persistedLeasePass,
		lifecycle: warmed.every((snapshot) => snapshot.state === "IDLE") && recoveryPass,
		crash_recovery_reassign_stale_result: recoveryPass,
		workspace_session_context_isolation:
			pool.get("level-b-a")?.session_context !== undefined &&
			pool.get("level-b-a")?.session_context &&
			pool.get("level-b-a")?.workspace_path !== pool.get("level-b-b")?.workspace_path,
		coordination_budget: budget.read().usage.active_workers === 0 && budget.read().usage.concurrent_roles === 0,
		t12_6_controlled_quota_backpressure_breaker: controlledBreakerPass,
		t12_6_real_same_provider_multi_instance: realProvider.status === "PASS",
		result_receipt_verification_regression: resultReceiptVerificationPass,
		bound_coverage: boundCoverage.passed && boundCoverage.uncovered_paths.length === 0,
	};
	checks.workspace_session_context_isolation =
		pool.get("level-b-a")?.session_context !== undefined &&
		pool.get("level-b-a")?.workspace_path !== pool.get("level-b-b")?.workspace_path &&
		persistedInstances.some((instance) => instance.state === "DEAD");
	const phase12GatePass = Object.values(checks).every(Boolean);
	const evidence = {
		phase: "Phase 12",
		baseline: "v3.2",
		generated_at: new Date().toISOString(),
		evidence_base_sha: evidenceBaseSha,
		known_external_gap_registry: gapRegistry,
		worker_instances: persistedInstances,
		process_pool: {
			warmed,
			first_results: [resultA, resultB],
			execution_snapshots: [executedA, executedB],
			duplicate_claims: duplicateClaims.map((claim) => claim.status),
			workspaces: [adapterA.workspace_path, adapterB.workspace_path],
		},
		lease_recovery: {
			old_lease: oldLease.lease,
			reassigned_lease: reassigned.lease,
			reclaimed,
			stale_rejection: staleRejection,
			recovery_result_status: recoveryResult.status,
		},
		result_receipt_verification: {
			result_status: pipelineExecution.result.status,
			work_receipt: pipelineExecution.result.work_receipt,
			evidence_types: pipelineExecution.evidence.evidence_types,
			verification_status: pipelineExecution.verification.status,
			task_state: pipelineExecution.task.state,
		},
		controlled_breaker: {
			opened,
			blocked_status: blocked.status,
			blocked_evidence: blocked.evidence,
			final_status: breaker.status("controlled-provider"),
		},
		real_provider_concurrency: realProvider,
		bound_coverage: { passed: boundCoverage.passed, uncovered_paths: boundCoverage.uncovered_paths, reasons: boundCoverage.reasons },
		gate_checks: checks,
		phase12_gate: phase12GatePass ? "PASS" : "NOT_READY",
		phase13: "NOT_ENTERED",
		known_upstream_failure: {
			file: "packages/ai/src/api/google-shared.ts",
			line: 402,
			fingerprint: "TS2322 FinishReason.TOO_MANY_TOOL_CALLS is not assignable to never",
			status: "unchanged-known-upstream-failure",
		},
	};
	if (outputPath) {
		mkdirSync(dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	}
	console.log(JSON.stringify({ phase12_gate: evidence.phase12_gate, checks, real_provider: realProvider.status, output: outputPath ?? null }));
	if (!phase12GatePass) process.exitCode = 2;
}

try {
	await main();
} finally {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}
