# Errors

## [ERR-20260913-001] vitest-cache-permission

**Logged**: 2026-09-13T07:20:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The sandboxed run of the PPH personal regression suite could not write Vitest's
configuration cache under the repository's package-local `node_modules`.

### Error

```text
EPERM: operation not permitted, open
packages/coding-agent/node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs
```

### Context

The command was `npm run test:personal-pi-regression`. The repository's existing
full-test procedure has the same cache-writing requirement.

### Suggested Fix

Run the test with the approved workspace authorization, or configure a writable
Vitest/Vite cache directory for the test process. Treat this as an execution
environment issue rather than a test failure.

### Metadata

- Reproducible: yes
- Related Files: scripts/personal-pi-regression-suite.mjs

## [ERR-20260913-002] pph-identity-expectation

**Logged**: 2026-09-13T07:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The first version of the new regression assertions assumed PPH changed the
published package name and used shorter environment variable names.

### Error

The repository's actual contract keeps the package name
`@earendil-works/pi-coding-agent` while changing `piConfig.name`, the binary,
and the config directory. The exported environment names are
`PPH_CODING_AGENT_DIR` and `PPH_CODING_AGENT_SESSION_DIR`.

### Context

The targeted Personal PI Regression Suite exposed both incorrect assumptions.
The existing `config.test.ts`, package manifest, shrinkwrap, and install-lock
are the authoritative local contract.

### Suggested Fix

Assert the identity fields that the fork intentionally owns, without asserting
an unrelated package-name change.

### Metadata

- Reproducible: yes
- Related Files: packages/coding-agent/test/personal-pi-regression.test.ts

## [ERR-20260913-003] npm-pack-log-permission

**Logged**: 2026-09-13T07:36:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The existing consumer-package script tests could not complete because npm
tried to write diagnostic logs below the user's home npm directory.

### Error

```text
npm error Log files were not written due to an error writing to the directory:
/Users/chenglong/.npm/_logs
```

### Context

`npm run test:scripts` reached the three existing `coding-agent-consumer`
tests, whose temporary `npm pack` commands were denied by the default sandbox.

### Suggested Fix

Run the existing script-test suite with the approved workspace authorization or
provide a writable npm cache/log directory for the child npm process.

### Metadata

- Reproducible: yes
- Related Files: scripts/coding-agent-consumer.test.mjs

## [ERR-20260913-004] existing-tsgo-baseline

**Logged**: 2026-09-13T07:40:00+08:00
**Priority**: medium
**Status**: pre-existing
**Area**: tests

### Summary

The repository-wide static check reached TypeScript validation but stopped on an
existing exhaustiveness error in the AI provider code, outside this change.

### Error

