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
