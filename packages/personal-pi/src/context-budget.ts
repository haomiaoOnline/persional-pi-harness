import type {
	ContextBudgetLayer,
	ContextBudgetLayerState,
	ContextBudgetMetrics,
	ContextBudgetState,
	ContextBudgetWatermark,
	LoopUsage,
} from "./types.ts";

export const CONTEXT_BUDGET_LAYERS = [
	"tool_output",
	"prompt",
	"run",
	"task",
] as const satisfies readonly ContextBudgetLayer[];
export const CONTEXT_BUDGET_WATERMARKS = [
	"LOW",
	"WARNING",
	"REBUILD",
	"HARD",
] as const satisfies readonly ContextBudgetWatermark[];

export const CONTEXT_BUDGET_WARNING_RATIO = 0.6;
export const CONTEXT_BUDGET_REBUILD_RATIO = 0.75;
export const CONTEXT_BUDGET_HARD_RATIO = 1;

export class ContextRebuildRequiredError extends Error {
	readonly layer: ContextBudgetLayer;

	constructor(layer: ContextBudgetLayer, reason = "context rebuild watermark reached") {
		super(reason);
		this.name = "ContextRebuildRequiredError";
		this.layer = layer;
	}
}

export function zeroContextBudgetMetrics(): ContextBudgetMetrics {
	return {
		tokens: 0,
		tool_calls: 0,
		raw_log_bytes: 0,
		injected_context_bytes: 0,
		duplicate_ratio: 0,
		state_growth_bytes: 0,
		elapsed_ms: 0,
		retries: 0,
	};
}

