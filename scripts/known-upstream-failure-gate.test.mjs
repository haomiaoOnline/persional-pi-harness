import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createDecision,
	evaluateKnownFailureCheck,
	loadKnownFailureAllowlist,
	parseTypeScriptDiagnostics,
	verifySourceContent,
} from "./known-upstream-failure-gate.mjs";

const entry = {
	id: "known",
	packageName: "@earendil-works/pi-ai",
	file: "packages/ai/src/api/google-shared.ts",
	line: 402,
	errorCode: "TS2322",
	semanticMessage: "Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.",
	sourceNeedle: "const _exhaustive: never = reason;",
	upstreamRevision: "71dca871bc80b6bc97be37f0ca3189399d651fff",
	sourceDigest: "sha256:fa9a45177b6c1e1636b8b1ef4c8b332e903e4b379039cb1bacbbc312a8e1662d",
};

function diagnosticOutput(message = entry.semanticMessage) {
	return `packages/ai/src/api/google-shared.ts(402,10): error TS2322: ${message}\n`;
}

test("parses the exact TypeScript diagnostic without accepting summaries", () => {
	assert.deepEqual(parseTypeScriptDiagnostics(diagnosticOutput()), [
		{
			file: entry.file,
			line: 402,
			column: 10,
			errorCode: "TS2322",
			semanticMessage: entry.semanticMessage,
		},
	]);
});

test("allows only a non-zero exact known failure set", () => {
	const allowed = evaluateKnownFailureCheck({ status: 2, output: diagnosticOutput(), entries: [entry] });
	assert.equal(allowed.exact, true);
	assert.equal(allowed.normalPass, false);

	const changed = evaluateKnownFailureCheck({
		status: 2,
		output: diagnosticOutput().replace("TOO_MANY_TOOL_CALLS", "OTHER"),
		entries: [entry],
	});
	assert.equal(changed.exact, false);
	assert.equal(changed.unexpected.length, 1);

	const extra = `${diagnosticOutput()}packages/ai/src/api/google-shared.ts(100,1): error TS9999: new error\n`;
	assert.equal(evaluateKnownFailureCheck({ status: 2, output: extra, entries: [entry] }).exact, false);
	const unparsed = evaluateKnownFailureCheck({ status: 2, output: "error TS2322: unparseable\n", entries: [entry] });
	assert.equal(unparsed.exact, false);
	assert.equal(unparsed.unparsed.length, 1);
});

test("accepts a clean normal check only when no diagnostics exist", () => {
	assert.equal(evaluateKnownFailureCheck({ status: 0, output: "Found 0 errors.\n", entries: [entry] }).normalPass, true);
	assert.equal(evaluateKnownFailureCheck({ status: 0, output: diagnosticOutput(), entries: [entry] }).normalPass, false);
});

test("binds the source digest, revision, and exact source line", () => {
	const content = Buffer.from(`${"\n".repeat(401)}${entry.sourceNeedle}\n`, "utf8");
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
	const sourceEntry = { ...entry, sourceDigest: digest };
	assert.deepEqual(verifySourceContent(sourceEntry, content, entry.upstreamRevision), {
		id: entry.id,
		revisionMatches: true,
		digestMatches: true,
		lineMatches: true,
		observedDigest: digest,
		observedLine: entry.sourceNeedle,
	});
	assert.equal(verifySourceContent(sourceEntry, content, "0000000000000000000000000000000000000000").revisionMatches, false);
});

test("rejects malformed allowlist entries", () => {
	const root = mkdtempSync(join(tmpdir(), "pph-known-failure-test-"));
	try {
		const path = join(root, "bad.json");
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: [{ ...entry, line: 0 }] }));
		assert.throws(() => loadKnownFailureAllowlist(path), /positive line/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("decision requires source, pristine, and every PPH proof", () => {
	const sourceEvidence = [{ revisionMatches: true, digestMatches: true, lineMatches: true }];
	const pristine = { status: 2, evaluation: { exact: true } };
	const proofs = [
		{ label: "build", pass: true },
		{ label: "targeted", pass: true },
		{ label: "regression", pass: true },
		{ label: "protocol", pass: true },
	];
	const allowed = createDecision({
		repoRoot: "/repo",
		allowlistPath: "/allowlist",
		entries: [entry],
		sourceEvidence,
		current: { status: 2, exact: true, normalPass: false },
		pristine,
		proofs,
		overrideRequested: true,
	});
	assert.equal(allowed.decision, "ALLOW");
	assert.equal(
		createDecision({
			repoRoot: "/repo",
			allowlistPath: "/allowlist",
			entries: [entry],
			sourceEvidence,
			current: { status: 2, exact: true, normalPass: false },
			pristine,
			proofs: proofs.map((proof, index) => (index === 2 ? { ...proof, pass: false } : proof)),
			overrideRequested: true,
		}).decision,
		"BLOCK",
	);
});
