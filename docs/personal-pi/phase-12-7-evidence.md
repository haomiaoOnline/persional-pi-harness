# T12.7 Evidence — Role Workspace Persistence Cache

## Implementation

`WorkspaceCache` is a separate cache from `ContextStore`/`ContextResolver` and stores only rebuildable environment references. Every record is structurally fixed to `authoritative: false` and `rebuildable: true`, with a TTL and role/key namespace.

- persisted cache files are optional and disposable;
- expired entries are treated as misses;
- malformed cache files are ignored and counted as integrity misses;
- persistence errors do not prevent the authoritative rebuild path from returning a value;
- `clear()` and cache loss are explicitly supported;
- payload fields contain service names and reference IDs only, never credentials or tokens.

## Verification

```text
npm test --workspace=@personal-pi/core
19 test files passed; 128 tests passed

npm run build --workspace=@personal-pi/core
passed
```

Tests cover TTL and cross-instance persistence, cache clear followed by successful rebuild, and corrupted cache data followed by successful authoritative-path reconstruction.

## Stage Gate decision

**PASS.** T12.7 is complete. This closes the implementation scope requested by the v3.0 task list through Phase 12. T13 Parallel/Batch work is intentionally not started.
