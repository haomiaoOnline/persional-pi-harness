import { randomUUID } from "node:crypto";
import { ContextResolver, ContextStore } from "./context.ts";
import type {
	ContextManifest,
	ContextReference,
	DecisionRecord,
	ExecutionTrace,
	RegressionCase,
	ResolvedContext,
	TaskContract,
	TraceEvent,
	TraceMetrics,
	TraceOutcome,
	WorkerTier,
} from "./types.ts";

export const TRACE_STAGES = [
	"REQUIREMENT",
	"PLAN_GATE",
	"PRECLASSIFY",
	"ASSESSMENT",
	"DISPATCH",
	"TASK",
	"DOR",
	"WORKER",
	"RUN",
	"RESULT",
	"EVIDENCE",
	"VERIFICATION",
	"ACCEPTANCE",
] as const;

export type TraceStage = (typeof TRACE_STAGES)[number];

function emptyMetrics(): TraceMetrics {
	return {
		token_per_task: 0,
		cache_hit_rate: 0,
		worker_tier_distribution: { cheap: 0, standard: 0, frontier: 0 },
	};
}

export class TraceRecorder {
	private readonly trace: ExecutionTrace;

	constructor(taskId: string, traceId: string = randomUUID(), startedAt = new Date().toISOString()) {
		this.trace = {
			trace_id: traceId,
			task_id: taskId,
			started_at: startedAt,
			events: [],
			decisions: [],
			metrics: emptyMetrics(),
			replayable: true,
		};
	}

	record(stage: TraceStage, detail: string, at = new Date().toISOString(), fields?: TraceEvent["fields"]): void {
		this.trace.events.push({ stage, detail, at, fields: fields ? { ...fields } : undefined });
	}

	attachRun(runId: string): void {
		this.trace.run_id = runId;
	}

	addDecision(decision: DecisionRecord): void {
		this.trace.decisions.push(structuredClone(decision));
	}

	setMetrics(metrics: { token_per_task: number; cache_hit_rate: number; worker_tier: WorkerTier }): void {
		this.trace.metrics = {
			token_per_task: metrics.token_per_task,
			cache_hit_rate: metrics.cache_hit_rate,
			worker_tier_distribution: {
				cheap: metrics.worker_tier === "cheap" ? 1 : 0,
				standard: metrics.worker_tier === "standard" ? 1 : 0,
				frontier: metrics.worker_tier === "frontier" ? 1 : 0,
			},
		};
	}

	finish(outcome: TraceOutcome, endedAt = new Date().toISOString()): void {
		this.trace.outcome = outcome;
		this.trace.ended_at = endedAt;
	}

	snapshot(): ExecutionTrace {
		return structuredClone(this.trace);
	}
}

export interface TraceReplay {
	complete: boolean;
	order_valid: boolean;
	ordered_stages: string[];
	missing_stages: string[];
	decision_reasons: string[];
	outcome?: TraceOutcome;
}

export function replayExecutionTrace(trace: ExecutionTrace): TraceReplay {
	const orderedStages = trace.events.map((event) => event.stage);
	const missingStages = TRACE_STAGES.filter((stage) => !orderedStages.includes(stage));
	const expectedIndexes = TRACE_STAGES.map((stage) => orderedStages.indexOf(stage));
	const knownStagesOnly = orderedStages.every((stage) => TRACE_STAGES.includes(stage as TraceStage));
	const orderValid =
		knownStagesOnly &&
		missingStages.length === 0 &&
		expectedIndexes.every((index, position) => position === 0 || index > expectedIndexes[position - 1]);
	return {
		complete: trace.replayable && orderValid && trace.outcome !== undefined,
		order_valid: orderValid,
		ordered_stages: orderedStages,
		missing_stages: [...missingStages],
		decision_reasons: trace.decisions.map((decision) => `${decision.decision_type}: ${decision.reason}`),
		outcome: trace.outcome,
	};
}

export interface RegressionInput {
	category: string;
	task_id?: string;
	expected: string;
	actual: string;
	evidence_ref?: string;
	created_at?: string;
}

export function createRegressionCase(input: RegressionInput): RegressionCase {
	return {
		id: randomUUID(),
		category: input.category,
		task_id: input.task_id,
		expected: input.expected,
		actual: input.actual,
		evidence_ref: input.evidence_ref,
		created_at: input.created_at ?? new Date().toISOString(),
		resolved: false,
	};
}

export class RegressionDataset {
	private readonly cases = new Map<string, RegressionCase>();

	constructor(initial: readonly RegressionCase[] = []) {
		for (const regression of initial) this.cases.set(regression.id, structuredClone(regression));
	}

	add(input: RegressionInput): RegressionCase {
		const regression = createRegressionCase(input);
		this.cases.set(regression.id, regression);
		return structuredClone(regression);
	}

	resolve(caseId: string): RegressionCase {
		const regression = this.cases.get(caseId);
		if (!regression) throw new Error(`unknown regression case: ${caseId}`);
		regression.resolved = true;
		return structuredClone(regression);
	}

	list(): RegressionCase[] {
		return [...this.cases.values()].map((regression) => structuredClone(regression));
	}
}