function isFiniteNonNegative(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

export function contextBudgetMetricsAreValid(metrics: ContextBudgetMetrics): boolean {
	return (
		isFiniteNonNegative(metrics.tokens) &&
		isFiniteNonNegative(metrics.tool_calls) &&
		isFiniteNonNegative(metrics.raw_log_bytes) &&
		isFiniteNonNegative(metrics.injected_context_bytes) &&
		Number.isFinite(metrics.duplicate_ratio) &&
		metrics.duplicate_ratio >= 0 &&
		metrics.duplicate_ratio <= 1 &&
		isFiniteNonNegative(metrics.state_growth_bytes) &&
		isFiniteNonNegative(metrics.elapsed_ms) &&
		isFiniteNonNegative(metrics.retries)
	);
}

export function evaluateContextBudgetWatermark(
	metrics: ContextBudgetMetrics,
	layerTokenLimit: number,
): ContextBudgetWatermark {
	if (!contextBudgetMetricsAreValid(metrics) || !Number.isFinite(layerTokenLimit) || layerTokenLimit <= 0)
		return "REBUILD";
	const ratio = metrics.tokens / layerTokenLimit;
	if (!Number.isFinite(ratio) || ratio < 0) return "REBUILD";
	if (ratio >= CONTEXT_BUDGET_HARD_RATIO) return "HARD";
	if (ratio >= CONTEXT_BUDGET_REBUILD_RATIO) return "REBUILD";
	if (ratio >= CONTEXT_BUDGET_WARNING_RATIO) return "WARNING";
	return "LOW";
}

export function createContextBudgetState(input: {
	task_id: string;
	run_id: string;
	context_limit: number;
	layer_token_limits: Record<ContextBudgetLayer, number>;
	updated_at?: string;
}): ContextBudgetState {
	if (!input.task_id.trim()) throw new Error("context budget task_id must not be empty");
	if (!input.run_id.trim()) throw new Error("context budget run_id must not be empty");
	if (!Number.isFinite(input.context_limit) || input.context_limit <= 0)
		throw new Error("context budget context_limit must be positive and finite");
	for (const layer of CONTEXT_BUDGET_LAYERS) {
		const limit = input.layer_token_limits[layer];
		if (!Number.isFinite(limit) || limit <= 0)
			throw new Error(`context budget ${layer} token_limit must be positive and finite`);
	}
	const metrics = zeroContextBudgetMetrics();
	return {
		task_id: input.task_id,
		run_id: input.run_id,
		context_limit: input.context_limit,
		layers: {
			tool_output: {
				token_limit: input.layer_token_limits.tool_output,
				metrics: structuredClone(metrics),
				watermark: "LOW",
			},
			prompt: { token_limit: input.layer_token_limits.prompt, metrics: structuredClone(metrics), watermark: "LOW" },
			run: { token_limit: input.layer_token_limits.run, metrics: structuredClone(metrics), watermark: "LOW" },
			task: { token_limit: input.layer_token_limits.task, metrics: structuredClone(metrics), watermark: "LOW" },
		},
		updated_at: input.updated_at ?? new Date().toISOString(),
	};
}

export function updateContextBudgetLayer(
	state: ContextBudgetState,
	layer: ContextBudgetLayer,
	metrics: ContextBudgetMetrics,
	updatedAt = new Date().toISOString(),
): ContextBudgetState {
	const next = structuredClone(state);
	next.layers[layer] = {
		token_limit: state.layers[layer].token_limit,
		metrics: structuredClone(metrics),
		watermark: evaluateContextBudgetWatermark(metrics, state.layers[layer].token_limit),
	};
	next.updated_at = updatedAt;
	return next;
}

export function taskContextMetricsFromLoopUsage(
	usage: LoopUsage,
	current: ContextBudgetMetrics = zeroContextBudgetMetrics(),
): ContextBudgetMetrics {
	return {
		tokens: usage.input_tokens + usage.output_tokens,
		tool_calls: usage.tool_calls,
		raw_log_bytes: current.raw_log_bytes,
		injected_context_bytes: current.injected_context_bytes,
		duplicate_ratio: current.duplicate_ratio,
		state_growth_bytes: usage.state_growth_bytes,
		elapsed_ms: usage.elapsed_ms,
		retries: Math.max(0, usage.attempts - 1),
	};
}

export function updateTaskContextBudgetFromLoopUsage(
	state: ContextBudgetState,
	usage: LoopUsage,
	updatedAt = new Date().toISOString(),
): ContextBudgetState {
	return updateContextBudgetLayer(
		state,
		"task",
		taskContextMetricsFromLoopUsage(usage, state.layers.task.metrics),
		updatedAt,
	);
}

export class ContextBudgetController {
	create(input: {
		task_id: string;
		run_id: string;
		context_limit: number;
		layer_token_limits: Record<ContextBudgetLayer, number>;
		updated_at?: string;
	}): ContextBudgetState {
		return createContextBudgetState(input);
	}

	updateLayer(
		state: ContextBudgetState,
		layer: ContextBudgetLayer,
		metrics: ContextBudgetMetrics,
		updatedAt?: string,
	): ContextBudgetState {
		return updateContextBudgetLayer(state, layer, metrics, updatedAt);
	}

	updateTaskFromLoopUsage(state: ContextBudgetState, usage: LoopUsage, updatedAt?: string): ContextBudgetState {
		return updateTaskContextBudgetFromLoopUsage(state, usage, updatedAt);
	}
}

export function validateContextBudgetState(state: ContextBudgetState): void {
	if (!state.task_id.trim()) throw new Error("context budget task_id must not be empty");
	if (!state.run_id.trim()) throw new Error("context budget run_id must not be empty");
	if (!Number.isFinite(state.context_limit) || state.context_limit <= 0)
		throw new Error("context budget context_limit must be positive and finite");
	if (!Number.isFinite(Date.parse(state.updated_at)))
		throw new Error("context budget updated_at must be a valid timestamp");
	const keys = Object.keys(state.layers).sort();
	const expected = [...CONTEXT_BUDGET_LAYERS].sort();
	if (JSON.stringify(keys) !== JSON.stringify(expected))
		throw new Error("context budget state must contain exactly four layers");
	for (const layer of CONTEXT_BUDGET_LAYERS) {
		const layerState: ContextBudgetLayerState = state.layers[layer];
		if (!Number.isFinite(layerState.token_limit) || layerState.token_limit <= 0)
			throw new Error(`context budget ${layer} token_limit must be positive and finite`);
		if (!CONTEXT_BUDGET_WATERMARKS.includes(layerState.watermark))
			throw new Error(`invalid context budget watermark for ${layer}: ${layerState.watermark}`);
		if (!contextBudgetMetricsAreValid(layerState.metrics))
			throw new Error(`invalid context budget metrics for ${layer}`);
		const expectedWatermark = evaluateContextBudgetWatermark(layerState.metrics, layerState.token_limit);
		if (layerState.watermark !== expectedWatermark) throw new Error(`context budget watermark is stale for ${layer}`);
	}
}
