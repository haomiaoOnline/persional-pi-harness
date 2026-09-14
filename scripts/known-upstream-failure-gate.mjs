import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST_PATH = resolve(SCRIPT_DIR, "known-upstream-failure-allowlist.json");
const MAX_BUFFER = 64 * 1024 * 1024;
const SOURCE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^TS[0-9]+$/;
const DIAGNOSTIC_PATTERN = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const TYPESCRIPT_ERROR_MARKER = /\berror TS\d+:/;
const GATE_ARTIFACT_DIR = ".git/pph-known-upstream-failure-gate";

function normalizePath(value) {
	return value.replace(/\\/g, "/").trim();
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function validateEntry(entry, index) {
	if (!entry || typeof entry !== "object") throw new Error(`invalid known upstream failure at index ${index}`);
	for (const field of [
		"id",
		"packageName",
		"file",
		"errorCode",
		"semanticMessage",
		"sourceNeedle",
		"upstreamRevision",
		"sourceDigest",
	]) {
		nonEmptyString(entry[field], `known upstream failure ${index}.${field}`);
	}
	if (!Number.isInteger(entry.line) || entry.line < 1) {
		throw new Error(`known upstream failure ${entry.id} must define a positive line`);
	}
	if (!ERROR_CODE_PATTERN.test(entry.errorCode)) {
		throw new Error(`known upstream failure ${entry.id} has an invalid TypeScript error code`);
	}
	if (!SOURCE_DIGEST_PATTERN.test(entry.sourceDigest)) {
		throw new Error(`known upstream failure ${entry.id} has an invalid source digest`);
	}
	if (entry.file.startsWith("/") || entry.file.split("/").includes("..")) {
		throw new Error(`known upstream failure ${entry.id} must use a repository-relative file`);
	}
	if (!/^[0-9a-f]{40}$/.test(entry.upstreamRevision)) {
		throw new Error(`known upstream failure ${entry.id} must pin a full upstream commit`);
	}
}

export function loadKnownFailureAllowlist(path = DEFAULT_ALLOWLIST_PATH) {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
		throw new Error(`invalid known upstream failure allowlist schema: ${path}`);
	}
	const ids = new Set();
	const locations = new Set();
	for (const [index, entry] of parsed.entries.entries()) {
		validateEntry(entry, index);
		if (ids.has(entry.id)) throw new Error(`duplicate known upstream failure id: ${entry.id}`);
		ids.add(entry.id);
		const location = `${entry.file}:${entry.line}:${entry.errorCode}`;
		if (locations.has(location)) throw new Error(`duplicate known upstream failure location: ${location}`);
		locations.add(location);
	}
	return parsed.entries;
}

export function parseTypeScriptDiagnostics(output) {
	const diagnostics = [];
	for (const rawLine of String(output).replace(/\r\n/g, "\n").split("\n")) {
		const line = rawLine.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
		const match = DIAGNOSTIC_PATTERN.exec(line);
		if (!match) continue;
		diagnostics.push({
			file: normalizePath(match[1]),
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			errorCode: match[4],
			semanticMessage: match[5],
		});
	}
	return diagnostics;
}

function matchesEntry(entry, diagnostic) {
	return (
		normalizePath(entry.file) === diagnostic.file &&
		entry.line === diagnostic.line &&
		entry.errorCode === diagnostic.errorCode &&
		entry.semanticMessage === diagnostic.semanticMessage
	);
}

