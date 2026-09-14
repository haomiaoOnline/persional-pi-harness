# T0.2 Upstream Upgrade Gate

This repository carries a small, intentional identity fork of PI. The upgrade
gate keeps that fork reviewable while allowing the upstream test suite to move
forward.

## What the gate proves

The gate has two independent obligations:

1. **Upstream Compatibility Suite**
   - Fetches or receives a specific upstream commit.
   - Runs the complete `./test.sh` in a pure upstream worktree.
   - Runs the same test command in the merge candidate after projecting only
     the declared PPH identity files back to their upstream versions.
   - Requires both failure fingerprints to be identical.
   - Permits only the exact entries in
     `scripts/upstream-compatibility-allowlist.json`.

2. **Personal PI Regression Suite**
   - Runs on the unprojected candidate.
   - Verifies the PPH package identity (`pph`, `.pph`, `PPH_*`), project
     settings, prompt/system-prompt discovery, and package/install metadata.

The existing full `./test.sh` run on PPH is useful diagnostic evidence, but it
is not a substitute for these suites. The current upstream-compatible
baseline has one known client entry-resolution failure. The PPH-specific
namespace failures are intentionally not allowlisted.

## Repository controls

`scripts/pph-personalization-manifest.json` is the ownership boundary.

- `ownedFiles` is the complete set of files the PPH fork may add or change.
- `identityProjectionFiles` is the smaller set temporarily replaced with the
  upstream version for the compatibility comparison.
- Any candidate diff outside `ownedFiles` stops the gate.

`scripts/upstream-compatibility-allowlist.json` is an exact fingerprint
allowlist. A failure is accepted only when all of these fields match:

```text
packageName
testFile
kind
testName
errorType
message
```

The expected count is checked as well. A changed message, a new failure, a
duplicate failure, or a stale allowlist entry fails the gate.

## Known upstream TypeScript failure gate

The normal repository check remains authoritative and is always run first. The
current upstream baseline has one inherited TypeScript diagnostic at
`packages/ai/src/api/google-shared.ts:402`; the PPH fork does not modify that
file. A normal commit may proceed only through the explicit, fail-closed gate
in `scripts/known-upstream-failure-gate.mjs`:

```bash
node scripts/known-upstream-failure-gate.mjs --allow-known-upstream-failure
```

The JSON entry in `scripts/known-upstream-failure-allowlist.json` binds the
package name, repository-relative source file and line, TypeScript error code,
exact semantic message, source needle, full upstream revision and SHA-256
source digest. The current fingerprint is:

```text
@earendil-works/pi-ai
packages/ai/src/api/google-shared.ts:402
TS2322
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
upstream revision: 71dca871bc80b6bc97be37f0ca3189399d651fff
source digest: sha256:fa9a45177b6c1e1636b8b1ef4c8b332e903e4b379039cb1bacbbc312a8e1662d
```

The gate accepts only one of two states: a normal check with no diagnostics,
or a non-zero check whose complete parsed and unparsed diagnostic set is
exactly the allowlist. For the known-failure state it additionally verifies
the pinned source and package identity, reproduces the same failure from a
pristine `git archive` checkout of the pinned upstream revision, and requires
all PPH proofs to pass: core build, core tests, Personal PI regression, and
protocol isolation. A changed line, source digest, package, error code,
semantic message, extra diagnostic, missing diagnostic, pristine mismatch or
PPH proof failure blocks.

The pre-commit hook still runs the normal check and invokes this gate only
after that exact check fails. The pristine checkout is an extracted archive,
so a commit's active index lock is never mutated. Every successful invocation
writes a local Decision/Evidence JSON artifact under
`.git/pph-known-upstream-failure-gate/`; it is local Git evidence, not a
tracked source file or a replacement for a green normal check.

## Normal procedure

Start from a clean local `main` checkout:

```bash
git status --short --branch
npm run gate:upstream-upgrade
```

The default procedure fetches `upstream/main`, advances `upstream-sync` with a
compare-and-swap update, creates a local `codex/upstream-candidate-*` merge
branch, and runs both compatibility checks plus the PPH regression suite. It
does not change `main` and never pushes.

The temporary worktrees install dependencies independently with
`npm ci --ignore-scripts`, so workspace symlinks always resolve to the exact
worktree under test. The gate copies the starting checkout's already-generated
model-data snapshot and required build artifacts into each worktree, ensuring
the pure and projected runs use identical ignored inputs. Materialize those
inputs with the repository's normal build/model-data setup before starting the
gate. The complete development test environment still requires the normal
prerequisites, including `rg` and `fd`.

After reviewing a successful candidate, promotion is an explicit second
invocation:

```bash
npm run gate:upstream-upgrade -- --promote
```

Promotion is allowed only when both suites pass, `main` is still at the commit
captured at gate start, and `git merge --ff-only` can advance it to the tested
candidate. A successful promotion prints `Stage Gate: CLOSED`; a successful
non-promoting run prints `Stage Gate: PASS`.

## Local simulation without network or push

The gate accepts an explicit local ref, so an upgrade rehearsal can use a
temporary commit on a local branch or temporary remote:

```bash
npm run gate:upstream-upgrade -- \
  --upstream-ref refs/heads/t02-simulated-upstream
```

The simulated commit must descend from the current `upstream-sync`. This
exercises target resolution, CAS synchronization, candidate merge creation,
both compatibility worktrees, the PPH regression suite, and main protection.
Use `--promote` only in a disposable rehearsal checkout; the real repository
should remain unchanged until the candidate has been reviewed.

## Failure handling

The first unexpected result stops the flow. In particular:

- a fetch, ancestry, CAS, merge, ownership, install, or test failure blocks;
- a pure-upstream failure must be an exact current allowlist fingerprint;
- a projected candidate failure must have the same full fingerprint set as the
  pure upstream result;
- any PPH identity regression blocks promotion;
- a changed `main` ref blocks promotion and is reported as a protection
  failure.
- the known-upstream TypeScript path is an explicit evidence-bound override,
  never a blanket `--no-verify` or a global hook disable.

Temporary worktrees are removed after each run. The candidate branch is kept
for inspection; it is local only and is never pushed by the gate.