```text
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

### Context

`npm run check` passed Biome, dependency declarations, relative imports, entry
graphs, shrinkwrap, and install-lock validation before `tsgo --noEmit` failed.

### Suggested Fix

Resolve the upstream AI finish-reason exhaustiveness mismatch separately; do not
alter it as part of the T0.2 gate implementation.

### Metadata

- Reproducible: yes
- Related Files: packages/ai/src/api/google-shared.ts

## [ERR-20260913-005] clean-worktree-artifact-gap

**Logged**: 2026-09-13T07:59:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary

An isolated gate worktree installed npm dependencies but did not contain the
ignored generated model data or the built workspace artifacts required by the
repository's source tests.

### Error

The pure upstream run reported many missing modules and generated JSON files,
including `@earendil-works/pi-ai/utils/uuid` and provider data under
`packages/ai/src/providers/data/`, instead of the single known baseline failure.

### Context

`npm ci --ignore-scripts` intentionally does not hydrate ignored model data and
does not build workspace `dist` directories. The existing checkout already had
those inputs, which is why its ordinary `./test.sh` baseline did not show this
environment failure.

### Suggested Fix

Seed every gate worktree from the starting checkout's generated model-data
snapshot and required build artifacts, and fail early when those inputs are
missing. Keep the copied inputs identical across pure and projected runs.

### Metadata

- Reproducible: yes
- Related Files: scripts/upstream-upgrade-gate.mjs

## [ERR-20260914-001] personal-pi-vitest-cache-permission

**Logged**: 2026-09-14T17:00:00+08:00
**Priority**: medium
**Status**: environment-bounded
**Area**: tests

### Summary

The Personal PI core test command could not start because Vite could not write its temporary config bundle under the package-local node_modules cache.

### Error

```text
EPERM: operation not permitted, open packages/personal-pi/node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs
```

### Context

- Operation: `npm test --workspace=@personal-pi/core`
- The process exited during Vitest configuration loading, before any test assertion ran.
- The repository and source files were not changed by the failed command.

### Suggested Fix

Re-run the same command with the approved local execution boundary or a writable Vite cache. Treat this as an execution-environment failure, not a Personal PI regression.

### Metadata

- Reproducible: yes
- Related Files: `packages/personal-pi/vitest.config.ts`

## [ERR-20260914-002] audit-secret-scan-shell-arguments

**Logged**: 2026-09-14T17:02:00+08:00
**Priority**: low
**Status**: resolved
**Area**: audit tooling

### Summary

Two initial filenames-only secret-scan probes failed before scanning because the shell expression had an unmatched quote and the ripgrep end-of-options marker was supplied as a filename argument.

### Error

```text
zsh: unmatched \"
rg: --: No such file or directory
```

### Context

- The probes were intended to inspect only the current changed-file list and never printed matching content.
- No repository file was changed by either failed probe.

### Suggested Fix

Use a simple single-quoted marker expression and pass the candidate filename directly after the pattern; keep the scanner output limited to filenames.

### Metadata

- Reproducible: no
- Related Files: `/private/tmp/pph-a0-safety.P1IqAP/all-change-files.txt`

## [ERR-20260914-003] zsh-optional-glob-diagnostic

**Logged**: 2026-09-14T18:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: diagnostic tooling

### Summary

A grouped repository search used an optional `src/theme*` glob without a
matching path, so zsh stopped the command before that search completed.

### Error

```text
zsh: no matches found: packages/coding-agent/src/theme*
```

### Context

- The command was read-only and did not modify repository files.
- The remaining explicit-file inspections completed, but the theme search had
  to be rerun with concrete paths.

### Suggested Fix

Use `rg` with an explicit path list or disable unmatched-glob expansion only
for a controlled diagnostic; do not treat this shell error as a test failure.

### Metadata

- Reproducible: yes
- Related Files: `packages/coding-agent/test/theme-export.test.ts`, `packages/coding-agent/test/theme-picker.test.ts`

## [ERR-20260914-005] husky-failfast-gate-unreachable

**Logged**: 2026-09-14T18:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: commit gate

### Summary

The first normal commit attempt showed that Husky invokes the hook with
`sh -e`; a standalone failing `npm run check` exited before the following
`$?` branch could invoke the exact known-upstream-failure gate.

### Error

```text
husky - pre-commit script failed (code 2)
```

### Context

- The repository check reached only the pinned upstream TS2322 diagnostic.
- The intended fail-closed known-failure gate was not executed.
- The commit was rejected and no commit was created.

### Suggested Fix

Put commands whose non-zero result is an expected branch condition directly
in an `if` statement under Husky's fail-fast shell.

### Metadata

- Reproducible: yes
- Related Files: `.husky/pre-commit`, `scripts/known-upstream-failure-gate.mjs`

## [ERR-20260914-004] zsh-readonly-status-variable

**Logged**: 2026-09-14T18:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: diagnostic tooling

### Summary

A check wrapper used the zsh special variable name `status` for the exit code,
so zsh rejected the assignment before the repository check ran.

### Error

```text
zsh:1: read-only variable: status
```

### Context

- The wrapper was intended to preserve and report the exit code from
  `npm run check`.
- No repository check output was produced and no project file was changed by
  the failed wrapper.

### Suggested Fix

Use a task-specific variable such as `check_code`; never assign to zsh's
special `status` variable.

### Metadata

- Reproducible: yes
- Related Files: `scripts/known-upstream-failure-gate.mjs`

## [ERR-20260914-006] gate-worktree-index-lock

**Logged**: 2026-09-14T18:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: commit gate

### Summary

The first normal commit after making the hook reachable showed that a
pre-commit hook cannot safely run `git worktree add`: the parent commit holds
the repository index lock while the hook is executing.

### Error

```text
fatal: .git/index: index file open failed: Not a directory
```

### Context

- The same gate passed when invoked manually outside a commit.
- The failure was caused by the gate's temporary worktree mutation, not by
  the pinned upstream check.
- The commit was rejected and no commit was created.

### Suggested Fix

Materialize the pinned revision with `git archive` into a temporary directory
and extract it without modifying the main repository index or worktree list.

### Metadata

- Reproducible: yes
- Related Files: `scripts/known-upstream-failure-gate.mjs`, `.husky/pre-commit`

## [ERR-20260915-001] coding-agent-concurrent-suite-isolation

**Logged**: 2026-09-15T00:45:00+08:00
**Priority**: medium
**Status**: environment-bounded
**Area**: tests

### Summary

The complete coding-agent suite showed three failures in the concurrent
session test file when run with the default file-parallel execution and an
isolated HOME. The same file passed all seven tests when run from the
coding-agent package root with one Vitest worker and file parallelism disabled.

### Error

```text
agent-session-concurrent.test.ts: expected session.isStreaming to be true, received false
agent-session-concurrent.test.ts: Test timed out in 30000ms
Unhandled rejection: No API key found for anthropic
```

### Context

- Full isolated run: 265/273 files and 2236/2293 tests passed; 3 tests and 2
  unhandled errors were reported in this file.
- Serial diagnostic: `agent-session-concurrent.test.ts` passed 1 file/7 tests.
- The v3.1 Personal PI implementation does not modify this coding-agent
  session surface, and no real or fake provider credential was added.

### Suggested Fix

Keep the concurrent suite result disclosed as an environment-specific
diagnostic until the shared auth/runtime test isolation is repaired upstream.
Use the serial package-root command for attribution only; do not turn it into a
skip or weaken the repository gate.

### Metadata

- Reproducible: yes under the isolated parallel invocation; serial isolation passes
- Related Files: `packages/coding-agent/test/agent-session-concurrent.test.ts`

## [ERR-20260915-002] schedule-no-match-branch

**Logged**: 2026-09-15T09:02:00+08:00
**Priority**: low
**Status**: resolved
**Area**: runtime

### Summary

The first scheduled memory-consolidation test exposed an ambiguous `created: false`
branch. A schedule that did not match was treated like a duplicate idempotency
retry and incorrectly returned a NO_OP record.

### Root Cause

`TriggerGateway.createFromSchedule` uses `created: false` for both a schedule
miss and a duplicate. The caller must inspect the explicit reason before
reconstructing a duplicate record.

### Resolution

`MemoryConsolidator.consolidateFromSchedule` now returns `undefined` for any
non-duplicate trigger result and only emits the deterministic NO_OP retry for
`duplicate idempotency_key`.

### Verification

- `memory-consolidation.test.ts`: 1 file / 4 tests PASS
- Related Files: `packages/personal-pi/src/memory-consolidation.ts`,
  `packages/personal-pi/test/memory-consolidation.test.ts`

## [ERR-20260915-003] workspace-aggregate-client-entry

**Logged**: 2026-09-15T09:24:00+08:00
**Priority**: medium
**Status**: environment-bounded
**Area**: tests

### Summary

The repository's isolated `./test.sh` aggregate run failed in the client
workspace before the dependent package entry was available, while the
standalone coding-agent and Personal PI suites passed in their own package
roots.

### Error

```text
Failed to resolve entry for package "@earendil-works/pi-agent-core".
The package may have incorrect main/module/exports specified in its package.json.
```

### Context

- Aggregate run: agent 711/712, chord 162/162, server 44/44, telemetry 15/15,
  coding-agent 266/273 files and 2239/2293 tests, Personal PI 173/173 tests.
- Only `packages/client/test/unix.test.ts` failed (19/19 tests in the file
  were otherwise reported as passed); the failure occurred while importing
  `packages/server/src/server.ts` through the workspace package entry.
- The same client entry-resolution baseline is already recorded in the Phase 0
  differential evidence and is unrelated to Personal PI v3.1 source changes.

### Suggested Fix

Keep the aggregate failure visible until workspace build ordering or the
package entry artifact is repaired. Do not skip the client suite or alter
published package metadata as part of the PPH v3.1 delta.

### Metadata

- Reproducible: yes under the isolated workspace aggregate invocation
- Related Files: `packages/client/test/unix.test.ts`,
  `packages/server/src/server.ts`

## [ERR-20260915-004] history-probe-parser

**Logged**: 2026-09-15T11:25:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

A one-off read-only Node.js parser used to extract historical Worker failure
messages stopped before processing because of an extra closing brace.

### Error

```text
SyntaxError: Unexpected token '}'
Expression expected
```

### Context

- The parser was an inline `node` script over bounded local rollout JSONL files.
- No repository, credential, account, or external service state was changed.
- The preceding inventory and usage-limit evidence remained valid.

### Suggested Fix

Keep bounded extraction scripts small, validate syntax before scanning large
JSONL files, and filter structured fields before emitting any output.

### Metadata

- Reproducible: no
- Related Files: `/Users/chenglong/.codex/sessions/2026/09/14/`

## [ERR-20260915-005] sandboxed-repository-verification

**Logged**: 2026-09-15T11:18:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The first verification attempt could not write Vitest temporary bundles or
ignored Personal PI build artifacts because the actual checkout is outside the
default writable sandbox root.

### Error

```text
EPERM: operation not permitted, open packages/personal-pi/node_modules/.vite-temp/...
TS5033: Could not write file packages/personal-pi/dist/...
```

### Context

- The affected commands were the existing Personal PI test/build and
  regression commands; no source file was changed.
- The same commands were rerun with narrowly scoped repository verification
  permission and passed.
- The unprivileged script-suite attempt also failed only while `npm pack`
  tried to write npm logs under the user cache; the rerun passed 29/29.

### Suggested Fix

When verifying this checkout from a restricted session, request only the
filesystem permission needed by the existing test/build command and keep the
failure classified as environment-bounded rather than as a code regression.

### Metadata

- Reproducible: yes in the default sandbox
- Related Files: `packages/personal-pi/vitest.config.ts`, `packages/personal-pi/dist/`, `scripts/coding-agent-consumer.test.mjs`
