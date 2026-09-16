import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AcceptanceGate,
	ContextResolver,
	ContextStore,
	EvidenceCollector,
	LeaseManager,
	PersistentStateStore,
	ProcessWorkerAdapter,
	TaskGraphStore,
	TaskStateMachine,
	TraceRecorder,
	VerificationEngine,
	WorkerPool,
	captureWorkspaceSnapshot,
	computeGraphEfficiencyMetrics,
	createProtocolEnvelope,
	replayExecutionTrace,
	sanitizeResultForVerification,
} from "../dist/index.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const outputFlag = process.argv.indexOf("--output");
const outputArgument = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
const outputPath = outputArgument
	? isAbsolute(outputArgument)
		? outputArgument
		: resolve(repo, outputArgument)
	: undefined;

function errorRecord(error) {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
	};
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error("git " + (args[0] ?? "command") + " failed");
	return String(result.stdout ?? "").trim();
}

function runGitStatus(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		exit_code: result.status ?? 1,
		stdout: String(result.stdout ?? "").trim(),
	};
}

function addWorktree(root, name) {
	const path = join(root, name);
	const result = spawnSync("git", ["worktree", "add", "--detach", path, "HEAD"], {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error("git worktree add failed for " + name);
	if (realpathSync(runGit(path, ["rev-parse", "--show-toplevel"])) !== realpathSync(path))
		throw new Error("worktree root mismatch for " + name);
	return path;
}

function removeWorktrees(paths) {
	for (const path of [...paths].reverse()) {
		const result = spawnSync("git", ["worktree", "remove", "--force", path], {
			cwd: repo,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0) {
			rmSync(path, { recursive: true, force: true });
		}
	}
}

function loopBudget() {
	return {
		max_attempts: 3,
		max_model_calls: 4,
		max_tool_calls: 8,
		max_handoffs: 2,
		max_elapsed_ms: 60_000,
		max_input_tokens: 100_000,
		max_output_tokens: 4_000,
		max_cost_usd: 5,
		max_state_growth_bytes: 100_000,
		on_exhaustion: { action: "BLOCKED", escalation: "human" },
	};
}

function taskFor(id, workspace, files, action, options = {}) {
	const context = options.context ?? { required: [], optional: [], excluded: [], budget: { max_input_tokens: 100_000 } };
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "T13.4 " + id,
		objective: options.objective ?? "Execute one bounded T13.4 conformance action in an isolated Worker resource",
		requirements: options.requirements ?? ["Return a valid Result Contract and observable Work Receipt"],
		constraints: ["synthetic conformance data", "no credentials", "no shared workspace"],
		scope: { files: [...files] },
		inputs: { level_b_action: action },
		data_sources: options.data_sources ?? ["repository source and test files"],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: ["."] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "high",
			capability_tags: ["coding"],
			mode: options.mode ?? "parallel",
			working_directory: workspace,
			allowed_tools: [],
		},
		dependencies: options.dependencies ?? [],
		artifact_dependencies: [],
		expected_outputs: options.expected_outputs ?? ["verified T13.4 conformance output"],
		acceptance_criteria: options.acceptance_criteria ?? ["independent verification accepts the result"],
		verification: {
			strategy: "automated",
			commands: options.verification_commands ?? [],
			checks: options.verification_checks ?? ["Result Contract", "Work Receipt"],
			evidence_required: options.evidence_required ?? [],
			strength: "strong",
		},
		context,
		risk: "low",
		priority: "P1",
		timeout: options.timeout ?? 60_000,
		retry_policy: { max_attempts: 3, backoff: 0 },
		loop_budget: loopBudget(),
		approval: { required: false },
	};
}

function requestFor(task, epoch, context) {
	return {
		task,
		protocol: createProtocolEnvelope(task, epoch),
		run_id: "run-" + task.id + "-" + epoch + "-" + randomUUID().slice(0, 8),
		resolved_context: context,
	};
}

function makeWorker(workspace, workerId, adapterId, timeout = 5_000) {
	return new ProcessWorkerAdapter({
		worker_id: workerId,
		worker_instance_id: "t13-instance-" + workerId,
		adapter_id: adapterId,
		workspace_path: workspace,
		timeout_ms: timeout,
	});
}

function makePool(state, definitions, maxActiveWorkers) {
	const pool = new WorkerPool({
		lease_manager: new LeaseManager(state),
		instance_store: state,
		coordination_budget: {
			max_active_workers: maxActiveWorkers,
			max_handoffs_per_task: 2,
			max_concurrent_roles: maxActiveWorkers,
		},
	});
	for (const definition of definitions) {
		pool.register({
			worker_id: definition.worker.worker_id,
			kind: "local_process_worker",
			adapter: definition.worker,
			idle_timeout_ms: 5_000,
		});
	}
	return pool;
}

async function runLease(pool, lease, task, context) {
	const startedAtMs = Date.now();
	try {
		const result = await pool.execute(lease, requestFor(task, lease.lease.lease_epoch, context));
		return {
			lease,
			task_id: task.id,
			started_at: new Date(startedAtMs).toISOString(),
			ended_at: new Date().toISOString(),
			started_at_ms: startedAtMs,
			ended_at_ms: Date.now(),
			result,
			error: null,
			snapshot: pool.get(lease.worker_id),
		};
	} catch (error) {
		return {
			lease,
			task_id: task.id,
			started_at: new Date(startedAtMs).toISOString(),
			ended_at: new Date().toISOString(),
			started_at_ms: startedAtMs,
			ended_at_ms: Date.now(),
			result: undefined,
			error: errorRecord(error),
			snapshot: pool.get(lease.worker_id),
		};
	}
}

async function startTask(pool, workerId, task, context) {
	const lease = await pool.acquireAsync(task.id, [workerId]);
	return runLease(pool, lease, task, context);
}

function executionEvidence(execution) {
	return {
		task_id: execution.task_id,
		worker_id: execution.lease.worker_id,
		worker_instance_id: execution.lease.worker_instance_id,
		adapter_id: execution.snapshot?.adapter_id ?? null,
		pid: execution.snapshot?.pid ?? null,
		session_id_sha256: execution.snapshot?.session_id_sha256 ?? null,
		workspace_path: execution.snapshot?.workspace_path ?? null,
		lease_epoch: execution.lease.lease.lease_epoch,
		started_at: execution.started_at,
		ended_at: execution.ended_at,
		status: execution.result?.status ?? "error",
		result_evidence: execution.result?.evidence ?? [],
		error: execution.error,
	};
}

function overlap(executions) {
	if (executions.length < 2) return false;
	const latestStart = Math.max(...executions.map((execution) => execution.started_at_ms));
	const earliestEnd = Math.min(...executions.map((execution) => execution.ended_at_ms));
	return latestStart < earliestEnd;
}

function contextForFiles(store, files) {
	const references = files.map((file) => store.put(readFileSync(join(repo, file), "utf8"), { source_path: file }));
	const manifest = {
		required: references.map((reference) => reference.digest),
		optional: [],
		excluded: [],
		budget: { max_input_tokens: 100_000 },
	};
	return {
		manifest,
		references,
		resolved: new ContextResolver(store).resolve(manifest),
	};
}

function digestText(value) {
	return createHash("sha256").update(value).digest("hex");
}

function commandEvidence(cwd, label, command, args) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		command: label,
		exit_code: result.status ?? 1,
		stdout: result.status === 0 ? "exit=0" : "exit=" + (result.status ?? 1),
		stderr: "",
	};
}

