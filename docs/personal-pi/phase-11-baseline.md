# Personal PI Single-Agent Baseline v1

## Status

Archived as the pre-Multi-Worker comparison baseline for Phase 11. This is a local Personal PI kernel baseline at the Task Contract boundary; it is not evidence of an external model, Provider, device, or production latency.

## Fixed task set

The baseline uses 15 fixed contract-level cases covering the current kernel boundaries:

| Case IDs | Boundary |
|---|---|
| `baseline-1` to `baseline-3` | Requirement, Plan Gate, and preclassification |
| `baseline-4` to `baseline-6` | Task Contract, Context Projection, and Lease fencing |
| `baseline-7` to `baseline-9` | Worker Result, Evidence, and Verification |
| `baseline-10` to `baseline-12` | Persistent State, Graph Mutation, and Recovery |
| `baseline-13` to `baseline-15` | Permission Boundary, Trace Replay, and Eval Isolation |

All cases use one Worker, the same bounded retry policy (`max_attempts=2`), fixed token budget, and no network or credential permission. `baseline-1` deliberately exercises one retry; the other cases complete on their first attempt.

## Archived report

| Metric | Value |
|---|---:|
| Worker count | 1 |
| Task count | 15 |
| Maximum attempts | 2 |
| Successful tasks | 15 |
| Success rate | 100% |
| Executor attempts | 16 |
| Total duration | 160 ms |
| Total tokens | 1,600 |
| Manual interventions | 0 |

The report is produced by `SingleAgentBaselineRunner`; its deterministic stability check compares a second run by task ID and success outcome. It is the mandatory comparison point for later Worker selection work. A later production/provider benchmark must add its own separately labeled evidence rather than overwrite this report.