export interface BaselineExecution {
	success: boolean;
	duration_ms: number;
	tokens: number;
	manual_interventions: number;
}

export type BaselineExecutor = (task: TaskContract, attempt: number) => Promise<BaselineExecution> | BaselineExecution;

export interface BaselineCaseReport {
	task_id: string;
	success: boolean;
	attempts: number;
	duration_ms: number;
	tokens: number;
	manual_interventions: number;
}

export interface BaselineReport {
	baseline_id: string;
	worker_count: 1;
	max_attempts: number;
	task_count: number;
	success_rate: number;
	total_duration_ms: number;
	total_tokens: number;
	manual_interventions: number;
	cases: BaselineCaseReport[];
	created_at: string;
}

export class SingleAgentBaselineRunner {
	private readonly executor: BaselineExecutor;
	private readonly maxAttempts: number;

	constructor(executor: BaselineExecutor, maxAttempts = 2) {
		this.executor = executor;
		this.maxAttempts = Math.max(1, maxAttempts);
	}

	async run(tasks: readonly TaskContract[], baselineId: string = randomUUID()): Promise<BaselineReport> {
		const cases: BaselineCaseReport[] = [];
		for (const task of tasks) {
			let last: BaselineExecution = { success: false, duration_ms: 0, tokens: 0, manual_interventions: 0 };
			let attempts = 0;
			let duration = 0;
			let tokens = 0;
			let manualInterventions = 0;
			while (attempts < this.maxAttempts) {
				attempts += 1;
				last = await this.executor(task, attempts);
				duration += last.duration_ms;
				tokens += last.tokens;
				manualInterventions += last.manual_interventions;
				if (last.success) break;
			}
			cases.push({
				task_id: task.id,
				success: last.success,
				attempts,
				duration_ms: duration,
				tokens,
				manual_interventions: manualInterventions,
			});
		}
		return {
			baseline_id: baselineId,
			worker_count: 1,
			max_attempts: this.maxAttempts,
			task_count: cases.length,
			success_rate: cases.length === 0 ? 1 : cases.filter((item) => item.success).length / cases.length,
			total_duration_ms: cases.reduce((sum, item) => sum + item.duration_ms, 0),
			total_tokens: cases.reduce((sum, item) => sum + item.tokens, 0),
			manual_interventions: cases.reduce((sum, item) => sum + item.manual_interventions, 0),
			cases,
			created_at: new Date().toISOString(),
		};
	}
}

export function baselineReportsStable(left: BaselineReport, right: BaselineReport): boolean {
	if (
		left.task_count !== right.task_count ||
		left.success_rate !== right.success_rate ||
		left.total_duration_ms !== right.total_duration_ms ||
		left.total_tokens !== right.total_tokens ||
		left.manual_interventions !== right.manual_interventions
	)
		return false;
	return left.cases.every((item, index) => {
		const other = right.cases[index];
		return (
			other?.task_id === item.task_id &&
			other.success === item.success &&
			other.attempts === item.attempts &&
			other.duration_ms === item.duration_ms &&
			other.tokens === item.tokens &&
			other.manual_interventions === item.manual_interventions
		);
	});
}

export interface TraceMetricsSummary {
	task_count: number;
	total_tokens: number;
	average_token_per_task: number;
	cache_hit_rate: number;
	worker_tier_distribution: Record<WorkerTier, number>;
}

export function summarizeTraceMetrics(traces: readonly ExecutionTrace[]): TraceMetricsSummary {
	const tierDistribution: Record<WorkerTier, number> = { cheap: 0, standard: 0, frontier: 0 };
	for (const trace of traces) {
		for (const tier of ["cheap", "standard", "frontier"] as const)
			tierDistribution[tier] += trace.metrics.worker_tier_distribution[tier] ?? 0;
	}
	const totalTokens = traces.reduce((sum, trace) => sum + trace.metrics.token_per_task, 0);
	return {
		task_count: traces.length,
		total_tokens: totalTokens,
		average_token_per_task: traces.length === 0 ? 0 : totalTokens / traces.length,
		cache_hit_rate:
			traces.length === 0 ? 0 : traces.reduce((sum, trace) => sum + trace.metrics.cache_hit_rate, 0) / traces.length,
		worker_tier_distribution: tierDistribution,
	};
}

export class EvalContextStore {
	private readonly store: ContextStore;

	constructor(rootPath?: string) {
		this.store = new ContextStore(rootPath);
	}

	put(content: string, options: { held_out?: boolean } = {}): ContextReference {
		return this.store.put(content, { held_out: options.held_out });
	}

	resolve(manifest: ContextManifest): ResolvedContext {
		return new ContextResolver(this.store).resolve(manifest, { evaluation: true });
	}

	stats(): { objects: number; integrity_misses: number } {
		return this.store.stats();
	}
}

export function assertEvalIsolation(context: ResolvedContext, heldOutDigests: readonly string[]): void {
	const heldOut = new Set(heldOutDigests);
	const leaked = context.items.find((item) => heldOut.has(item.digest));
	if (leaked) throw new Error(`evaluation context leaked held-out reference: ${leaked.digest}`);
}