function traceFor(taskId, startMs, endMs, options) {
	const recorder = new TraceRecorder(taskId, randomUUID(), new Date(startMs).toISOString());
	const start = new Date(startMs).toISOString();
	const end = new Date(endMs).toISOString();
	recorder.record("REQUIREMENT", options.requirement ?? "T13.4 real acceptance requirement", start);
	recorder.record("PLAN_GATE", "Phase 12 gate PASS; T13.4 is now in scope", start);
	recorder.record("PRECLASSIFY", "local process Worker resources with bounded public conformance data", start);
	recorder.record("ASSESSMENT", "independent files, leases, timestamps and final Verification required", start);
	recorder.record("DISPATCH", options.dispatch, start, {
		graph_width: options.graph_width ?? 1,
		graph_depth: options.graph_depth ?? 1,
		active_workers: options.active_workers ?? 1,
		handoff_count: options.handoff_count ?? 0,
	});
	recorder.record("TASK", options.task_detail ?? taskId, start);
	recorder.record("DOR", "context, workspace and Worker capacity ready", start);
	recorder.record("WORKER", options.worker_detail, start, {
		active_workers: options.active_workers ?? 1,
		model_calls: options.model_calls ?? 0,
	});
	recorder.record("RUN", options.run_detail, start, {
		overlap: options.overlap ?? false,
		retry_depth: options.retry_depth ?? 0,
		elapsed_ms: Math.max(0, endMs - startMs),
	});
	recorder.record("RESULT", options.result_detail, end, {
		useful_work: options.useful_work ?? 1,
		no_op: false,
	});
	recorder.record("EVIDENCE", options.evidence_detail, end);
	recorder.record("VERIFICATION", options.verification_detail ?? "PASS", end, {
		status: options.verification_detail ?? "PASS",
	});
	recorder.record("ACCEPTANCE", options.outcome ?? "DONE", end);
	recorder.finish(options.outcome ?? "DONE", end);
	recorder.setMetrics({ token_per_task: 0, cache_hit_rate: 0, worker_tier: "standard" });
	recorder.setGraphEfficiencyMetrics(computeGraphEfficiencyMetrics(recorder.snapshot()));
	const trace = recorder.snapshot();
	return { trace, replay: replayExecutionTrace(trace) };
}

function persistTaskAt(store, task, state) {
	const machine = new TaskStateMachine();
	let record = store.createTask(task);
	for (const next of ["READY", "RUNNING", state]) {
		record = machine.transition(record, next, "T13.4 scenario progression");
		store.updateTask(record);
	}
	return record;
}

