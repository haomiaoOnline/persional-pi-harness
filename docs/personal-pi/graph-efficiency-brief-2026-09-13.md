# Graph Efficiency Periodic Brief

**Period:** 2026-09-13 v3.0 baseline fixture  
**Sample count:** 1  
**Verified tasks:** 1

This is the first deterministic periodic brief produced by `buildGraphEfficiencyBrief()`. It verifies the shape and formula used by the future calibration baseline; the single sample is not a production traffic claim.

| Metric | Value |
| --- | ---: |
| graph_width | 2 |
| graph_depth | 3 |
| handoff_count | 1 |
| retry_depth | 1 |
| agent_calls | 1 |
| verification_first_pass_rate | 1 |
| useful_work_ratio | 1 |
| coordination_efficiency | 0.333333 |

Formula: `verified_tasks / (handoffs + retries + agent_calls) = 1 / (1 + 1 + 1) = 0.333333`.

Source: `packages/personal-pi/test/trace.test.ts`, Graph Efficiency brief test.
