# T12.6 Evidence — Provider Quota / Backpressure / Circuit Breaker

## Implementation

`ProviderResilienceController` keeps provider admission separate from credentials and Worker execution. It provides:

- sliding-window request-rate admission;
- cumulative quota accounting and remaining-quota snapshots;
- consecutive `429`/`500` failure counting;
- `CLOSED → OPEN → HALF_OPEN` circuit transitions with a deterministic cooldown probe;
- explicit `QUEUE` backpressure and `FALLBACK` to a healthy backup provider;
- a small pending-request queue and deterministic drain operation.

The module contains no credential values and performs no external network call. A caller must report the actual response through `recordResponse()` after an admitted request.

## Verification

```text
npm test --workspace=@personal-pi/core
18 test files passed; 125 tests passed

npm run build --workspace=@personal-pi/core
passed
```

The tests cover rate limiting, quota exhaustion, consecutive 429/500 failures, fallback admission, queue retention during cooldown, and successful half-open recovery.

## Stage Gate decision

**PASS.** T12.6 is complete. The next and final allowed Phase 12 scope is T12.7 Role Workspace Persistence Cache. T13 remains explicitly out of scope.
