import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareFailureSets,
  evaluateTestResult,
  parseTestFailures,
  runCompatibilitySuite,
} from "./upstream-compatibility-suite.mjs";
import { assertMainUnchanged } from "./upstream-upgrade-gate.mjs";

const knownFailure = {
  packageName: "@earendil-works/pi-client",
  testFile: "test/unix.test.ts",
  kind: "suite",
  testName: null,
  errorType: "Error",
  message:
    'Failed to resolve entry for package "@earendil-works/pi-agent-core". The package may have incorrect main/module/exports specified in its package.json.',
};

const allowlistEntry = {
  id: "pi-client-unix-agent-core-entry",
  ...knownFailure,
  reason: "test-only upstream baseline",
  expectedCount: 1,
};

test("parses package, suite, error type, and normalized message", () => {
  const output = `> @earendil-works/pi-client@0.85.1 test\n\u001b[31mFAIL  test/unix.test.ts [ test/unix.test.ts ]\u001b[39m\nError: Failed to resolve entry for package "@earendil-works/pi-agent-core". The package may have incorrect main/module/exports specified in its package.json.\n`;
  assert.deepEqual(parseTestFailures(output), [knownFailure]);
});

test("keeps package headings paired with failures across output streams", () => {
  const root = mkdtempSync(join(tmpdir(), "pph-gate-output-test-"));
  try {
    const allowlistPath = join(root, "allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify({ schemaVersion: 1, entries: [] }));
    const result = runCompatibilitySuite({
      cwd: process.cwd(),
      command: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("> @example/pi@0.0.0 test\\n");',
          'process.stderr.write("FAIL  test/unix.test.ts [ test/unix.test.ts ]\\nError: merged stream failure\\n");',
          "process.exitCode = 1;",
        ].join(" "),
      ],
      allowlistPath,
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].packageName, "@example/pi");
    assert.equal(result.failures[0].message, "merged stream failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes one exact known failure and rejects a changed fingerprint", () => {
  const allowlist = [allowlistEntry];
  const withoutPackage = `FAIL  test/unix.test.ts\n${knownFailure.errorType}: ${knownFailure.message}`;
  assert.equal(evaluateTestResult({ status: 1, output: withoutPackage, allowlist }).pass, false);

  const withPackage = `> ${knownFailure.packageName}@0.85.1 test\nFAIL  ${knownFailure.testFile} [ ${knownFailure.testFile} ]\n${knownFailure.errorType}: ${knownFailure.message}`;
  assert.equal(evaluateTestResult({ status: 1, output: withPackage, allowlist }).pass, true);

  const changed = withPackage.replace("pi-agent-core", "pi-agent-core-next");
  const changedResult = evaluateTestResult({ status: 1, output: changed, allowlist });
  assert.equal(changedResult.pass, false);
  assert.equal(changedResult.unexpected.length, 1);
});

test("rejects stale allowlist entries and unexpected failures", () => {
  const stale = evaluateTestResult({ status: 0, output: "", allowlist: [allowlistEntry] });
  assert.equal(stale.pass, false);
  assert.equal(stale.staleAllowlist.length, 1);

  const extra = `> @earendil-works/pi-client@0.85.1 test\nFAIL  test/other.test.ts [ test/other.test.ts ]\nError: unexpected upstream regression`;
  const unexpected = evaluateTestResult({ status: 1, output: extra, allowlist: [] });
  assert.equal(unexpected.pass, false);
  assert.equal(unexpected.unexpected.length, 1);
});

test("compares failure sets independent of output order", () => {
  const other = { ...knownFailure, testFile: "test/other.test.ts" };
  assert.equal(compareFailureSets([knownFailure, other], [other, knownFailure]), true);
  assert.equal(compareFailureSets([knownFailure], [other]), false);
});

test("rejects an unexpected main ref change", () => {
  assert.throws(() => assertMainUnchanged("aaa", "bbb"), /main changed/);
  assert.doesNotThrow(() => assertMainUnchanged("aaa", "aaa"));
});

test("keeps JSON data separate from parser behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "pph-gate-test-"));
  try {
    const path = join(root, "allowlist.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: [allowlistEntry] }));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).entries[0].id, allowlistEntry.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
