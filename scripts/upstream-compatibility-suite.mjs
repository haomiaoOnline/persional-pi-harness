import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST_PATH = resolve(SCRIPT_DIR, "upstream-compatibility-allowlist.json");

const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const ERROR_PATTERN = /^(Error|[A-Za-z][A-Za-z ]*Error):\s*(.*)$/;

export function stripAnsi(value) {
	return value.replace(ANSI_PATTERN, "");
}

function normalizeLine(value) {
	return value.replace(/\\/g, "/").trim();
}

function parseFailureHeader(value) {
	const suiteMatch = /^(.*?)\s+\[\s*(.*?)\s*\]$/.exec(value);
	if (suiteMatch) {
		return {
			kind: "suite",
			testFile: normalizeLine(suiteMatch[1]),
			testName: null,
		};
	}

	const separator = value.indexOf(" > ");
	if (separator === -1) {
		return { kind: "test", testFile: normalizeLine(value), testName: null };
	}

	return {
		kind: "test",
		testFile: normalizeLine(value.slice(0, separator)),
		testName: value.slice(separator + 3).trim(),
	};
}

function parseError(lines) {
	for (const line of lines) {
		const match = ERROR_PATTERN.exec(line.trim());
		if (match) {
			return { errorType: match[1], message: normalizeLine(match[2]) };
		}
	}
	return { errorType: null, message: null };
}

export function parseTestFailures(output) {
	const lines = stripAnsi(output).replace(/\r\n/g, "\n").split("\n");
	const failures = [];
	let packageName = null;

	for (let index = 0; index < lines.length; index += 1) {
		const packageMatch = /^> (.+)@(\d[^ ]*) test$/.exec(lines[index].trim());
		if (packageMatch) {
			packageName = packageMatch[1];
			continue;
		}

		const failureMatch = /^FAIL\s{2,}(.+)$/.exec(lines[index].trim());
		if (!failureMatch) continue;

		const header = parseFailureHeader(failureMatch[1].trim());
		const detailLines = [];
		for (let detailIndex = index + 1; detailIndex < lines.length; detailIndex += 1) {
			const detailLine = lines[detailIndex].trim();
			if (
				/^FAIL\s{2,}/.test(detailLine) ||
				/^⎯/.test(detailLine) ||
				/^Test Files\s/.test(detailLine) ||
				/^> /.test(detailLine)
			) {
				break;
			}
			detailLines.push(lines[detailIndex]);
		}

		const error = parseError(detailLines);
		failures.push({
			packageName: packageName ?? "<unknown>",
			testFile: header.testFile,
			kind: header.kind,
			testName: header.testName,
			errorType: error.errorType,
			message: error.message,
		});
	}

	return failures;
}

function validateAllowlistEntry(entry, index) {
	if (!entry || typeof entry !== "object") {
		throw new Error(`Invalid upstream compatibility allowlist entry at index ${index}`);
	}
	for (const field of ["id", "packageName", "testFile", "kind", "errorType", "message", "reason"]) {
		if (typeof entry[field] !== "string" || entry[field].length === 0) {
			throw new Error(`Allowlist entry ${index} must define a non-empty ${field}`);
		}
	}
	if (entry.kind !== "suite" && entry.kind !== "test") {
		throw new Error(`Allowlist entry ${entry.id} has unsupported kind ${entry.kind}`);
	}
	if (entry.testName !== null && typeof entry.testName !== "string") {
		throw new Error(`Allowlist entry ${entry.id} must set testName to a string or null`);
	}
	if (!Number.isInteger(entry.expectedCount) || entry.expectedCount < 1) {
		throw new Error(`Allowlist entry ${entry.id} must have a positive integer expectedCount`);
	}
}

export function loadAllowlist(path = DEFAULT_ALLOWLIST_PATH) {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
		throw new Error(`Invalid upstream compatibility allowlist schema: ${path}`);
	}

	const ids = new Set();
	for (const [index, entry] of parsed.entries.entries()) {
		validateAllowlistEntry(entry, index);
		if (ids.has(entry.id)) throw new Error(`Duplicate upstream compatibility allowlist id: ${entry.id}`);
		ids.add(entry.id);
	}

	return parsed.entries;
}