export function evaluateKnownFailureCheck({ status, output, entries }) {
	const normalizedLines = String(output).replace(/\r\n/g, "\n").split("\n").map((line) =>
		line.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim(),
	);
	const diagnostics = parseTypeScriptDiagnostics(output);
	const parsedDiagnosticLines = new Set(
		normalizedLines.filter((line) => DIAGNOSTIC_PATTERN.test(line)),
	);
	const unparsed = normalizedLines.filter((line) => TYPESCRIPT_ERROR_MARKER.test(line) && !parsedDiagnosticLines.has(line));
	const matched = new Set();
	const unexpected = [];
	for (const diagnostic of diagnostics) {
		const index = entries.findIndex((entry) => matchesEntry(entry, diagnostic));
		if (index === -1) unexpected.push(diagnostic);
		else matched.add(index);
	}
	const missing = entries.filter((_entry, index) => !matched.has(index));
	return {
		status,
		diagnostics,
		unexpected,
		missing,
		unparsed,
		exact:
			status !== 0 &&
			status !== null &&
			diagnostics.length === entries.length &&
			unexpected.length === 0 &&
			missing.length === 0 &&
			unparsed.length === 0,
		normalPass: status === 0 && diagnostics.length === 0,
	};
}

export function verifySourceContent(entry, content, revision) {
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
	const lines = content.toString("utf8").split(/\r?\n/);
	return {
		id: entry.id,
		revisionMatches: revision === entry.upstreamRevision,
		digestMatches: digest === entry.sourceDigest,
		lineMatches: lines[entry.line - 1]?.trim() === entry.sourceNeedle,
		observedDigest: digest,
		observedLine: lines[entry.line - 1]?.trim() ?? null,
	};
}

function runCommand(file, args, options = {}) {
	const result = spawnSync(file, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		stdio: options.stdio ?? "pipe",
	});
	if (result.error) throw result.error;
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function commandOutput(result) {
	return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runGit(repoRoot, args, options = {}) {
	const result = runCommand("git", args, { cwd: options.cwd ?? repoRoot });
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(`git ${args.join(" ")} failed${commandOutput(result) ? `: ${commandOutput(result)}` : ""}`);
	}
	return result;
}

function gitText(repoRoot, args) {
	return runGit(repoRoot, args).stdout.trim();
}

function safeEnvironment(root) {
	const home = join(root, "home");
	const temporary = join(root, "tmp");
	const cache = join(root, "cache");
	for (const directory of [home, temporary, cache, join(home, ".config"), join(cache, "npm")]) {
		mkdirSync(directory, { recursive: true });
	}
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: cache,
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		NPM_CONFIG_USERCONFIG: join(root, "npm-userconfig"),
		NPM_CONFIG_GLOBALCONFIG: join(root, "npm-globalconfig"),
		NPM_CONFIG_CACHE: join(cache, "npm"),
		PI_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
	};
}

function gitShow(repoRoot, revision, file) {
	const result = runGit(repoRoot, ["show", `${revision}:${file}`]);
	return Buffer.from(result.stdout, "utf8");
}

function verifySources(repoRoot, entries) {
	return entries.map((entry) => {
		const revision = gitText(repoRoot, ["rev-parse", "--verify", `${entry.upstreamRevision}^{commit}`]);
		const packageRoot = entry.file.split("/").slice(0, 2).join("/");
		const packageManifest = JSON.parse(gitShow(repoRoot, entry.upstreamRevision, `${packageRoot}/package.json`).toString("utf8"));
		if (packageManifest.name !== entry.packageName) {
			throw new Error(`known upstream package verification failed for ${entry.id}`);
		}
		const result = verifySourceContent(entry, gitShow(repoRoot, entry.upstreamRevision, entry.file), revision);
		if (!result.revisionMatches || !result.digestMatches || !result.lineMatches) {
			throw new Error(`known upstream source verification failed for ${entry.id}`);
		}
		return result;
	});
}

const WORKSPACE_ARTIFACT_PATHS = [
	"packages/agent/dist",
	"packages/ai/dist",
	"packages/chord/dist",
	"packages/client/dist",
	"packages/protocol/dist",
	"packages/server/dist",
	"packages/session-backends/sqlite-node/dist",
	"packages/telemetry/dist",
	"packages/tui/dist",
];