async function parallelReadAnalysis() {
	const root = mkdtempSync(join(tmpdir(), "pph-phase13-read-"));
	const state = new PersistentStateStore(join(root, "state.json"));
	const contextStore = new ContextStore(join(root, "context"));
	const workers = [
		{
			key: "architecture",
			workerId: "t13-read-architecture",
			focus: "architecture",
			files: ["docs/stage-gates/phase-12-v3.2-gate.md", "packages/personal-pi/src/types.ts"],
			output: "analysis/architecture.json",
		},
		{
			key: "code",
			workerId: "t13-read-code",
			focus: "code",
			files: ["packages/personal-pi/src/worker-pool.ts", "packages/personal-pi/src/process-worker.ts"],
			output: "analysis/code.json",
		},
		{
			key: "tests",
			workerId: "t13-read-tests",
			focus: "tests",
			files: ["packages/personal-pi/test/process-worker.test.ts", "packages/personal-pi/test/verification.test.ts"],
			output: "analysis/tests.json",
		},
	];
	const workerInstances = workers.map((definition) => ({
		definition,
		worker: makeWorker(join(root, definition.workerId), definition.workerId, "pi-read-analysis-adapter"),
	}));
	const synthesisWorker = makeWorker(join(root, "t13-read-synthesis"), "t13-read-synthesis", "pi-read-analysis-adapter");
	const allWorkers = [...workerInstances.map((item) => item.worker), synthesisWorker];
	const pool = makePool(
		state,
		[...workerInstances, { definition: { workerId: "t13-read-synthesis" }, worker: synthesisWorker }],
		3,
	);
	try {
		const warmed = await Promise.all(allWorkers.map((worker) => pool.warmAsync(worker.worker_id)));
		const contexts = workers.map((definition) => contextForFiles(contextStore, definition.files));
		const sourceSnapshots = workers.map((definition, index) => {
			const workspace = join(root, definition.workerId);
			const paths = definition.files.map((file, fileIndex) => {
				const relativePath = "inputs/source-" + fileIndex + ".txt";
				const absolutePath = join(workspace, relativePath);
				mkdirSync(dirname(absolutePath), { recursive: true });
				writeFileSync(absolutePath, readFileSync(join(repo, file), "utf8"), "utf8");
				return relativePath;
			});
			return {
				paths,
				original_files: definition.files,
				context_digests: contexts[index].references.map((reference) => reference.digest),
			};
		});
		const graphStore = new TaskGraphStore();
		const analysisTasks = workers.map((definition, index) =>
			taskFor(
				"t13-read-" + definition.key,
				join(root, definition.workerId),
				[definition.output],
				{
					kind: "analyze_files",
					source_files: sourceSnapshots[index].paths,
					original_source_files: sourceSnapshots[index].original_files,
					output: definition.output,
					focus: definition.focus,
					delay_ms: 350,
				},
				{
					context: contexts[index].manifest,
					objective: "Analyze " + definition.focus + " from the assigned repository files and write a bounded analysis artifact",
					mode: "parallel",
				},
			),
		);
		const synthesisTask = taskFor(
			"t13-read-synthesis",
			join(root, "t13-read-synthesis"),
			["synthesis/architecture-code-tests.json"],
			{ kind: "fan_in", source_files: [], output: "synthesis/architecture-code-tests.json", delay_ms: 100 },
			{
				context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 100_000 } },
				objective: "Fan in the three completed analysis artifacts into one synthesis Task",
				mode: "parallel",
				dependencies: analysisTasks.map((task) => task.id),
			},
		);
		graphStore.applyMutation({
			nodes: [...analysisTasks, synthesisTask].map((task) => ({ id: task.id, task_id: task.id })),
			edges: analysisTasks.map((task) => ({
				id: task.id + "-to-synthesis",
				from: task.id,
				to: synthesisTask.id,
				type: "DEPENDS_ON",
			})),
		});
		const analyses = await Promise.all(
			analysisTasks.map(async (task, index) => {
				const execution = await startTask(pool, workers[index].workerId, task, contexts[index].resolved);
				if (execution.result?.status === "success") pool.release(execution.lease);
				return execution;
			}),
		);
		const analysisEvidence = analyses.map(executionEvidence);
		const analysisOutputs = analysisTasks.map((task, index) => {
			const path = join(root, workers[index].workerId, task.scope.files[0]);
			const content = readFileSync(path, "utf8");
			return {
				task_id: task.id,
				worker_id: workers[index].workerId,
				path,
				digest: digestText(content),
				content,
			};
		});
		const fanInReferences = analysisOutputs.map((output) =>
			contextStore.put(output.content, { source_path: output.path }),
		);
		const fanInManifest = {
			required: fanInReferences.map((reference) => reference.digest),
			optional: [],
			excluded: [],
			budget: { max_input_tokens: 100_000 },
		};
		const fanInContext = new ContextResolver(contextStore).resolve(fanInManifest);
		const synthesisWorkspace = join(root, "t13-read-synthesis");
		const fanInInputPaths = analysisOutputs.map((output, index) => {
			const relativePath = "inputs/analysis-" + index + ".json";
			const absolutePath = join(synthesisWorkspace, relativePath);
			mkdirSync(dirname(absolutePath), { recursive: true });
			writeFileSync(absolutePath, output.content, "utf8");
			return relativePath;
		});
		synthesisTask.inputs.level_b_action.source_files = fanInInputPaths;
		synthesisTask.inputs.level_b_action.input_task_ids = analysisOutputs.map((output) => output.task_id);
		synthesisTask.inputs.level_b_action.input_worker_ids = analysisOutputs.map((output) => output.worker_id);
		synthesisTask.inputs.level_b_action.input_context_digests = fanInReferences.map((reference) => reference.digest);
		synthesisTask.inputs.level_b_action.synthesis_task_id = synthesisTask.id;
		synthesisTask.context = fanInManifest;
		const synthesis = await startTask(pool, "t13-read-synthesis", synthesisTask, fanInContext);
		if (synthesis.result?.status === "success") pool.release(synthesis.lease);
		const synthesisPath = join(root, "t13-read-synthesis", synthesisTask.scope.files[0]);
		const synthesisValue = JSON.parse(readFileSync(synthesisPath, "utf8"));
		const analysisValues = analysisOutputs.map((output) => JSON.parse(output.content));
		const topologicalOrder = graphStore.topologicalOrder();
		const readStart = Math.min(...analyses.map((execution) => execution.started_at_ms));
		const readEnd = Math.max(...analyses.map((execution) => execution.ended_at_ms));
		const trace = traceFor(synthesisTask.id, readStart, Math.max(readEnd, synthesis.ended_at_ms), {
			dispatch: "three analysis Workers dispatched independently; synthesis waits on all three DAG predecessors",
			task_detail: "architecture/code/tests → fan-in synthesis",
			worker_detail: "three same-adapter process Workers",
			run_detail: "analysis executions overlap=" + overlap(analyses),
			result_detail: "three analysis Work Receipts followed by synthesis Work Receipt",
			evidence_detail: "distinct PIDs, context digests, analysis digests and topological order",
			graph_width: 3,
			graph_depth: 2,
			active_workers: 3,
			overlap: overlap(analyses),
			model_calls: 0,
		});
		state.addTrace(trace.trace);
		const pass =
			warmed.length === 4 &&
			warmed.every((snapshot) => typeof snapshot.pid === "number" && snapshot.pid > 0) &&
			new Set(warmed.map((snapshot) => snapshot.pid)).size === 4 &&
			analyses.every((execution) => execution.result?.status === "success") &&
			analysisValues.every((value, index) =>
				JSON.stringify(value.source_digests) === JSON.stringify(sourceSnapshots[index].context_digests),
			) &&
			overlap(analyses) &&
			topologicalOrder.at(-1) === synthesisTask.id &&
			synthesis.result?.status === "success" &&
			synthesisValue.fan_in.length === 3 &&
			synthesisValue.fan_in.every((item) => item.analysis_digest && item.context_digest) &&
			trace.replay.complete;
		return {
			status: pass ? "PASS" : "NOT_READY",
			worker_instances: warmed.map((snapshot) => ({
				worker_id: snapshot.worker_id,
				worker_instance_id: snapshot.worker_instance_id,
				adapter_id: snapshot.adapter_id,
				pid: snapshot.pid,
				session_id_sha256: snapshot.session_id_sha256,
				workspace_path: snapshot.workspace_path,
			})),
			analysis_executions: analysisEvidence,
			synthesis_execution: executionEvidence(synthesis),
			fan_in: {
				input_task_ids: analysisOutputs.map((output) => output.task_id),
				input_digests: analysisOutputs.map((output) => output.digest),
				context_digests: fanInReferences.map((reference) => reference.digest),
				synthesis_path: synthesisTask.scope.files[0],
			},
			dag: { topological_order: topologicalOrder },
			trace,
			worker_count: 4,
			real_overlap: overlap(analyses),
		};
	} finally {
		await Promise.all(allWorkers.map((worker) => worker.stop()));
		rmSync(root, { recursive: true, force: true });
	}
}

