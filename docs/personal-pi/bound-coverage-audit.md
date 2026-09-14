# Personal PI Bound Coverage Audit

## Audit scope

This document implements the v3.0 `T1.6 Bound Coverage Audit` discipline. It is a Stage Gate review artifact, not a new runtime scheduler. The audit covers every active path in the current repository that can re-enter an earlier execution state. A future path remains explicitly marked inactive until the phase that introduces it.

## Current path inventory

| Re-entry path | Active state | Deterministic coverage | Evidence / boundary |
| --- | --- | --- | --- |
| Worker → Verification/Recovery → retry or reassign → Worker | Active | `loop_budget.max_attempts`; local `retry_policy.max_attempts`; lease epoch fencing | `LoopBudgetController.beforeRun()` is called by the first Run and `RecoveryManager.startRetry()` before a recovered Run |
| Worker → `INSUFFICIENT_CONTEXT` → blocked task → later dispatch | Partially active | `loop_budget.max_attempts` and `max_input_tokens` are available to the Controller; the current Pipeline blocks rather than silently re-dispatching | No automatic context loop is enabled in the current phase |
| Recovery of a crashed/timed-out Run → new Run | Active | Persisted `loop_usage.attempts`; `loop_budget.max_attempts`; lease epoch fencing | Restart and crash-recovery coverage is in `packages/personal-pi/test/loop-budget.test.ts` |
| Decomposer → replan → Decomposer | Active in graph planning | `decomposition_budget.max_replan_count` | The existing Graph Intelligence budget remains the bound for replan recursion |
| Worker A → Worker B → Verifier → Replan → Worker A | Inactive until the Multi-Worker handoff phase | `loop_budget.max_handoffs` and `LoopBudgetController.beforeHandoff()` are defined; the handoff execution path is not enabled | Must be re-audited before the first Phase 12 handoff implementation and cannot be treated as covered by a model decision |

## Gate procedure

At every Phase Gate, the reviewer must:

1. enumerate newly introduced edges that can return to `READY`, `RUNNING`, `VERIFYING`, or an equivalent earlier state;
2. map each edge to a machine-checkable budget field and the exact enforcement call site;
3. verify persistence across Controller restart where the budget is Task-scoped;
4. reject the Gate if any active path has no deterministic bound, even if a model reports completion;
5. add and verify a new row before enabling a future path.

## Result

**PASS for the active Phase 1–11 paths.** Worker/Verifier/Recovery retry paths are covered by persisted `loop_usage` and `loop_budget`; graph replanning remains covered by the existing decomposition budget. The future Multi-Worker handoff row is intentionally inactive and is a hard prerequisite for the Phase 12 Gate. Swarm, Event Bus, and free-form agent cycles are not part of this design.
