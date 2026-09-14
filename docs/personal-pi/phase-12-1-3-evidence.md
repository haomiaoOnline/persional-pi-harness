# Phase 12.1–12.3 Evidence — Worker Registry / Capability / Selection

## Scope

This stage implements the first Phase 12 routing surface. It loads the frozen T12.0-A static Manifest contract, keeps credentials secret-free, and uses Task Contract `worker_type`, `worker_tier`, `reasoning_depth`, `capability_tags`, context budget, availability, and Role Profile boundaries during deterministic selection. No auto-discovery, free-form agent communication, parallel execution, or T13 batch behavior is introduced.

## Implementation

- `WorkerRegistry.registerManifest()` parses the existing YAML Manifest contract.
- Selection rejects unavailable Workers, unsupported capability tags, insufficient context limits, unsupported reasoning depth, unsatisfied cost tier, and Role boundary violations.
- Candidate scoring is deterministic: capability matches first, Role preferred-tool matches second, then cost-tier and declared latency tie-breakers.
- Adapter credentials remain represented only by Manifest auth metadata such as an environment-variable name; no credential value is read, printed, or persisted.

## Verification

The Registry test registers the Codex and Claude Manifest examples with two independent `PiWorker` adapters, sends the same Task Contract through both selected adapters, and validates each returned value with the Result Contract validator. It also covers availability, capability mismatch, and Role boundary rejection.

```text
npm test --workspace=@personal-pi/core
15 test files passed; 116 tests passed

npm run build --workspace=@personal-pi/core
passed

npm run check:protocol-isolation --workspace=@personal-pi/core
protocol metadata isolation: PASS

npm run check
all checks before the repository TypeScript pass completed;
the pass stopped at the known inherited upstream error:
packages/ai/src/api/google-shared.ts(402,10) TS2322
```

## Stage Gate decision

**PASS.** At least two Worker types are stably registered and selected through the same Task/Result contracts. The next allowed scope is T12.4 Worker Pool Lifecycle Manager; T13 remains out of scope.