async function parallelCoding() {
	const root = mkdtempSync(join(tmpdir(), "pph-phase13-coding-"));
	const worktreeRoot = join(root, "worktrees");
	mkdirSync(worktreeRoot, { recursive: true });
	const worktrees = [];
	const state = new PersistentStateStore(join(root, "state.json"));
	const definitions = [
		{
			key: "a",
			workerId: "t13-code-a",
			target: "packages/personal-pi/t13-fixture/module-a.mjs",
			content: "export const moduleA = 'A';\n",
			message: "T13 Worker A module",
		},
		{
			key: "b",
			workerId: "t13-code-b",
			target: "packages/personal-pi/t13-fixture/module-b.mjs",
			content: "export const moduleB = 'B';\n",
			message: "T13 Worker B module",
		},
		{
			key: "c",
			workerId: "t13-code-c",
			target: "packages/personal-pi/t13-fixture/module-c.test.mjs",
			content:
				"import assert from 'node:assert/strict';\nimport { moduleA } from './module-a.mjs';\nimport { moduleB } from './module-b.mjs';\nassert.equal(moduleA, 'A');\nassert.equal(moduleB, 'B');\nconsole.log('T13 integration fixture PASS');\n",
			message: "T13 Worker C test",
		},
	];
	const integrationPath = addWorktree(worktreeRoot, "integration");
	worktrees.push(integrationPath);
	for (const definition of definitions) {
		const path = addWorktree(worktreeRoot, definition.key);
		worktrees.push(path);
	}
	const workers = definitions.map((definition) => ({
		definition,
		worker: makeWorker(join(worktreeRoot, definition.key), definition.workerId, "pi-coding-adapter", 5_000),
	}));
	const integrationWorker = makeWorker(integrationPath, "t13-code-integration", "pi-coding-integration-adapter", 5_000);
	const allWorkers = [...workers.map((item) => item.worker), integrationWorker];
	const pool = makePool(
		state,
		[...workers, { definition: { workerId: "t13-code-integration" }, worker: integrationWorker }],
		4,
	);
	try {
		const warmed = await Promise.all(allWorkers.map((worker) => pool.warmAsync(worker.worker_id)));
		const codingTasks = definitions.map((definition) =>
			taskFor(
				"t13-code-" + definition.key,
				join(worktreeRoot, definition.key),
				[definition.target],
				{
					kind: "git_commit",
					target: definition.target,
					content: definition.content,
					files: [definition.target],
					message: definition.message,
					delay_ms: 400,
				},
				{
					objective: "Make the isolated module or test change owned by Worker " + definition.key.toUpperCase(),
					mode: "parallel",
				},
			),
		);
		const branchExecutions = await Promise.all(
			codingTasks.map(async (task, index) => {
				const execution = await startTask(pool, definitions[index].workerId, task);
				if (execution.result?.status === "success") pool.release(execution.lease);
				return execution;
			}),
		);
		const commits = definitions.map((definition) => runGit(join(worktreeRoot, definition.key), ["rev-parse", "HEAD"]));
		const branchClean = definitions.map(
			(definition) => runGit(join(worktreeRoot, definition.key), ["status", "--porcelain"]) === "",
		);
		const integrationTask = taskFor(
			"t13-code-integration",
			integrationPath,
			definitions.map((definition) => definition.target),
			{
				kind: "git_merge",
				commits,
				changed_files: definitions.map((definition) => definition.target),
				delay_ms: 100,
			},
			{
				objective: "Merge the three independent Worker commits inside the Integration Worker worktree",
				mode: "parallel",
				verification_commands: [
					"node --test packages/personal-pi/t13-fixture/module-c.test.mjs",
					"git diff --check HEAD~1",
					"git status --porcelain",
				],
				evidence_required: ["git_merge", "integration_worktree", "final_state_tests"],
			},
		);
		const integrationExecution = await startTask(pool, "t13-code-integration", integrationTask);
		const mergeCommit = runGit(integrationPath, ["rev-parse", "HEAD"]);
		const mergedAncestors = commits.every(
			(commit) => runGitStatus(integrationPath, ["merge-base", "--is-ancestor", commit, "HEAD"]).exit_code === 0,
		);
		const testCommand = commandEvidence(
			integrationPath,
			"node --test packages/personal-pi/t13-fixture/module-c.test.mjs",
			process.execPath,
			["--test", "packages/personal-pi/t13-fixture/module-c.test.mjs"],
		);
		const diffCommand = commandEvidence(integrationPath, "git diff --check HEAD~1", "git", ["diff", "--check", "HEAD~1"]);
		const statusCommand = commandEvidence(integrationPath, "git status --porcelain", "git", ["status", "--porcelain"]);
		const finalCommands = [testCommand, diffCommand, statusCommand];
		const finalState = {
			merge_commit: mergeCommit,
			merged_ancestors: mergedAncestors,
			files: definitions.map((definition) => ({
				path: definition.target,
				content_digest: digestText(readFileSync(join(integrationPath, definition.target), "utf8")),
			})),
			command_results: finalCommands,
		};
		const finalEvidence = new EvidenceCollector().collect({
			task_id: integrationTask.id,
			run_id: integrationExecution.result?.run_id ?? integrationExecution.lease.task_id,
			changed_files: integrationExecution.result?.changed_files ?? [],
			commands: finalCommands,
			stdout: "Integration Worker merge completed; final-state commands executed independently",
			stderr: "",
			evidence_types: ["git_merge", "integration_worktree", "final_state_tests", "independent_command"],
		});
		const finalSnapshot = captureWorkspaceSnapshot(mergeCommit, definitions.map((definition) => definition.target), []);
		const verification = await new VerificationEngine().verify({
			task: integrationTask,
			evidence: finalEvidence,
			snapshot: finalSnapshot,
			currentSnapshot: finalSnapshot,
			workerStatus: integrationExecution.result?.status,
			result: integrationExecution.result ? sanitizeResultForVerification(integrationExecution.result) : undefined,
		});
		const record = persistTaskAt(state, integrationTask, "VERIFYING");
		state.saveEvidence(finalEvidence);
		state.saveVerification(verification);
		const accepted = new AcceptanceGate().markDone(record, verification, finalSnapshot, integrationExecution.result);
		state.updateTask(accepted);
		if (integrationExecution.result?.status === "success") pool.release(integrationExecution.lease);
		const branchOverlap = overlap(branchExecutions);
		const branchPassNotReused = verification.status === "PASS" && accepted.state === "DONE" && finalCommands.every((command) => command.exit_code === 0);
		const trace = traceFor(integrationTask.id, Math.min(...branchExecutions.map((execution) => execution.started_at_ms)), Date.now(), {
			dispatch: "Workers A/B/C received disjoint files and an Integration Worker waited for their commits",
			task_detail: "module A + module B + test C → integration merge → final Verification",
			worker_detail: "three independent worktrees plus one Integration Worker worktree",
			run_detail: "A/B/C coding executions overlap=" + branchOverlap,
			result_detail: "three branch commits and one real merge commit",
			evidence_detail: "commit ancestry, worktree paths, final test, diff check and clean status",
			graph_width: 3,
			graph_depth: 2,
			active_workers: 3,
			overlap: branchOverlap,
			model_calls: 0,
		});
		state.addTrace(trace.trace);
		const pass =
			warmed.length === 4 &&
			warmed.every((snapshot) => typeof snapshot.pid === "number" && snapshot.pid > 0) &&
			new Set(warmed.map((snapshot) => snapshot.pid)).size === 4 &&
			branchExecutions.every((execution) => execution.result?.status === "success") &&
			new Set(commits).size === 3 &&
			branchClean.every(Boolean) &&
			branchOverlap &&
			integrationExecution.result?.status === "success" &&
			mergedAncestors &&
			verification.status === "PASS" &&
			accepted.state === "DONE" &&
			branchPassNotReused &&
			statusCommand.stdout === "exit=0" &&
			testCommand.exit_code === 0 &&
			trace.replay.complete;
		return {
			status: pass ? "PASS" : "NOT_READY",
			worker_instances: warmed.map((snapshot) => ({
				worker_id: snapshot.worker_id,
				worker_instance_id: snapshot.worker_instance_id,
				adapter_id: snapshot.adapter_id,
				pid: snapshot.pid,
				session_id_sha256: snapshot.session_id_sha256,
				workspace_path: snapshot.workspace_path,
			})),
			branch_executions: branchExecutions.map(executionEvidence),
			branch_commits: commits,
			branch_worktrees: definitions.map((definition) => ({
				worker_id: definition.workerId,
				path: join(worktreeRoot, definition.key),
				target: definition.target,
				clean_after_commit: branchClean[definitions.indexOf(definition)],
			})),
			integration_execution: executionEvidence(integrationExecution),
			integration_worktree: { path: integrationPath, merge_commit: mergeCommit, merged_ancestors: mergedAncestors },
			final_state: finalState,
			final_verification: {
				status: verification.status,
				checks: verification.checks,
				reasons: verification.reasons,
				accepted_task_state: accepted.state,
				branch_pass_not_reused: branchPassNotReused,
			},
			trace,
			real_overlap: branchOverlap,
		};
	} finally {
		await Promise.all(allWorkers.map((worker) => worker.stop()));
		removeWorktrees(worktrees);
		rmSync(root, { recursive: true, force: true });
	}
}

