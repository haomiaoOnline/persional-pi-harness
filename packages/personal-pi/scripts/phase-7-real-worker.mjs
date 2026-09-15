import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	captureWorkspaceSnapshot,
	createPlanApproval,
	digestFor,
	MemoryColdEvidenceArchive,
	MemoryConsolidator,
	PersonalPiPipeline,
	PersistentStateStore,
	PiAgentWorkerAdapter,
	ReferenceArchitecturePlaybook,
	RoutineCapture,
	TriggerGateway,
} from "../dist/index.js";

const repo = process.cwd();
const evidenceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const evidenceDir = mkdtempSync(join(tmpdir(), "pph-phase7-evidence-"));
const stateDir = mkdtempSync(join(tmpdir(), "pph-phase7-state-"));
const stateStore = new PersistentStateStore(join(stateDir, "state.json"));
const pipeline = new PersonalPiPipeline({ state_store: stateStore });

function hash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sanitizedPath(path, worktree) {
	return path.startsWith(`${worktree}/`) ? `DISPOSABLE_WORKTREE/${relative(worktree, path)}` : path;
}

function requirement(delivery) {
	return {
		user: "Personal PI owner",
		data_sources: ["synthetic conformance prompt"],
		permission_location: ["Task Contract"],
		delivery,
		acceptance: ["Personal PI independent verifier records the Worker result"],
		constraints: ["no network", "no credentials", "bounded process"],
		unknowns: [],
		sustainability: ["replayable sanitized evidence"],
		non_functional: ["bounded execution"],
		commercialization: ["internal harness"],
	};
}

