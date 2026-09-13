import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ALLOWLIST_PATH,
  compareFailureSets,
  formatEvaluation,
  formatFailure,
  runCompatibilitySuite,
} from "./upstream-compatibility-suite.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = resolve(SCRIPT_DIR, "pph-personalization-manifest.json");
const DEFAULT_REMOTE = "upstream";
const DEFAULT_UPSTREAM_BRANCH = "main";
const DEFAULT_SYNC_BRANCH = "upstream-sync";
const MAX_BUFFER = 64 * 1024 * 1024;
const GATE_TEMP_PARENT = process.platform === "win32" ? tmpdir() : "/tmp";

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
  const result = runCommand("git", args, { cwd: options.cwd ?? repoRoot, stdio: options.stdio });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed${commandOutput(result) ? `: ${commandOutput(result)}` : ""}`);
  }
  return result;
}

function gitText(repoRoot, args, options = {}) {
  const result = runGit(repoRoot, args, options);
  return result.stdout.trim();
}

function resolveCommit(repoRoot, ref) {
  return gitText(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function currentBranch(repoRoot) {
  return gitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function assertClean(repoRoot, label) {
  const status = gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    throw new Error(`${label} must be clean before the upgrade gate runs:\n${status}`);
  }
}

function isAncestor(repoRoot, older, newer) {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", older, newer], {
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`could not compare ancestry for ${older} and ${newer}`);
}

export function assertMainUnchanged(expectedSha, observedSha) {
  if (expectedSha !== observedSha) {
    throw new Error(`main changed during the upgrade gate: expected ${expectedSha}, observed ${observedSha}`);
  }
}

function branchRef(branch) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`invalid branch name: ${branch}`);
  }
  return `refs/heads/${branch}`;
}

function loadJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label} ${path}: ${error.message}`);
  }
  return parsed;
}

function loadManifest(path) {
  const manifest = loadJson(path, "personalization manifest");
  if (manifest?.schemaVersion !== 1) throw new Error("personalization manifest schemaVersion must be 1");
  if (!Array.isArray(manifest.ownedFiles) || !Array.isArray(manifest.identityProjectionFiles)) {
    throw new Error("personalization manifest must define ownedFiles and identityProjectionFiles arrays");
  }

  const owned = new Set(manifest.ownedFiles);
  if (owned.size !== manifest.ownedFiles.length) throw new Error("personalization manifest has duplicate ownedFiles");
  for (const file of [...manifest.ownedFiles, ...manifest.identityProjectionFiles]) {
    if (typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.split("/").includes("..")) {
      throw new Error(`invalid repository-relative path in personalization manifest: ${file}`);
    }
  }
  for (const file of manifest.identityProjectionFiles) {
    if (!owned.has(file)) throw new Error(`identity projection file is not owned: ${file}`);
  }
  return manifest;
}

