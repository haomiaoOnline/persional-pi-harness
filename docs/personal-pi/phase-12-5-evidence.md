# T12.5 Evidence — Worker Success-Rate Feedback

## Implementation

`WorkerSuccessRateTracker` maintains deterministic counters keyed by `worker_id + task_type`, exposes a serializable snapshot, and restores from that snapshot without any model judgment. `WorkerRegistry` consumes the rate only after all hard capability, reasoning, context, cost, availability, and Role boundary checks have passed.

Unseen Workers use a neutral `0.5` tie-break value. Historical success rate cannot make an ineligible Worker eligible and cannot override the primary capability score.

## Verification

```text
npm test --workspace=@personal-pi/core
17 test files passed; 122 tests passed

npm run build --workspace=@personal-pi/core
passed
```

The feedback tests verify counter restoration and task-type separation. The Registry test records repeated failures for one equally capable Worker and repeated successes for another, then verifies the successful Worker is selected first as a secondary tie-breaker.

## Stage Gate decision

**PASS.** T12.5 is complete. The next allowed scope is T12.6 Provider Quota / Backpressure / Circuit Breaker.
