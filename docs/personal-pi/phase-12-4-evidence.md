# T12.4 Evidence — Worker Pool Lifecycle Manager

## Implementation

`WorkerPool` is an independent lifecycle module over the existing `LeaseManager` and `WorkerAdapter` contracts.

- `local_process_worker`: can be warmed into `IDLE`, reuses the process without reusing session context, and is destroyed after `idle_timeout_ms` only when the queue is empty.
- `cli_ephemeral_worker`: starts on demand and is destroyed after release.
- `remote_agent_worker`: starts on demand and returns to `COLD` after release to model scale-to-zero.
- Dispatch transitions through `COLD → WARMING → IDLE → LEASED → BUSY`; release clears session context before returning to reusable or scale-to-zero state.
- Task and Worker Lease maps prevent duplicate assignment. A busy candidate is skipped so the next idle Worker can be selected.

## Verification

```text
npm test --workspace=@personal-pi/core
16 test files passed; 120 tests passed

npm run build --workspace=@personal-pi/core
passed
```

The tests cover two ready tasks receiving different local Workers, context clearing on release, queue-aware idle timeout, ephemeral/remote lifecycle differences, and stale/duplicate Lease rejection.

## Stage Gate decision

**PASS.** T12.4 is complete. The next allowed scope is T12.5 historical success-rate feedback.
