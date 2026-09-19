import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createPersonalPiInteractiveIngressFactory, PersistentStateStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(path);
	return path;
}

function initializeGitRepository(directory: string): void {
	execFileSync("git", ["init", "-q"], { cwd: directory });
	writeFileSync(join(directory, "README.md"), "v3.5 benchmark\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: directory });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=PPH Benchmark",
			"-c",
			"user.email=pph-benchmark@example.invalid",
			"commit",
			"-q",
			"-m",
			"fixture",
		],
		{ cwd: directory },
	);
}

function writeBenchmarkPiCli(directory: string): string {
	const path = join(directory, "benchmark-pi-worker.mjs");
	writeFileSync(
		path,
		`const prompt = process.argv.at(-1) ?? "";
const marker = "CONTRACT_PAYLOAD_JSON:\\n";
const markerIndex = prompt.lastIndexOf(marker);
const payload = markerIndex >= 0 ? JSON.parse(prompt.slice(markerIndex + marker.length)) : {};
const objective = String(payload.objective ?? "");
const fanIn = objective.startsWith("Synthesize the verified receipt/evidence references");
const single = objective.includes("SINGLE_BENCHMARK");
const delay = single ? 240 : fanIn ? 20 : 70;
const inputTokens = single ? 500 : fanIn ? 100 : 80;
await new Promise((resolve) => setTimeout(resolve, delay));
const leakedCredential = process.env.BENCHMARK_API_TOKEN ?? "";
const result = JSON.stringify({
  status: "success",
  summary: "benchmark objective=" + objective + "; credential_seen=" + leakedCredential,
  changed_files: [],
  artifacts: [],
  evidence: ["source_ref:" + objective],
  errors: [],
  work_receipt: {
    work_attempted: true,
    effects_count: 0,
    artifacts_created: [],
    state_changed: false,
    no_op: true,
    no_op_reason: "read-only benchmark",
    evidence_refs: ["source_ref:" + objective]
  }
});
process.stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant" } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    provider: "benchmark-provider",
    model: "benchmark-model",
    stopReason: "stop",
    usage: { input: inputTokens, output: 20, totalTokens: inputTokens + 20, cost: { total: 0 } },
    content: [{ type: "text", text: result }]
  }
}) + "\\n");
`,
		"utf8",
	);
	return path;
}

type BenchmarkMetrics = {
	mode: "single" | "multi";
	verified_success_rate: number;
	wall_time_ms: number;
	model_calls: number;
	tool_calls: number;
	input_tokens: number;
	explicit_model_generated_sleep: number;
	peak_active_workers: number;
	overlap_proof_count: number;
	provenance_coverage: number;
	credential_exposure: number;
	scheduler_kind: string;
};

function numericEvidence(state: ReturnType<PersistentStateStore["read"]>, key: string): number {
	const prefix = `pi-agent:${key}=`;
	return state.results
		.flatMap((result) => result.evidence)
		.filter((item) => item.startsWith(prefix))
		.reduce((sum, item) => sum + (Number.parseInt(item.slice(prefix.length), 10) || 0), 0);
}