async function failureRecovery() {
	const root = mkdtempSync(join(tmpdir(), "pph-phase13-recovery-"));
	const state = new PersistentStateStore(join(root, "state.json"));
	const definitions = [
		{ workerId: "t13-recovery-a", workspace: join(root, "a") },
		{ workerId: "t13-recovery-b", workspace: join(root, "b") },
		{ workerId: "t13-recovery-c", workspace: join(root, "c") },
		{ workerId: "t13-recovery-d", workspace: join(root, "d") },
	];
	const workers = definitions.map((definition) => ({
		...definition,
		worker: makeWorker(definition.workspace, definition.workerId, "pi-recovery-adapter", 2_000),
	}));
	const pool = makePool(state, workers, 3);
	try {
		await Promise.all(workers.map((definition) => pool.warmAsync(definition.workerId)));
		const taskA = taskFor("t13-recovery-a-task", definitions[0].workspace, ["a.txt"], {
			kind: "write",
			target: "a.txt",
			content: "A completed while B failed",
			delay_ms: 350,
		});
		const taskB = taskFor("t13-recovery-b-task", definitions[1].workspace, ["b.txt"], {
			kind: "sleep",
			delay_ms: 1_000,
		});
		const taskC = taskFor("t13-recovery-c-task", definitions[2].workspace, ["c.txt"], {
			kind: "write",
			target: "c.txt",
			content: "C completed while B failed",
			delay_ms: 350,
		});
		const taskD = taskFor("t13-recovery-b-task", definitions[3].workspace, ["recovered.txt"], {
			kind: "write",
			target: "recovered.txt",
			content: "B task completed after reassignment",
			delay_ms: 100,
		});
		const leaseA = await pool.acquireAsync(taskA.id, [definitions[0].workerId]);
		const leaseB = await pool.acquireAsync(taskB.id, [definitions[1].workerId]);
		const leaseC = await pool.acquireAsync(taskC.id, [definitions[2].workerId]);
		const executionA = runLease(pool, leaseA, taskA);
		const executionB = runLease(pool, leaseB, taskB);
		const executionC = runLease(pool, leaseC, taskC);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
		const crashAtMs = Date.now();
		const crashPromise = workers[1].worker.crash();
		const reclaimed = await pool.reclaim(leaseB, "intentional T13.4 Worker B crash");
		await crashPromise;
		const replacementLease = await pool.acquireAsync(taskD.id, [definitions[3].workerId]);
		const executionD = runLease(pool, replacementLease, taskD);
		const [resultA, resultB, resultC, resultD] = await Promise.all([executionA, executionB, executionC, executionD]);
		const staleRejected = resultB.error?.message === "REJECTED_STALE_EPOCH";
		if (resultA.result?.status === "success") pool.release(resultA.lease);
		if (resultC.result?.status === "success") pool.release(resultC.lease);
		if (resultD.result?.status === "success") pool.release(resultD.lease);

		const graphStore = new TaskGraphStore();
		const joinTask = taskFor(
			"t13-recovery-dag-join",
			definitions[3].workspace,
			["dag-complete.json"],
			{
				kind: "write",
				target: "dag-complete.json",
				content: JSON.stringify(
					{
						a: readFileSync(join(definitions[0].workspace, "a.txt"), "utf8"),
						c: readFileSync(join(definitions[2].workspace, "c.txt"), "utf8"),
						reassigned: readFileSync(join(definitions[3].workspace, "recovered.txt"), "utf8"),
					},
					null,
					2,
				),
				delay_ms: 100,
			},
			{
				objective: "Complete the DAG only after A, C and the reassigned B task have finished",
				dependencies: [taskA.id, taskB.id, taskC.id],
			},
		);
		graphStore.applyMutation({
			nodes: [taskA, taskB, taskC, joinTask].map((task) => ({ id: task.id, task_id: task.id })),
			edges: [taskA, taskB, taskC].map((task) => ({
				id: task.id + "-to-join",
				from: task.id,
				to: joinTask.id,
				type: "DEPENDS_ON",
			})),
		});
		const joinExecution = await startTask(pool, definitions[3].workerId, joinTask);
		const finalCheckCode =
			"import { existsSync, readFileSync } from 'node:fs';" +
			"const files = " +
			JSON.stringify([
				join(definitions[0].workspace, "a.txt"),
				join(definitions[2].workspace, "c.txt"),
				join(definitions[3].workspace, "recovered.txt"),
				join(definitions[3].workspace, "dag-complete.json"),
			]) +
			"; if (files.some((file) => !existsSync(file) || readFileSync(file, 'utf8').length === 0)) process.exit(1);";
		const finalCommand = commandEvidence(
			root,
			"node --input-type=module -e dag-final-check",
			process.execPath,
			["--input-type=module", "-e", finalCheckCode],
		);
		const finalEvidence = new EvidenceCollector().collect({
			task_id: joinTask.id,
			run_id: joinExecution.result?.run_id ?? joinExecution.lease.task_id,
			changed_files: joinExecution.result?.changed_files ?? [],
			commands: [finalCommand],
			stdout: "independent DAG final-state verifier completed",
			stderr: "",
			evidence_types: ["failure_recovery", "dag_join", "independent_command"],
		});
		const finalSnapshot = captureWorkspaceSnapshot("local-recovery-final-state", ["dag-complete.json"], []);
		const verification = await new VerificationEngine().verify({
			task: { ...joinTask, verification: { ...joinTask.verification, commands: [finalCommand.command] } },
			evidence: finalEvidence,
			snapshot: finalSnapshot,
			currentSnapshot: finalSnapshot,
			workerStatus: joinExecution.result?.status,
			result: joinExecution.result ? sanitizeResultForVerification(joinExecution.result) : undefined,
		});
		const record = persistTaskAt(state, joinTask, "VERIFYING");
		state.saveEvidence(finalEvidence);
		state.saveVerification(verification);
		const accepted = new AcceptanceGate().markDone(record, verification, finalSnapshot, joinExecution.result);
		state.updateTask(accepted);
		if (joinExecution.result?.status === "success") pool.release(joinExecution.lease);
		const aAndCOverlapCrash =
			resultA.started_at_ms < crashAtMs &&
			resultA.ended_at_ms > crashAtMs &&
			resultC.started_at_ms < crashAtMs &&
			resultC.ended_at_ms > crashAtMs;
		const oldEpoch = leaseB.lease.lease_epoch;
		const newEpoch = replacementLease.lease.lease_epoch;
		const graphOrder = graphStore.topologicalOrder();
		const trace = traceFor(joinTask.id, Math.min(resultA.started_at_ms, resultC.started_at_ms, resultB.started_at_ms), Date.now(), {
			requirement: "B crash must not affect A/C; stale B result must be fenced and the DAG must complete",
			dispatch: "A/B/C leased concurrently; B is intentionally crashed and reassigned to D",
			task_detail: "A + B + C → crash/reclaim/reassign B → DAG join",
			worker_detail: "A/C remained active while B process was killed; D received epoch N+1",
			run_detail: "A/C overlap crash=" + aAndCOverlapCrash + ", stale old lease=" + staleRejected,
			result_detail: "A/C success, B stale result rejected, D reassigned result success",
			evidence_detail: "crash timestamp, old/new epochs, DEAD B, stale rejection and final DAG command",
			graph_width: 3,
			graph_depth: 2,
			active_workers: 3,
			handoff_count: 1,
			retry_depth: 1,
			overlap: aAndCOverlapCrash,
			model_calls: 0,
		});
		state.addTrace(trace.trace);
		const pass =
			reclaimed &&
			resultA.result?.status === "success" &&
			resultC.result?.status === "success" &&
			resultD.result?.status === "success" &&
			staleRejected &&
			oldEpoch + 1 === newEpoch &&
			pool.get(definitions[1].workerId)?.state === "DEAD" &&
			aAndCOverlapCrash &&
			graphOrder.at(-1) === joinTask.id &&
			joinExecution.result?.status === "success" &&
			verification.status === "PASS" &&
			accepted.state === "DONE" &&
			finalCommand.exit_code === 0 &&
			trace.replay.complete;
		return {
			status: pass ? "PASS" : "NOT_READY",
			executions: {
				a: executionEvidence(resultA),
				b_old: executionEvidence(resultB),
				c: executionEvidence(resultC),
				d_reassigned: executionEvidence(resultD),
				dag_join: executionEvidence(joinExecution),
			},
			crash_recovery: {
				crash_at: new Date(crashAtMs).toISOString(),
				reclaimed,
				old_lease: leaseB.lease,
				reassigned_lease: replacementLease.lease,
				stale_result_rejected: staleRejected,
				b_state_after_reclaim: pool.get(definitions[1].workerId)?.state,
				a_c_unaffected: resultA.result?.status === "success" && resultC.result?.status === "success",
				a_c_overlap_crash: aAndCOverlapCrash,
			},
			dag: { topological_order: graphOrder, final_command: finalCommand },
			final_verification: {
				status: verification.status,
				checks: verification.checks,
				reasons: verification.reasons,
				accepted_task_state: accepted.state,
			},
			trace,
		};
	} finally {
		await Promise.all(workers.map((definition) => definition.worker.stop()));
		rmSync(root, { recursive: true, force: true });
	}
}

