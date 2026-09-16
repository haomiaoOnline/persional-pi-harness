import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const workspace = process.env.PPH_WORKER_WORKSPACE;
const instanceId = process.env.PPH_WORKER_INSTANCE_ID;
const sessionId = process.env.PPH_WORKER_SESSION_ID;

if (!workspace || !instanceId || !sessionId) {
	process.stderr.write("missing process worker identity environment\n");
	process.exit(78);
}

const sessionDigest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
const digestText = (value) => createHash("sha256").update(value).digest("hex");
const writeMessage = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

writeMessage({ type: "ready", pid: process.pid, session_id_sha256: sessionDigest });

function actionRecord(prompt) {
	const value = prompt?.inputs?.level_b_action;
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeTarget(target) {
	if (typeof target !== "string" || target.length === 0 || isAbsolute(target)) {
		throw new Error("process worker target must be a non-empty relative path");
	}
	const absolute = resolve(workspace, target);
	const escaped = relative(workspace, absolute);
	if (!escaped || escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(escaped)) {
		throw new Error("process worker target escapes workspace");
	}
	return { absolute, relative: escaped };
}

function receipt(changedFiles, evidence) {
	return {
		work_attempted: true,
		effects_count: changedFiles.length,
		artifacts_created: [],
		state_changed: changedFiles.length > 0,
		no_op: false,
		evidence_refs: evidence,
	};
}

function runGit(args) {
	const result = spawnSync("git", ["-C", workspace, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) throw new Error("git " + (args[0] ?? "command") + " failed in worker workspace");
	return String(result.stdout ?? "").trim();
}

function safeFileList(value) {
	if (!Array.isArray(value) || value.length === 0) throw new Error("git action requires a non-empty files list");
	return value.map((file) => safeTarget(file).relative);
}

function commitAction(action) {
	const target = typeof action.target === "string" ? safeTarget(action.target) : undefined;
	if (target && typeof action.content === "string") {
		mkdirSync(dirname(target.absolute), { recursive: true });
		writeFileSync(target.absolute, action.content, "utf8");
	}
	const files = safeFileList(action.files ?? (target ? [target.relative] : undefined));
	const message = typeof action.message === "string" && action.message.trim() ? action.message.trim().slice(0, 160) : "T13 Worker change";
	runGit(["add", "--", ...files]);
	const result = spawnSync(
		"git",
		[
			"-C",
			workspace,
			"-c",
			"user.name=Personal PI T13 Worker",
			"-c",
			"user.email=personal-pi-t13-worker@localhost",
			"commit",
			"-m",
			message,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status !== 0) throw new Error("git commit failed in worker workspace");
	const commit = runGit(["rev-parse", "HEAD"]);
	const evidence = [
		instanceId + ":process_pid=" + process.pid,
		instanceId + ":session_id_sha256=" + sessionDigest,
		instanceId + ":workspace=" + workspace,
		instanceId + ":commit=" + commit,
	];
	return {
		status: "success",
		summary: "process Worker " + instanceId + " committed " + files.join(", "),
		changed_files: files,
		artifacts: [],
		evidence,
		errors: [],
		work_receipt: receipt(files, evidence),
	};
}

function mergeAction(action) {
	const commits = Array.isArray(action.commits) ? action.commits : [];
	if (
		commits.length < 2 ||
		commits.some((commit) => typeof commit !== "string" || !/^[0-9a-f]{7,64}$/.test(commit))
	) {
		throw new Error("git merge requires at least two validated commit SHAs");
	}
	const changedFiles = safeFileList(action.changed_files);
	const result = spawnSync(
		"git",
		[
			"-C",
			workspace,
			"-c",
			"user.name=Personal PI T13 Integration Worker",
			"-c",
			"user.email=personal-pi-t13-integration@localhost",
			"merge",
			"--no-ff",
			"--no-edit",
			...commits,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status !== 0) throw new Error("git merge failed in integration workspace");
	const mergeCommit = runGit(["rev-parse", "HEAD"]);
	const evidence = [
		instanceId + ":process_pid=" + process.pid,
		instanceId + ":session_id_sha256=" + sessionDigest,
		instanceId + ":workspace=" + workspace,
		instanceId + ":merge_commit=" + mergeCommit,
		instanceId + ":merged_commits=" + commits.join(","),
	];
	return {
		status: "success",
		summary: "process Worker " + instanceId + " merged " + commits.length + " commits",
		changed_files: changedFiles,
		artifacts: [],
		evidence,
		errors: [],
		work_receipt: receipt(changedFiles, evidence),
	};
}

function inputFiles(value) {
	if (!Array.isArray(value) || value.length === 0) throw new Error("analysis action requires a non-empty source_files list");
	return safeFileList(value).map((file) => {
		const content = readFileSync(resolve(workspace, file), "utf8");
		return {
			path: file,
			content,
			digest: createHash("sha256").update(content).digest("hex"),
		};
	});
}

function writeAnalysisAction(action) {
	const inputs = inputFiles(action.source_files);
	const target = safeTarget(action.output);
	const originalFiles = Array.isArray(action.original_source_files) ? action.original_source_files : inputs.map((input) => input.path);
	const content = JSON.stringify(
		{
			worker_id: instanceId,
			focus: typeof action.focus === "string" ? action.focus : "repository",
			source_files: originalFiles,
			source_digests: inputs.map((input) => input.digest),
			findings: inputs.map((input) => ({
				source_snapshot: input.path,
				line_count: input.content.split("\n").length,
				contains_worker_instance_id: input.content.includes("worker_instance_id"),
				contains_lease_epoch: input.content.includes("lease_epoch"),
			})),
		},
		null,
		2,
	);
	mkdirSync(dirname(target.absolute), { recursive: true });
	writeFileSync(target.absolute, content, "utf8");
	const evidence = [
		instanceId + ":process_pid=" + process.pid,
		instanceId + ":session_id_sha256=" + sessionDigest,
		instanceId + ":workspace=" + workspace,
		instanceId + ":analysis_digest=" + digestText(content),
	];
	return {
		status: "success",
		summary: "process Worker " + instanceId + " analyzed " + inputs.length + " source snapshots",
		changed_files: [target.relative],
		artifacts: [],
		evidence,
		errors: [],
		work_receipt: receipt([target.relative], evidence),
	};
}

function writeFanInAction(action) {
	const inputs = inputFiles(action.source_files);
	const target = safeTarget(action.output);
	const taskIds = Array.isArray(action.input_task_ids) ? action.input_task_ids : [];
	const workerIds = Array.isArray(action.input_worker_ids) ? action.input_worker_ids : [];
	const contextDigests = Array.isArray(action.input_context_digests) ? action.input_context_digests : [];
	const content = JSON.stringify(
		{
			synthesis_task_id: typeof action.synthesis_task_id === "string" ? action.synthesis_task_id : "fan-in",
			fan_in: inputs.map((input, index) => ({
				task_id: taskIds[index] ?? "unknown",
				worker_id: workerIds[index] ?? "unknown",
				analysis_digest: input.digest,
				context_digest: contextDigests[index] ?? "unknown",
				source_snapshot: input.path,
			})),
			conclusion: "the Integration Worker synthesized independently produced analysis artifacts",
		},
		null,
		2,
	);
	mkdirSync(dirname(target.absolute), { recursive: true });
	writeFileSync(target.absolute, content, "utf8");
	const evidence = [
		instanceId + ":process_pid=" + process.pid,
		instanceId + ":session_id_sha256=" + sessionDigest,
		instanceId + ":workspace=" + workspace,
		instanceId + ":fan_in_count=" + inputs.length,
		instanceId + ":synthesis_digest=" + digestText(content),
	];
	return {
		status: "success",
		summary: "process Worker " + instanceId + " synthesized " + inputs.length + " analysis artifacts",
		changed_files: [target.relative],
		artifacts: [],
		evidence,
		errors: [],
		work_receipt: receipt([target.relative], evidence),
	};
}

async function execute(message) {
	const action = actionRecord(message.prompt);
	const kind = typeof action.kind === "string" ? action.kind : "write";
	if (kind === "crash") process.kill(process.pid, "SIGKILL");
	const delay = typeof action.delay_ms === "number" ? Math.max(0, Math.min(5_000, action.delay_ms)) : 0;
	if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
	if (kind === "git_commit") return commitAction(action);
	if (kind === "git_merge") return mergeAction(action);
	if (kind === "analyze_files") return writeAnalysisAction(action);
	if (kind === "fan_in") return writeFanInAction(action);
	if (kind === "sleep") {
		return {
			status: "success",
			summary: `process Worker ${instanceId} completed sleep`,
			changed_files: [],
			artifacts: [],
			evidence: [`${instanceId}:process_pid=${process.pid}`, `${instanceId}:session_id_sha256=${sessionDigest}`],
			errors: [],
			work_receipt: { work_attempted: true, effects_count: 0, artifacts_created: [], state_changed: false, no_op: true, no_op_reason: "sleep-only conformance action", evidence_refs: [] },
		};
	}
	if (kind === "noop") {
		return {
			status: "success",
			summary: `process Worker ${instanceId} completed no-op`,
			changed_files: [],
			artifacts: [],
			evidence: [`${instanceId}:process_pid=${process.pid}`, `${instanceId}:session_id_sha256=${sessionDigest}`],
			errors: [],
			work_receipt: { work_attempted: false, effects_count: 0, artifacts_created: [], state_changed: false, no_op: true, no_op_reason: "explicit conformance no-op", evidence_refs: [] },
		};
	}

	const target = safeTarget(typeof action.target === "string" ? action.target : `${instanceId}.out`);
	const content = typeof action.content === "string" ? action.content : `worker=${instanceId}\npid=${process.pid}\n`;
	mkdirSync(dirname(target.absolute), { recursive: true });
	writeFileSync(target.absolute, content, "utf8");
	const evidence = [`${instanceId}:process_pid=${process.pid}`, `${instanceId}:session_id_sha256=${sessionDigest}`, `${instanceId}:workspace=${workspace}`];
	return {
		status: "success",
		summary: `process Worker ${instanceId} wrote ${target.relative}`,
		changed_files: [target.relative],
		artifacts: [],
		evidence,
		errors: [],
		work_receipt: receipt([target.relative], evidence),
	};
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
	if (!line.trim()) continue;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		continue;
	}
	if (message?.type === "shutdown") process.exit(0);
	if (message?.type !== "execute" || typeof message.request_id !== "string") continue;
	try {
		writeMessage({ type: "result", request_id: message.request_id, output: await execute(message) });
	} catch (error) {
		writeMessage({
			type: "result",
			request_id: message.request_id,
			output: {
				status: "failure",
				summary: `process Worker ${instanceId} rejected the action`,
				changed_files: [],
				artifacts: [],
				evidence: [`${instanceId}:process_pid=${process.pid}`, `${instanceId}:session_id_sha256=${sessionDigest}`],
				errors: [error instanceof Error ? error.message : String(error)],
				work_receipt: { work_attempted: true, effects_count: 0, artifacts_created: [], state_changed: false, no_op: false, evidence_refs: [] },
			},
		});
	}
}