function matchesEntry(entry, failure) {
	return (
		entry.packageName === failure.packageName &&
		entry.testFile === failure.testFile &&
		entry.kind === failure.kind &&
		entry.testName === failure.testName &&
		entry.errorType === failure.errorType &&
		entry.message === failure.message
	);
}

export function failureFingerprint(failure) {
	return JSON.stringify({
		packageName: failure.packageName,
		testFile: failure.testFile,
		kind: failure.kind,
		testName: failure.testName,
		errorType: failure.errorType,
		message: failure.message,
	});
}

export function evaluateTestResult({ status, output, allowlist }) {
	const failures = parseTestFailures(output);
	const matchedIndices = new Set();
	const mismatches = [];

	for (const entry of allowlist) {
		const matchingIndices = failures
			.map((failure, index) => (matchesEntry(entry, failure) ? index : -1))
			.filter((index) => index !== -1);
		if (matchingIndices.length !== entry.expectedCount) {
			mismatches.push({
				id: entry.id,
				expectedCount: entry.expectedCount,
				actualCount: matchingIndices.length,
			});
		}
		for (const index of matchingIndices) matchedIndices.add(index);
	}

	const unexpected = failures.filter((_failure, index) => !matchedIndices.has(index));
	const staleAllowlist = mismatches.filter((mismatch) => mismatch.actualCount === 0);
	const expectedFailuresMatch = mismatches.length === 0 && unexpected.length === 0;
	const pass =
		status === 0
			? failures.length === 0 && allowlist.length === 0
			: status !== null && expectedFailuresMatch && failures.length > 0;

	return {
		pass,
		status,
		failures,
		unexpected,
		mismatches,
		staleAllowlist,
	};
}

export function compareFailureSets(left, right) {
	const normalize = (failures) => failures.map(failureFingerprint).sort();
	return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function runWithMergedOutput(file, args, options) {
	const outputRoot = mkdtempSync(resolve(tmpdir(), "pph-compat-output-"));
	const outputPath = resolve(outputRoot, "combined.log");
	const outputFd = openSync(outputPath, "w+");
	try {
		const result = spawnSync(file, args, {
			cwd: options.cwd,
			maxBuffer: 50 * 1024 * 1024,
			stdio: ["ignore", outputFd, outputFd],
		});
		return {
			...result,
			stdout: readFileSync(outputPath, "utf8"),
			stderr: "",
		};
	} finally {
		closeSync(outputFd);
		rmSync(outputRoot, { recursive: true, force: true });
	}
}

export function runCompatibilitySuite({
	cwd,
	command = "./test.sh",
	args = [],
	allowlistPath = DEFAULT_ALLOWLIST_PATH,
	executor = runWithMergedOutput,
} = {}) {
	const result = executor(command, args, { cwd });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const evaluation = evaluateTestResult({
		status: result.status,
		output,
		allowlist: loadAllowlist(allowlistPath),
	});
	return { ...evaluation, output, command, args, cwd };
}

export function formatFailure(failure) {
	const test = failure.testName ? ` > ${failure.testName}` : "";
	const error = failure.errorType ? `${failure.errorType}: ${failure.message}` : "no stable error fingerprint";
	return `${failure.packageName} ${failure.testFile}${test} [${failure.kind}] ${error}`;
}

export function formatEvaluation(result) {
	if (result.pass) {
		const known = result.failures.length > 0 ? ` (${result.failures.length} exact allowlisted failure)` : "";
		return `PASS${known}`;
	}

	const details = [];
	for (const mismatch of result.mismatches) {
		details.push(
			`${mismatch.id}: expected ${mismatch.expectedCount}, observed ${mismatch.actualCount}`,
		);
	}
	for (const failure of result.unexpected) details.push(`unexpected: ${formatFailure(failure)}`);
	return `FAIL${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
}

function parseArgs(argv) {
	const options = { cwd: process.cwd(), allowlistPath: DEFAULT_ALLOWLIST_PATH };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--cwd") options.cwd = resolve(argv[++index]);
		else if (arg === "--allowlist") options.allowlistPath = resolve(argv[++index]);
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
	try {
		const result = runCompatibilitySuite(parseArgs(process.argv.slice(2)));
		console.log(`Upstream Compatibility Suite: ${formatEvaluation(result)}`);
		if (!result.pass) {
			for (const failure of result.failures) console.error(formatFailure(failure));
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