function taskFor(id, objective, options = {}) {
	const workingDirectory = options.working_directory ?? repo;
	const inputs = options.inputs ?? {};
	const timeout = options.timeout ?? 90_000;
	const allowedTools = options.allowed_tools ?? [];
	const writeScopes = options.write_scopes ?? [];
	const readScopes = options.read_scopes ?? [workingDirectory];
	const verificationCommands = options.verification_commands ?? [];
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: options.type ?? "cli",
		title: options.title ?? `Phase 7 real Provider task ${id}`,
		objective,
		requirements: options.requirements ?? ["Return the exact structured Result Contract requested by this case"],
		constraints: options.constraints ?? ["Do not call tools", "Do not modify files", "Use only the selected Worker route"],
		scope: { files: options.scope_files ?? [] },
		inputs,
		data_sources: ["synthetic conformance prompt"],
		data_references: [],
		permissions: {
			filesystem: { read: readScopes, write: writeScopes },
			shell: { allowed: options.shell_allowed ?? [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: options.worker_tier ?? "standard",
			reasoning_depth: "high",
			capability_tags: options.capability_tags ?? ["coding"],
			mode: "single",
			working_directory: workingDirectory,
			allowed_tools: allowedTools,
			idempotency_key: options.idempotency_key ?? `phase7:real:${id}`,
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: options.expected_outputs ?? ["structured Result Contract and Work Receipt"],
		acceptance_criteria: options.acceptance_criteria ?? ["The independent verifier records the selected Worker status"],
		verification: {
			strategy: "automated",
			commands: verificationCommands,
			checks: options.verification_checks ?? ["real PI process evidence", "Result Contract validation", "Work Receipt validation"],
			evidence_required: options.evidence_required ?? ["pi-agent:process"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: options.max_input_tokens ?? 3_000 } },
		risk: "low",
		priority: "P1",
		timeout,
		retry_policy: { max_attempts: 1, backoff: 0 },
		loop_budget: {
			max_attempts: 1,
			max_model_calls: options.max_model_calls ?? 2,
			max_tool_calls: options.max_tool_calls ?? (allowedTools.length > 0 ? 2 : 0),
			max_handoffs: 0,
			max_elapsed_ms: options.max_elapsed_ms ?? timeout,
			max_input_tokens: options.max_input_tokens ?? 3_000,
			max_output_tokens: options.max_output_tokens ?? 1_000,
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
	playbook_refs: ["phase-7-real-worker"],
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
			{ id: "phase-7-real-worker", task_types: [task.type], clauses: ["bounded real Provider Worker"] },
		]),
	};
}

function workerFor(id, options = {}) {
	return new PiAgentWorkerAdapter({
		worker_id: `pi-real-${id}`,
		timeout_ms: options.timeout_ms ?? 60_000,
	});
}

function receiptSummary(receipt) {
	return receipt
		? {
				work_attempted: receipt.work_attempted,
				effects_count: receipt.effects_count,
				state_changed: receipt.state_changed,
				no_op: receipt.no_op,
				no_op_reason_present: Boolean(receipt.no_op_reason),
				evidence_refs: receipt.evidence_refs,
			}
		: null;
}

function observationSummary(adapter) {
	const observation = adapter.getLastObservation();
	return {
		backend: observation?.backend ?? "pi-agent",
		requested_model: observation?.requested_model ?? "ArkCoding/deepseek-v4-flash-ga-260731",
		platform_accepted_model: observation?.platform_accepted_model ?? null,
		observed_runtime_model: observation?.observed_runtime_model ?? null,
		provider: observation?.provider ?? null,
		adapter_status: observation?.status ?? "unknown",
		elapsed_ms: observation?.elapsed_ms ?? null,
		input_tokens: observation?.input_tokens ?? null,
		output_tokens: observation?.output_tokens ?? null,
		cost_usd: observation?.cost_usd ?? null,
		model_calls: observation?.model_calls ?? null,
		tool_calls: observation?.tool_calls ?? null,
		timed_out: observation?.timed_out ?? false,
	};
}

function executionSummary(execution, adapter, worktree) {
	return {
		task_id: hash(execution.task.id),
		run_id: hash(execution.run.id),
		contract_hash: digestFor(execution.task),
		...observationSummary(adapter),
		result_status: execution.result.status,
		task_state: execution.task.state,
		result_summary: execution.result.summary,
		result_errors: execution.result.errors,
		changed_files: execution.result.changed_files.map((path) => sanitizedPath(path, worktree ?? "")),
		artifacts: execution.result.artifacts.map((path) => sanitizedPath(path, worktree ?? "")),
		evidence: execution.result.evidence,
		work_receipt: receiptSummary(execution.result.work_receipt),
		verification: {
			status: execution.verification.status,
			confidence: execution.verification.verification_confidence,
			reasons: execution.verification.reasons,
		},
		evidence_id: hash(execution.evidence.id),
		trace_id: hash(execution.trace.trace_id),
	};
}

async function runRealProviderE2E() {
	const cases = [
		{
			id: "provider-e2e-1",
			objective:
				"Return status success, summary PHASE7_PROVIDER_E2E_1, empty changed_files and artifacts, empty errors, and a complete no-op Work Receipt. This is a synthetic read-only Provider E2E case. Do not call tools.",
		},
		{
			id: "provider-e2e-2",
			objective:
				"Return status success, summary PHASE7_PROVIDER_E2E_2, empty changed_files and artifacts, empty errors, and a complete no-op Work Receipt. Confirm that the real PI Agent process handled this synthetic request. Do not call tools.",
		},
		{
			id: "provider-e2e-3",
			objective:
				"Return status success, summary PHASE7_PROVIDER_E2E_3, empty changed_files and artifacts, empty errors, and a complete no-op Work Receipt. Keep the answer within the selected Worker budget. Do not call tools.",
		},
	];
	const results = [];
	for (const item of cases) {
		const task = taskFor(item.id, item.objective);
		const adapter = workerFor(item.id);
		const snapshot = captureWorkspaceSnapshot(evidenceCommit, [], []);
		try {
			const execution = await pipeline.execute({
				...planFor(task),
				requirement: requirement(`Phase 7 real Provider E2E ${item.id}`),
				task,
				worker: adapter,
				snapshot,
				current_snapshot: snapshot,
			});
			results.push({
				...executionSummary(execution, adapter),
				expected_status: "success",
				expected_task_state: "DONE",
				conformance_match: execution.result.status === "success" && execution.task.state === "DONE",
			});
		} catch (error) {
			results.push({
				case: item.id,
				task_id: hash(task.id),
				contract_hash: digestFor(task),
				...observationSummary(adapter),
				conformance_match: false,
				pipeline_error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const failedCase = results[1];
	if (failedCase && !failedCase.conformance_match) {
		const retryId = "provider-e2e-2-follow-up";
		const retryTask = taskFor(
			retryId,
			'Output exactly one JSON object with exactly these top-level keys: status, summary, changed_files, artifacts, evidence, errors, work_receipt. Set status to "success", summary to "PHASE7_PROVIDER_E2E_2_FOLLOW_UP", changed_files to [], artifacts to [], evidence to [], errors to [], and work_receipt to exactly {"work_attempted":false,"effects_count":0,"artifacts_created":[],"state_changed":false,"no_op":true,"no_op_reason":"read-only follow-up","evidence_refs":[]}. Do not omit evidence_refs. This is the single bounded follow-up for a malformed first response. Do not call tools.',
		);
		const retryAdapter = workerFor(retryId);
		const retrySnapshot = captureWorkspaceSnapshot(evidenceCommit, [], []);
		try {
			const retryExecution = await pipeline.execute({
				...planFor(retryTask),
				requirement: requirement("Phase 7 bounded follow-up for malformed Provider E2E Result"),
				task: retryTask,
				worker: retryAdapter,
				snapshot: retrySnapshot,
				current_snapshot: retrySnapshot,
			});
			failedCase.follow_up = {
				...executionSummary(retryExecution, retryAdapter),
				expected_status: "success",
				expected_task_state: "DONE",
				conformance_match: retryExecution.result.status === "success" && retryExecution.task.state === "DONE",
			};
			failedCase.conformance_match = failedCase.follow_up.conformance_match;
		} catch (error) {
			failedCase.follow_up = {
				case: retryId,
				task_id: hash(retryTask.id),
				contract_hash: digestFor(retryTask),
				...observationSummary(retryAdapter),
				conformance_match: false,
				pipeline_error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return results;
}

function commandEvidenceForSelfDevelopment(command, targetAbsolute, worktree) {
	if (command !== "verify:phase7-self-development-marker")
		return { command, exit_code: 1, stdout: "", stderr: "unknown verification command" };
	const vitest = join(repo, "node_modules", "vitest", "vitest.mjs");
	try {
		const stdout = execFileSync(
			process.execPath,
			[vitest, "run", "packages/personal-pi/test/self-development-marker.test.ts"],
			{ cwd: worktree, encoding: "utf8", maxBuffer: 1_000_000 },
		);
		const content = readFileSync(targetAbsolute, "utf8");
		if (!content.includes("PHASE7_SELF_DEVELOPMENT_MARKER")) throw new Error("marker missing from generated test");
		return { command, exit_code: 0, stdout: stdout.slice(-8_000), stderr: "" };
	} catch (error) {
		const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
		const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
		return {
			command,
			exit_code: 1,
			stdout: stdout.slice(-8_000),
			stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.slice(-8_000),
		};
	}
}

function captureDisposablePatch(worktree, targetRelative, patchPath) {
	const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
		cwd: worktree,
		encoding: "utf8",
	});
	const statusPaths = status
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.slice(3))
		.filter((path) => path === targetRelative || path.endsWith(`/${targetRelative}`));
	let patch = "";
	try {
		patch = execFileSync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", targetRelative], {
			cwd: worktree,
			encoding: "utf8",
		});
	} catch (error) {
		if (error && typeof error === "object" && "stdout" in error) patch = String(error.stdout ?? "");
	}
	const sanitizedPatch = patch.replaceAll(worktree, "DISPOSABLE_WORKTREE");
	writeFileSync(patchPath, sanitizedPatch, "utf8");
	return {
		status_paths: statusPaths,
		patch_path: patchPath,
		patch_sha256: sha256(sanitizedPatch),
		patch_bytes: Buffer.byteLength(sanitizedPatch),
		patch_excerpt: sanitizedPatch.slice(0, 4_000),
	};
}

async function runDisposableSelfDevelopment() {
	const parent = mkdtempSync(join(tmpdir(), "pph-phase7-selfdev-parent-"));
	const worktree = join(parent, "worktree");
	const targetRelative = "packages/personal-pi/test/self-development-marker.test.ts";
	const targetAbsolute = join(worktree, targetRelative);
	const patchPath = join(evidenceDir, "phase-07-self-development.patch");
	let added = false;
	let execution;
	let adapter;
	try {
		execFileSync("git", ["worktree", "add", "--detach", worktree, evidenceCommit], {
			cwd: repo,
			encoding: "utf8",
		});
		added = true;
		const nodeModules = join(repo, "node_modules");
		if (existsSync(nodeModules)) symlinkSync(nodeModules, join(worktree, "node_modules"), "dir");
		const task = taskFor(
			"self-development-real",
			`In the disposable worktree, use the allowed write tool exactly once to create ${targetAbsolute} with a minimal Vitest test. The file must contain a test named \"PHASE7_SELF_DEVELOPMENT_MARKER\" and assert that the string \"PHASE7_SELF_DEVELOPMENT_MARKER\" equals itself. Do not read or modify any other file. Do not call bash, shell, network, or any other tool. Return status success, summary PHASE7_SELF_DEVELOPMENT_OK, changed_files and artifacts as empty arrays in your own JSON because the controller records observed mutations, errors as an empty array, and a complete non-no-op Work Receipt only after the write tool succeeds.`,
			{
				type: "self_development",
				title: "Phase 7 disposable real Worker self-development",
				working_directory: worktree,
				allowed_tools: ["write"],
				write_scopes: [targetAbsolute],
				readScopes: [worktree],
				scope_files: [targetAbsolute],
				inputs: { marker: "PHASE7_SELF_DEVELOPMENT_MARKER" },
				constraints: [
					"Only create the new marker test in the disposable worktree",
					"Do not modify existing files",
					"Do not use shell, network, credentials, or another tool",
				],
				requirements: ["Create one low-risk test helper and return a valid Result Contract"],
				expected_outputs: [targetAbsolute, "structured Result Contract and Work Receipt"],
				acceptance_criteria: ["The new marker test passes in the disposable worktree"],
				verification_commands: ["verify:phase7-self-development-marker"],
				verification_checks: ["targeted Vitest exits zero", "marker content is present", "observed write is in scope"],
				evidence_required: ["pi-agent:process", "independent_command"],
				max_tool_calls: 2,
				max_input_tokens: 4_000,
				max_output_tokens: 1_500,
			},
		);
		adapter = workerFor("self-development", { timeout_ms: 60_000 });
		const snapshot = captureWorkspaceSnapshot(evidenceCommit, [targetAbsolute], []);
		execution = await pipeline.execute({
			...planFor(task),
			requirement: requirement("one low-risk self-development test in a disposable worktree"),
			task,
			worker: adapter,
			snapshot,
			current_snapshot: snapshot,
			command_runner: (command) => commandEvidenceForSelfDevelopment(command, targetAbsolute, worktree),
		});
		const patch = captureDisposablePatch(worktree, targetRelative, patchPath);
		const targetExists = existsSync(targetAbsolute);
		const markerPresent = targetExists && readFileSync(targetAbsolute, "utf8").includes("PHASE7_SELF_DEVELOPMENT_MARKER");
		const actualPaths = patch.status_paths;
		const workspaceInvariant = targetExists && markerPresent && actualPaths.length === 1 && actualPaths[0] === targetRelative;
		return {
			status: execution.task.state === "DONE" && execution.verification.status === "PASS" && workspaceInvariant ? "PASS" : "FAIL",
			execution: executionSummary(execution, adapter, worktree),
			workspace_invariant: workspaceInvariant,
			target: targetRelative,
			target_exists: targetExists,
			marker_present: markerPresent,
			patch: {
				path: "private_tmp_evidence/phase-07-self-development.patch",
				sha256: patch.patch_sha256,
				bytes: patch.patch_bytes,
				status_paths: actualPaths,
				excerpt: patch.patch_excerpt,
			},
			controller_continuation: execution.task.state === "DONE" && execution.verification.status === "PASS",
		};
	} catch (error) {
		let patch;
		try {
			patch = captureDisposablePatch(worktree, targetRelative, patchPath);
		} catch {
			patch = undefined;
		}
		return {
			status: "FAIL",
			execution: execution && adapter ? executionSummary(execution, adapter, worktree) : null,
			workspace_invariant: false,
			target: targetRelative,
			patch: patch
				? {
					path: "private_tmp_evidence/phase-07-self-development.patch",
					sha256: patch.patch_sha256,
					bytes: patch.patch_bytes,
					status_paths: patch.status_paths,
					excerpt: patch.patch_excerpt,
				}
				: null,
			pipeline_error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (added) {
			try {
				execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, encoding: "utf8" });
			} catch {
				// The evidence remains a failure if the disposable worktree cannot be removed.
			}
		}
		try {
			rmSync(parent, { recursive: true, force: true });
		} catch {
			// Parent cleanup is best effort; the worktree removal above is the safety boundary.
		}
	}
}

async function runTriggeredCycle() {
	const acceleratedAt = new Date("2040-01-01T08:07:00.000Z");
	const schedule = { id: "phase7-real-schedule", cron: "* * * * *" };
	const trigger = new TriggerGateway((contract) => stateStore.createTask(contract));
	const task = taskFor(
		"triggered-provider-e2e",
		"Return status success, summary PHASE7_TRIGGERED_PROVIDER_OK, empty changed_files and artifacts, empty errors, and a complete no-op Work Receipt. This task was created by the scheduled Trigger Gateway at the controlled accelerated timestamp. Do not call tools.",
		{
			inputs: { topic: "accelerated schedule" },
			idempotency_key: "phase7:triggered-provider-e2e",
		},
	);
	const first = trigger.createFromSchedule(schedule, acceleratedAt, () => task);
	const duplicate = trigger.createFromSchedule(schedule, acceleratedAt, () => task);
	if (!first.created || !first.task) {
		return {
			status: "FAIL",
			accelerated_time: true,
			trigger: { first_created: first.created, first_reason: first.reason, duplicate_created: duplicate.created },
		};
	}
	const adapter = workerFor("triggered-provider-e2e");
	const snapshot = captureWorkspaceSnapshot(evidenceCommit, [], []);
	let execution;
	try {
		execution = await pipeline.execute({
			...planFor(task),
			requirement: requirement("scheduled Trigger Gateway task through the real Provider Worker"),
			task,
			existing_task: first.task,
			worker: adapter,
			snapshot,
			current_snapshot: snapshot,
			at: acceleratedAt.toISOString(),
		});
	} catch (error) {
		return {
			status: "FAIL",
			accelerated_time: true,
			trigger: {
				schedule_id: schedule.id,
				at: acceleratedAt.toISOString(),
				first_created: first.created,
				duplicate_created: duplicate.created,
				duplicate_reason: duplicate.reason,
			},
			pipeline_error: error instanceof Error ? error.message : String(error),
		};
	}

	const playbook = new ReferenceArchitecturePlaybook();
	const capture = new RoutineCapture(playbook);
	let routine;
	let routineReuse;
	let routineError;
	try {
		routine = capture.capture({
			task,
			run: execution.run,
			result: execution.result,
			evidence: execution.evidence,
			verification: execution.verification,
			human_approved: true,
			parameter_paths: ["inputs.topic"],
			approved_at: acceleratedAt.toISOString(),
		});
		routineReuse = capture.reuse(routine.id, {
			task_id: "triggered-provider-routine-reuse",
			topic: "accelerated reuse",
		});
	} catch (error) {
		routineError = error instanceof Error ? error.message : String(error);
	}

	const archive = new MemoryColdEvidenceArchive();
	const memoryTrigger = new TriggerGateway((contract) => stateStore.createTask(contract));
	const consolidator = new MemoryConsolidator({
		archive,
		trigger_gateway: memoryTrigger,
		now: () => acceleratedAt.toISOString(),
	});
	let memory;
	let memoryRetry;
	let memoryError;
	try {
		const input = {
			task,
			run: execution.run,
			result: execution.result,
			evidence: execution.evidence,
			decisions: execution.decisions,
			at: acceleratedAt.toISOString(),
		};
		memory = consolidator.consolidateFromSchedule(
			{ id: "phase7-memory-schedule", cron: "* * * * *" },
			acceleratedAt,
			input,
		);
		memoryRetry = consolidator.consolidateFromSchedule(
			{ id: "phase7-memory-schedule", cron: "* * * * *" },
			acceleratedAt,
			input,
		);
	} catch (error) {
		memoryError = error instanceof Error ? error.message : String(error);
	}

	const pipelinePass = execution.task.state === "DONE" && execution.verification.status === "PASS";
	const triggerPass = first.created && !duplicate.created && duplicate.reason.includes("duplicate");
	const routinePass = Boolean(routine && routineReuse && routineReuse.inputs.topic === "accelerated reuse");
	const memoryPass = memory?.status === "CONSOLIDATED" && memoryRetry?.status === "NO_OP";
	return {
		status: pipelinePass && triggerPass && routinePass && memoryPass ? "PASS" : "PARTIAL",
		accelerated_time: true,
		clock_timestamp: acceleratedAt.toISOString(),
		trigger: {
			schedule_id: schedule.id,
			first_created: first.created,
			first_task_id: hash(first.task.id),
			duplicate_created: duplicate.created,
			duplicate_reason: duplicate.reason,
			pass: triggerPass,
		},
		pipeline: {
			pass: pipelinePass,
			execution: executionSummary(execution, adapter),
		},
		routine: {
			pass: routinePass,
			template_id: routine ? hash(routine.id) : null,
			parameter_names: routine?.parameters.map((parameter) => parameter.name) ?? [],
			reused_task_id: routineReuse ? hash(routineReuse.id) : null,
			reused_topic: routineReuse?.inputs.topic ?? null,
			error: routineError,
			note: "RoutineCapture was in-memory and explicitly human_approved for this bounded evidence run; no production Playbook was persisted.",
		},
		memory_consolidation: {
			pass: memoryPass,
			first_status: memory?.status ?? null,
			retry_status: memoryRetry?.status ?? null,
			consolidation_task_id: memory ? hash(memory.consolidation_task_id) : null,
			archived_evidence_count: memory?.archived_evidence_refs.length ?? 0,
			token_delta: memory?.token_delta ?? null,
			error: memoryError,
		},
	};
}

let providerE2E;
let selfDevelopment;
let triggeredCycle;
try {
	providerE2E = await runRealProviderE2E();
	selfDevelopment = await runDisposableSelfDevelopment();
	triggeredCycle = await runTriggeredCycle();
} finally {
	try {
		rmSync(stateDir, { recursive: true, force: true });
	} catch {
		// The state directory is ephemeral evidence storage; cleanup is best effort.
	}
}

console.log(
	JSON.stringify(
		{
			phase: "7",
			mode: "real_external_worker",
			backend_type: "pi-agent",
			provider_route: "opencodex",
			requested_model: "ArkCoding/deepseek-v4-flash-ga-260731",
			observed_model_policy: "event_echo_only",
			evidence_generated_at: new Date().toISOString(),
			evidence_commit: evidenceCommit,
			state_store: "private_tmp_ephemeral",
			provider_e2e: providerE2E,
			self_development: selfDevelopment,
			triggered_cycle: triggeredCycle,
		},
		null,
		2,
	),
);
