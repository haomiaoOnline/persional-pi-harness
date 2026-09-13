# Personal PI T12.0-A Evidence

## Task result

| Task | Result | Evidence |
|---|---|---|
| T12.0-A | PASS | `WorkerPluginManifestSchema` and `validateWorkerPluginManifest` freeze `id/adapter_entry/models_supported/capability_tags/context_limit/cost_tier/auth/discovery`; `discovery.type` is limited to `static_config`, and both Codex CLI and Claude CLI YAML examples pass parsing and validation. |

The manifest only declares an authentication type and environment-variable name. It does not load, print, synchronize, or persist credentials. `capability_tags`, `cost_tier`, and `reasoning_levels` use the same vocabulary as the Task Contract so future Worker Selection can map them directly.

## Commands

```text
npm install --package-lock-only --ignore-scripts          PASS
npm test --workspace=@personal-pi/core                   PASS (13 files, 104/104)
npm run build --workspace=@personal-pi/core              PASS
npm run check:protocol-isolation --workspace=@personal-pi/core PASS
npm run check                                             PARTIAL PASS
```

The repository-level check passed formatting, dependency declarations, import rules, entry-point graph, shrinkwrap, and install-lock checks. It stopped only at the known upstream TypeScript baseline:

```text
packages/ai/src/api/google-shared.ts(402,10): error TS2322:
Type 'FinishReason.TOO_MANY_TOOL_CALLS' is not assignable to type 'never'.
```

No `packages/ai` file changed. The npm `min-release-age` warning and audit summary are pre-existing; no forced dependency update was performed.

## Boundary

**T12.0-A: PASS**

The manifest contract is frozen and its two examples are verified. Registry loading, auto-discovery, Worker Selection, Worker Pool, and parallel execution remain deferred to T12.1+ as required by the task list.