function changedFiles(repoRoot, left, right) {
  const output = gitText(repoRoot, ["diff", "--name-only", "--no-renames", left, right]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function workingTreeFiles(repoRoot) {
  const output = gitText(repoRoot, ["diff", "--name-only", "--no-renames"]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function assertOwnedDiff(repoRoot, targetSha, candidateSha, manifest) {
  const allowed = new Set(manifest.ownedFiles);
  const changed = changedFiles(repoRoot, targetSha, candidateSha);
  const unexpected = changed.filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    throw new Error(
      `candidate changes files outside the personalization manifest:\n${unexpected.join("\n")}`,
    );
  }
  if (changed.length === 0) throw new Error("candidate does not contain an upstream upgrade or gate changes");
}

function gitShowFile(repoRoot, ref, file) {
  const result = runGit(repoRoot, ["show", `${ref}:${file}`], { allowFailure: true });
  if (result.status === 0) return Buffer.from(result.stdout, "utf8");
  if (/does not exist|exists on disk, but not in/i.test(commandOutput(result))) return undefined;
  throw new Error(`could not read ${file} from ${ref}: ${commandOutput(result)}`);
}

function projectIdentityFiles(repoRoot, checkout, targetSha, files) {
  for (const file of files) {
    const destination = join(checkout, file);
    const content = gitShowFile(repoRoot, targetSha, file);
    if (content === undefined) {
      rmSync(destination, { force: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  const unexpected = workingTreeFiles(checkout).filter((file) => !files.includes(file));
  if (unexpected.length > 0) {
    throw new Error(
      `identity projection changed files outside identityProjectionFiles:\n${unexpected.join("\n")}`,
    );
  }
}

function createWorktree(repoRoot, ref, label) {
	const temporaryRoot = mkdtempSync(join(GATE_TEMP_PARENT, `pph-${label}-`));
  const checkout = join(temporaryRoot, "checkout");
  try {
    runGit(repoRoot, ["worktree", "add", "--detach", checkout, ref]);
    return { temporaryRoot, checkout };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeWorktree(repoRoot, worktree) {
  if (!worktree) return;
  if (existsSync(worktree.checkout)) {
    runGit(repoRoot, ["worktree", "remove", "--force", worktree.checkout], { allowFailure: true });
  }
  rmSync(worktree.temporaryRoot, { recursive: true, force: true });
  runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
}

function prepareDependencies(repoRoot, checkout) {
  const result = runCommand(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: checkout, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`npm ci failed in ${checkout}`);
  copyWorkspaceArtifacts(repoRoot, checkout);
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
const REQUIRED_WORKSPACE_ARTIFACT_PATHS = [
  "packages/ai/dist",
  "packages/chord/dist",
  "packages/telemetry/dist",
  "packages/tui/dist",
];

function copyWorkspaceArtifacts(repoRoot, checkout) {
  const modelData = join(repoRoot, "packages", "ai", "src", "providers", "data");
  if (!existsSync(modelData)) {
    throw new Error(
      `generated model data is missing at ${modelData}; hydrate/build the checked-out repository before running the gate`,
    );
  }
  cpSync(modelData, join(checkout, "packages", "ai", "src", "providers", "data"), { recursive: true });

  const missingArtifacts = REQUIRED_WORKSPACE_ARTIFACT_PATHS.filter(
    (relativePath) => !existsSync(join(repoRoot, relativePath)),
  );
  if (missingArtifacts.length > 0) {
    throw new Error(
      `required build artifacts are missing (${missingArtifacts.join(", ")}); run the normal build before the gate`,
    );
  }

  for (const relativePath of WORKSPACE_ARTIFACT_PATHS) {
    const source = join(repoRoot, relativePath);
    if (!existsSync(source)) continue;
    cpSync(source, join(checkout, relativePath), { recursive: true });
  }
}

function createCandidate(repoRoot, sourceSha, targetSha, candidateBranch) {
	const temporaryRoot = mkdtempSync(join(GATE_TEMP_PARENT, "pph-upstream-candidate-"));
  const checkout = join(temporaryRoot, "checkout");
  const ref = branchRef(candidateBranch);
  if (runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true }).status === 0) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`candidate branch already exists: ${candidateBranch}`);
  }

  try {
    runGit(repoRoot, ["worktree", "add", "-b", candidateBranch, checkout, sourceSha]);
    const merge = runCommand(
      "git",
      [
        "-c",
        "user.name=PPH Upgrade Gate",
        "-c",
        "user.email=pph-upgrade-gate@localhost",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--no-edit",
        "--no-ff",
        targetSha,
      ],
      { cwd: checkout },
    );
    if (merge.status !== 0) {
      runGit(checkout, ["merge", "--abort"], { allowFailure: true });
      throw new Error(`candidate merge failed${commandOutput(merge) ? `: ${commandOutput(merge)}` : ""}`);
    }
    const candidateSha = resolveCommit(checkout, "HEAD");
    if (candidateSha === sourceSha || !isAncestor(repoRoot, sourceSha, candidateSha)) {
      throw new Error("candidate merge did not create a descendant of main");
    }
    return { temporaryRoot, checkout, candidateBranch, candidateSha };
  } catch (error) {
    if (existsSync(checkout)) {
      runGit(repoRoot, ["worktree", "remove", "--force", checkout], { allowFailure: true });
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
    runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
    throw error;
  }
}

function removeCandidateWorktree(repoRoot, candidate) {
  if (!candidate) return;
  removeWorktree(repoRoot, candidate);
}

function printCompatibilityResult(label, result) {
  console.log(`${label}: ${formatEvaluation(result)}`);
  if (result.pass) return;
  for (const failure of result.unexpected) console.error(`  unexpected ${formatFailure(failure)}`);
  for (const mismatch of result.mismatches) {
    console.error(
      `  allowlist mismatch ${mismatch.id}: expected ${mismatch.expectedCount}, actual ${mismatch.actualCount}`,
    );
  }
  for (const failure of result.failures) {
    if (!result.unexpected.includes(failure)) continue;
    console.error(`  failure ${formatFailure(failure)}`);
  }
}

function runPersonalRegression(checkout) {
  console.log("Personal PI Regression Suite: running on the unprojected candidate");
  const result = runCommand(
    process.execPath,
    [join(checkout, "scripts", "personal-pi-regression-suite.mjs")],
    { cwd: checkout, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Personal PI Regression Suite failed");
}

function updateUpstreamSync(repoRoot, syncBranch, previousSha, targetSha) {
  if (previousSha === targetSha) throw new Error("upstream has no new commit since upstream-sync");
  if (!isAncestor(repoRoot, previousSha, targetSha)) {
    throw new Error(`upstream target ${targetSha} is not a fast-forward from upstream-sync ${previousSha}`);
  }
  runGit(repoRoot, ["update-ref", branchRef(syncBranch), targetSha, previousSha]);
  if (resolveCommit(repoRoot, branchRef(syncBranch)) !== targetSha) {
    throw new Error("upstream-sync did not update to the fetched target");
  }
}

function fetchTarget(repoRoot, options) {
  if (options.upstreamRef) return resolveCommit(repoRoot, options.upstreamRef);
  const trackingRef = `refs/remotes/${options.remote}/${options.upstreamBranch}`;
  if (!options.noFetch) {
    runGit(repoRoot, ["fetch", "--no-tags", options.remote, options.upstreamBranch], { stdio: "inherit" });
  }
  return resolveCommit(repoRoot, trackingRef);
}

function parseArgs(argv) {
  const options = {
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
    noFetch: false,
    promote: false,
    remote: DEFAULT_REMOTE,
    syncBranch: DEFAULT_SYNC_BRANCH,
    upstreamBranch: DEFAULT_UPSTREAM_BRANCH,
    upstreamRef: undefined,
  };
  const valueOptions = new Map([
    ["--allowlist", "allowlistPath"],
    ["--manifest", "manifestPath"],
    ["--upstream-ref", "upstreamRef"],
    ["--upstream-remote", "remote"],
    ["--upstream-branch", "upstreamBranch"],
    ["--sync-branch", "syncBranch"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--no-fetch") {
      options.noFetch = true;
      continue;
    }
    if (argument === "--promote") {
      options.promote = true;
      continue;
    }
    const optionName = valueOptions.get(argument);
    if (!optionName) throw new Error(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[optionName] = value;
    index += 1;
  }

  options.allowlistPath = resolve(options.allowlistPath);
  options.manifestPath = resolve(options.manifestPath);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/upstream-upgrade-gate.mjs [options]

Fetch the official upstream target, update upstream-sync with CAS, create a
local merge candidate, run both compatibility checks, and protect main.

Options:
  --promote                 fast-forward main after both suites pass
  --no-fetch                use the existing upstream remote-tracking ref
  --upstream-ref REF        use an explicit local commit/ref instead of fetching
  --upstream-remote NAME    upstream remote name (default: upstream)
  --upstream-branch NAME    upstream branch (default: main)
  --sync-branch NAME        local CAS-tracked branch (default: upstream-sync)
  --allowlist PATH          exact upstream failure fingerprint JSON
  --manifest PATH            personalization ownership manifest JSON`);
}

export function runGate(options = {}) {
  options = defaultOptions(options);
  if (options.help) {
    printHelp();
    return { pass: true, help: true };
  }

  const repoRoot = gitText(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const mainBefore = resolveCommit(repoRoot, "refs/heads/main");
  let candidate;
  let pureWorktree;
  let projectedWorktree;
  let promoted = false;

  try {
    if (currentBranch(repoRoot) !== "main" || resolveCommit(repoRoot, "HEAD") !== mainBefore) {
      throw new Error("the gate must start from the clean main branch");
    }
    assertClean(repoRoot, "main");

    const manifest = loadManifest(options.manifestPath);
    const previousSync = resolveCommit(repoRoot, branchRef(options.syncBranch));
    const targetSha = fetchTarget(repoRoot, options);
    console.log(`Upstream target: ${targetSha}`);
    updateUpstreamSync(repoRoot, options.syncBranch, previousSync, targetSha);
    console.log(`upstream-sync: ${previousSync} -> ${targetSha} (CAS PASS)`);

    candidate = createCandidate(repoRoot, mainBefore, targetSha, options.candidateBranch);
    prepareDependencies(repoRoot, candidate.checkout);
    assertOwnedDiff(repoRoot, targetSha, candidate.candidateSha, manifest);
    console.log(`Candidate: ${options.candidateBranch} @ ${candidate.candidateSha}`);

    pureWorktree = createWorktree(repoRoot, targetSha, "upstream-pure");
    prepareDependencies(repoRoot, pureWorktree.checkout);
    const pureResult = runCompatibilitySuite({
      cwd: pureWorktree.checkout,
      allowlistPath: options.allowlistPath,
    });
    printCompatibilityResult("Upstream Compatibility Suite / pure upstream", pureResult);
    if (!pureResult.pass) throw new Error("pure upstream compatibility suite failed");

    projectedWorktree = createWorktree(repoRoot, candidate.candidateSha, "upstream-projected");
    projectIdentityFiles(
      repoRoot,
      projectedWorktree.checkout,
      targetSha,
      manifest.identityProjectionFiles,
    );
    prepareDependencies(repoRoot, projectedWorktree.checkout);
    const projectedResult = runCompatibilitySuite({
      cwd: projectedWorktree.checkout,
      allowlistPath: options.allowlistPath,
    });
    printCompatibilityResult(
      "Upstream Compatibility Suite / candidate with PPH identity projected out",
      projectedResult,
    );
    if (!projectedResult.pass) throw new Error("projected candidate compatibility suite failed");
    if (!compareFailureSets(pureResult.failures, projectedResult.failures)) {
      throw new Error("pure upstream and projected candidate failure fingerprints differ");
    }
    console.log("Compatibility failure fingerprints: exact match (PASS)");

    runPersonalRegression(candidate.checkout);
    console.log("Personal PI Regression Suite: PASS");

    assertMainUnchanged(mainBefore, resolveCommit(repoRoot, "refs/heads/main"));
    if (resolveCommit(repoRoot, branchRef(options.syncBranch)) !== targetSha) {
      throw new Error("upstream-sync changed while the suites were running");
    }

    if (options.promote) {
      if (!isAncestor(repoRoot, mainBefore, candidate.candidateSha)) {
        throw new Error("candidate is not fast-forwardable from main");
      }
      runGit(repoRoot, ["merge", "--ff-only", options.candidateBranch], { stdio: "inherit" });
      assertMainUnchanged(candidate.candidateSha, resolveCommit(repoRoot, "refs/heads/main"));
      promoted = true;
      console.log("main protection: PASS (fast-forward promotion completed locally)");
      console.log("Stage Gate: CLOSED");
    } else {
      console.log("main protection: PASS (promotion not requested; main unchanged)");
      console.log("Stage Gate: PASS");
    }

    return {
      pass: true,
      candidateBranch: options.candidateBranch,
      candidateSha: candidate.candidateSha,
      mainBefore,
      promoted,
      targetSha,
    };
  } catch (error) {
    let protection = "unknown";
    try {
      assertMainUnchanged(mainBefore, resolveCommit(repoRoot, "refs/heads/main"));
      protection = "PASS (main unchanged)";
    } catch (protectionError) {
      protection = `FAIL (${protectionError.message})`;
    }
    console.error(`main protection: ${protection}`);
    throw error;
  } finally {
    removeWorktree(repoRoot, projectedWorktree);
    removeWorktree(repoRoot, pureWorktree);
    removeCandidateWorktree(repoRoot, candidate);
  }
}

function defaultOptions(options) {
  return {
    ...options,
    candidateBranch:
      options.candidateBranch ?? `codex/upstream-candidate-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`,
  };
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    runGate(defaultOptions(parseArgs(process.argv.slice(2))));
} catch (error) {
    console.error(
      `Upstream Upgrade Gate: FAIL\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