function preparePristineCheckout(repoRoot, checkout, env) {
	const install = runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: checkout,
		env,
	});
	if (install.status !== 0) throw new Error(`npm ci failed in pristine upstream checkout: ${commandOutput(install)}`);
	const modelData = join(repoRoot, "packages", "ai", "src", "providers", "data");
	if (!existsSync(modelData)) throw new Error(`generated model data is missing at ${modelData}`);
	cpSync(modelData, join(checkout, "packages", "ai", "src", "providers", "data"), { recursive: true });
	for (const relativePath of WORKSPACE_ARTIFACT_PATHS) {
		const source = join(repoRoot, relativePath);
		if (existsSync(source)) cpSync(source, join(checkout, relativePath), { recursive: true });
	}
}

function runPristineCheck(repoRoot, entries, root, env) {
	const temporaryRoot = mkdtempSync(join(root, "pristine-"));
	const checkout = join(temporaryRoot, "checkout");
	const archivePath = join(temporaryRoot, "upstream.tar");
	mkdirSync(checkout, { recursive: true });
	const archiveFd = openSync(archivePath, "w");
	const archive = runCommand("git", ["archive", "--format=tar", entries[0].upstreamRevision], {
		cwd: repoRoot,
		stdio: ["ignore", archiveFd, "pipe"],
	});
	closeSync(archiveFd);
	if (archive.status !== 0) {
		rmSync(temporaryRoot, { recursive: true, force: true });
		throw new Error(`git archive failed: ${commandOutput(archive)}`);
	}
	const extract = runCommand("tar", ["-xf", archivePath, "-C", checkout], { cwd: repoRoot, env });
	if (extract.status !== 0) {
		rmSync(temporaryRoot, { recursive: true, force: true });
		throw new Error(`tar extraction failed: ${commandOutput(extract)}`);
	}
	try {
		preparePristineCheckout(repoRoot, checkout, env);
		const result = runCommand("npm", ["run", "check"], { cwd: checkout, env });
		return {
			status: result.status,
			output: `${result.stdout}${result.stderr}`,
			evaluation: evaluateKnownFailureCheck({
				status: result.status,
				output: `${result.stdout}${result.stderr}`,
				entries,
			}),
		};
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function runProofCommand(repoRoot, env, label, args) {
	const result = runCommand("npm", args, { cwd: repoRoot, env });
	return {
		label,
		command: ["npm", ...args],
		status: result.status,
		pass: result.status === 0,
		outputTail: commandOutput(result).slice(-4000),
	};
}

function writeDecision(repoRoot, decision) {
	const artifactDirectory = join(repoRoot, GATE_ARTIFACT_DIR);
	mkdirSync(artifactDirectory, { recursive: true });
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
	const path = join(artifactDirectory, `decision-${stamp}.json`);
	const latestPath = join(artifactDirectory, "latest.json");
	const content = `${JSON.stringify(decision, null, 2)}\n`;
	writeFileSync(path, content, "utf8");
	writeFileSync(latestPath, content, "utf8");
	return path;
}

export function createDecision({ repoRoot, allowlistPath, entries, sourceEvidence, current, pristine, proofs, overrideRequested }) {
	const proofPass = proofs.every((proof) => proof.pass);
	const sourcePass = sourceEvidence.every((evidence) => evidence.revisionMatches && evidence.digestMatches && evidence.lineMatches);
	const currentPass = current.exact || current.normalPass;
	const pristinePass = pristine.evaluation.exact;
	return {
		kind: "known-upstream-failure-decision",
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		repoRoot,
		allowlistPath,
		allowlistIds: entries.map((entry) => entry.id),
		overrideRequested,
		currentCheck: { status: current.status, exactKnownFailureSet: current.exact, normalPass: current.normalPass },
		pristineUpstream: { status: pristine.status, exactKnownFailureSet: pristine.evaluation.exact },
		sourceEvidence,
		proofs,
		decision: currentPass && (current.normalPass || (sourcePass && pristinePass && proofPass)) ? "ALLOW" : "BLOCK",
		criteria: {
			currentCheckIsNormalPassOrExactKnownSet: currentPass,
			pinnedSourceMatches: sourcePass,
			pristineUpstreamReproducesExactSet: pristinePass,
			pphProofsPass: proofPass,
		},
	};
}

export function runGate({ cwd = process.cwd(), allowlistPath = DEFAULT_ALLOWLIST_PATH, overrideRequested = false } = {}) {
	if (!overrideRequested) throw new Error("explicit --allow-known-upstream-failure is required");
	const repoRoot = gitText(cwd, ["rev-parse", "--show-toplevel"]);
	const entries = loadKnownFailureAllowlist(allowlistPath);
	const isolationRoot = mkdtempSync(join(tmpdir(), "pph-known-failure-gate-"));
	const env = safeEnvironment(isolationRoot);
	let current;
	let pristine;
	let sourceEvidence = [];
	let proofs = [];
	try {
		sourceEvidence = verifySources(repoRoot, entries);
		const currentResult = runCommand("npm", ["run", "check"], { cwd: repoRoot, env });
		current = evaluateKnownFailureCheck({
			status: currentResult.status,
			output: `${currentResult.stdout}${currentResult.stderr}`,
			entries,
		});
		if (!current.exact && !current.normalPass) throw new Error("current check is neither a normal pass nor the exact known failure set");
		if (current.normalPass) {
			pristine = { status: 0, evaluation: { exact: false, normalPass: true } };
		} else {
			pristine = runPristineCheck(repoRoot, entries, isolationRoot, env);
			if (!pristine.evaluation.exact) throw new Error("pristine upstream did not reproduce the exact known failure set");
		}
		proofs = [
			runProofCommand(repoRoot, env, "PPH build", ["run", "build", "--workspace=@personal-pi/core"]),
			runProofCommand(repoRoot, env, "PPH targeted tests", ["run", "test", "--workspace=@personal-pi/core"]),
			runProofCommand(repoRoot, env, "PPH regression suite", ["run", "test:personal-pi-regression"]),
			runProofCommand(repoRoot, env, "PPH protocol isolation", ["run", "check:protocol-isolation", "--workspace=@personal-pi/core"]),
		];
		const decision = createDecision({
			repoRoot,
			allowlistPath,
			entries,
			sourceEvidence,
			current,
			pristine,
			proofs,
			overrideRequested,
		});
		const decisionPath = writeDecision(repoRoot, decision);
		if (decision.decision !== "ALLOW") throw new Error(`known upstream failure gate blocked; evidence: ${decisionPath}`);
		console.log(`Known-Upstream-Failure Gate: ALLOW (exact fingerprint; evidence ${decisionPath})`);
		return { pass: true, decision, decisionPath };
	} finally {
		rmSync(isolationRoot, { recursive: true, force: true });
	}
}

function parseArgs(argv) {
	const options = { allowlistPath: DEFAULT_ALLOWLIST_PATH, overrideRequested: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--allow-known-upstream-failure") options.overrideRequested = true;
		else if (argument === "--allowlist") {
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw new Error("--allowlist requires a value");
			options.allowlistPath = resolve(value);
		} else if (argument === "--help" || argument === "-h") options.help = true;
		else throw new Error(`unknown option: ${argument}`);
	}
	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/known-upstream-failure-gate.mjs --allow-known-upstream-failure [--allowlist PATH]

Run the normal check, prove the exact pinned upstream TypeScript failure on a
pristine checkout, run PPH build/tests/protocol checks, and write an auditable
Decision/Evidence JSON file under .git/pph-known-upstream-failure-gate/.`);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) printHelp();
		else runGate(options);
	} catch (error) {
		console.error(`Known-Upstream-Failure Gate: BLOCK\n${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
