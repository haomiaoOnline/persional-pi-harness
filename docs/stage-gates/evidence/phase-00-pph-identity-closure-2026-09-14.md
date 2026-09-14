# Phase 0 PPH Differential Closure Evidence

日期：2026-09-14（Asia/Taipei）
验证提交：`bfde9ffbe` (`test(pph): align coding-agent fixtures with runtime identity`)
分支：`feature/t1-task-contract`
T13：未进入

## Result

The saved pristine-upstream versus PPH differential contained 76 PPH-only
coding-agent failures. Each failure was classified before editing. The
failure set was caused by tests retaining upstream `pi`/`.pi` expectations
while the intentional runtime projection is `pph`/`.pph` and `PPH_*`.
There were no unexplained PPH-only failures after the targeted fixture fixes.

| Root-cause class | Initial failures | Final result | Evidence boundary |
| --- | ---: | ---: | --- |
| Expected identity fixture drift | 76 | 0 | Targeted fixture tests plus the complete coding-agent suite |
| Actual PPH regression | 0 | 0 | No PPH-only failure remained after projection-corrected assertions |
| Residual environment-specific failure | 0 | 0 | Full suite rerun in an isolated HOME/TMP/npm environment |

The remote-session and fswatch groups are listed separately below because
they exercise runtime/session and watcher surfaces; their root cause was still
the fixture's upstream identity/environment variable, not a production
regression. A transient remote-event ordering flake occurred during an
intermediate rerun and passed on the bounded rerun; it is not counted in the
original 76.

## Exact initial classification

| Test file | Initial failures | Classification |
| --- | ---: | --- |
| `test/credential-print.test.ts` | 1 | user-visible `pi` → `pph` projection |
| `test/experimental-remote-runtime.test.ts` | 16 | `PI_CODING_AGENT_DIR` fixture → `PPH_CODING_AGENT_DIR` runtime projection |
| `test/experimental-session-directory.test.ts` | 1 | session directory environment projection |
| `test/first-time-setup.test.ts` | 1 | PPH distribution identity expectation |
| `test/package-command-paths.test.ts` | 16 | CLI name, project config directory, and managed path projection |
| `test/package-manager.test.ts` | 13 | `.pi` project settings path projection |
| `test/resource-loader.test.ts` | 8 | `.pi` resource discovery path projection |
| `test/session-file-invalid.test.ts` | 1 | user-visible package name projection |
| `test/session-manager/file-operations.test.ts` | 2 | user-visible package name projection |
| `test/settings-manager-bug.test.ts` | 2 | `.pi` project settings path projection |
| `test/settings-manager.test.ts` | 6 | `.pi` project settings path projection |
| `test/stdout-cleanliness.test.ts` | 1 | PPH CLI output projection |
| `test/suite/regressions/2781-skill-collision-precedence.test.ts` | 2 | `.pi` project path projection |
| `test/suite/regressions/2791-fswatch-error-crash.test.ts` | 1 | PPH environment variable projection in watcher fixture |
| `test/suite/regressions/8337-utf8-bom-parsing.test.ts` | 1 | `.pi` project path projection |
| `test/theme-export.test.ts` | 2 | `PPH_CODING_AGENT_DIR` fixture projection |
| `test/theme-picker.test.ts` | 1 | `PPH_CODING_AGENT_DIR` fixture projection |
| `test/trust-manager.test.ts` | 1 | `.pi` project path projection |
| **Total** | **76** | **All targeted; no unexplained remainder** |

## Targeted and full validation

The changed fixture files were first run as a 16-file targeted set: **16
files / 297 tests PASS**. The formal tests commit then ran the complete
coding-agent suite:

```text
Test Files 266 passed | 7 skipped (273)
Tests      2239 passed | 54 skipped (2293)
```

The script suite passed **29/29**, including the exact known-failure gate
tests. No global string replacement, broad skip, test deletion or `|| true`
was used. Internal `PI_*` protocol/server names were left unchanged.

## Static gate boundary

`npm run check` still reports the single inherited upstream
`google-shared.ts(402,10)` TS2322. The new Known-Upstream-Failure gate proves
that this is the exact pinned upstream failure and requires PPH build,
targeted core tests, regression and protocol-isolation proof. The successful
Decision/Evidence artifact for the gate is generated at:

```text
.git/pph-known-upstream-failure-gate/decision-20260914154353922.json
```

Phase 0 PPH differential closure is therefore **PASS under the explicit
known-upstream gate**. The normal check is not relabeled as green.