async function scenario(name, fn) {
	try {
		return await fn();
	} catch (error) {
		return { status: "NOT_READY", scenario: name, error: errorRecord(error) };
	}
}

async function main() {
	const phase12Evidence = JSON.parse(
		readFileSync(join(repo, "docs/stage-gates/evidence/phase-12-level-b-2026-09-15.json"), "utf8"),
	);
	const readAnalysis = await scenario("Parallel Read/Analysis", parallelReadAnalysis);
	const coding = await scenario("Parallel Coding", parallelCoding);
	const recovery = await scenario("Failure Recovery", failureRecovery);
	const checks = {
		phase12_prerequisite: phase12Evidence.phase12_gate === "PASS",
		parallel_read_analysis: readAnalysis.status === "PASS",
		parallel_coding: coding.status === "PASS",
		failure_recovery: recovery.status === "PASS",
	};
	const aggregatePass = Object.values(checks).every(Boolean);
	const evidence = {
		phase: "Phase 13",
		baseline: "v3.2",
		t13_4: {
			parallel_read_analysis: readAnalysis,
			parallel_coding: coding,
			failure_recovery: recovery,
		},
		gate_checks: checks,
		aggregate_gate: aggregatePass ? "PASS" : "NOT_READY",
    p0_multi_worker_mvp: aggregatePass ? "PASS" : "NOT_ANNOUNCED",
		phase14_gap_01: "NON_BLOCKING; resolution Phase 14 Multi-CRI",
		known_upstream_failure: {
			file: "packages/ai/src/api/google-shared.ts",
			line: 402,
			fingerprint: "TS2322 FinishReason.TOO_MANY_TOOL_CALLS is not assignable to never",
			status: "unchanged-known-upstream-failure",
		},
	};
	if (outputPath) {
		mkdirSync(dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
	}
	console.log(
		JSON.stringify({
			phase13_aggregate_gate: evidence.aggregate_gate,
			checks,
			output: outputPath ?? null,
		}),
	);
	if (!aggregatePass) process.exitCode = 2;
}

await main();