async function runMode(mode: BenchmarkMetrics["mode"]): Promise<BenchmarkMetrics> {
	const cwd = temporaryDirectory(`pph-v3.5-${mode}-repo-`);
	initializeGitRepository(cwd);
	const runtime = temporaryDirectory(`pph-v3.5-${mode}-runtime-`);
	const workerCli = writeBenchmarkPiCli(runtime);
	const statePath = join(runtime, "state.json");
	const surfaces: Array<Record<string, unknown>> = [];
	const previousSecret = process.env.BENCHMARK_API_TOKEN;
	process.env.BENCHMARK_API_TOKEN = "BENCHMARK_SECRET_VALUE_MUST_NOT_LEAK";
	try {
		const handler = createPersonalPiInteractiveIngressFactory({
			state_path: statePath,
			task_id_factory: () => `benchmark-${mode}`,
			provider_mode: "mock",
			max_parallel_workers: 4,
			execution_surface: { pph_commit: "benchmark-commit", bundle_sha256: "benchmark-bundle" },
		})({
			recordExecutionSurface: (metadata) => surfaces.push({ ...metadata }),
			getWorkerRoute: () => ({
				cwd,
				command: process.execPath,
				command_args_prefix: [workerCli],
				provider: "benchmark-provider",
				model: "benchmark-model",
				thinking: "low",
				active_tools: [],
				worker_status: { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" },
			}),
		});
		const objective =
			mode === "single"
				? "SINGLE_BENCHMARK research OpenAI, Anthropic, Google and DeepSeek under one bounded worker with identical read-only permissions"
				: "MULTI_BENCHMARK 分别调研以下厂商并汇总同一组指标：\n1. OpenAI\n2. Anthropic\n3. Google\n4. DeepSeek";
		const started = performance.now();
		await handler({ text: objective });
		const wallTimeMs = Math.max(1, performance.now() - started);
		const state = new PersistentStateStore(statePath).read();
		const leafTasks = state.tasks.filter((task) => task.id.includes(":unit-"));
		const benchmarkTasks = mode === "multi" ? leafTasks : state.tasks;
		const verified = benchmarkTasks.filter((task) => task.state === "DONE").length;
		const leafReceipts = state.handoff_receipts.filter((receipt) =>
			mode === "multi" ? receipt.task_id.includes(":unit-") : receipt.task_id === `benchmark-${mode}`,
		);
		const serialized = JSON.stringify(state);
		return {
			mode,
			verified_success_rate: verified / Math.max(1, benchmarkTasks.length),
			wall_time_ms: Math.round(wallTimeMs),
			model_calls: state.runs.length,
			tool_calls: numericEvidence(state, "tool_calls"),
			input_tokens: numericEvidence(state, "input_tokens"),
			explicit_model_generated_sleep: state.results.some((result) => /\bsleep\b/i.test(result.evidence.join("\n")))
				? 1
				: 0,
			peak_active_workers: Math.max(1, ...state.dispatches.map((dispatch) => dispatch.effective_worker_count)),
			overlap_proof_count: new Set(state.dispatches.map((dispatch) => dispatch.overlap_proof_ref).filter(Boolean))
				.size,
			provenance_coverage:
				leafReceipts.filter((receipt) => receipt.evidence_refs.length > 0).length /
				Math.max(1, leafReceipts.length),
			credential_exposure: serialized.includes("BENCHMARK_SECRET_VALUE_MUST_NOT_LEAK") ? 1 : 0,
			scheduler_kind: String(surfaces.at(-1)?.scheduler_kind ?? "unknown"),
		};
	} finally {
		if (previousSecret === undefined) delete process.env.BENCHMARK_API_TOKEN;
		else process.env.BENCHMARK_API_TOKEN = previousSecret;
	}
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T11.5-A real-ingress Single-vs-Multi research benchmark", () => {
	test("records comparable real-ingress metrics and preserves the result instead of assuming Multi is better", async () => {
		const single = await runMode("single");
		const multi = await runMode("multi");
		const report = {
			fixture: "four independent model-vendor research units",
			single,
			multi,
			delta: {
				wall_time_ms: multi.wall_time_ms - single.wall_time_ms,
				model_calls: multi.model_calls - single.model_calls,
				input_tokens: multi.input_tokens - single.input_tokens,
			},
		};
		console.log(`PPH_V3_5_RESEARCH_BENCHMARK=${JSON.stringify(report)}`);

		expect(single.verified_success_rate).toBe(1);
		expect(multi.verified_success_rate).toBe(1);
		expect(single.scheduler_kind).toBe("direct");
		expect(multi.scheduler_kind).toBe("worker_pool");
		expect(single.peak_active_workers).toBe(1);
		expect(multi.peak_active_workers).toBeGreaterThanOrEqual(2);
		expect(multi.overlap_proof_count).toBeGreaterThanOrEqual(1);
		expect(multi.explicit_model_generated_sleep).toBe(0);
		expect(multi.provenance_coverage).toBe(1);
		expect(single.credential_exposure).toBe(0);
		expect(multi.credential_exposure).toBe(0);
		expect(Number.isFinite(single.wall_time_ms)).toBe(true);
		expect(Number.isFinite(multi.wall_time_ms)).toBe(true);
		expect(multi.input_tokens).toBeLessThan(single.input_tokens);
	}, 15_000);
});
