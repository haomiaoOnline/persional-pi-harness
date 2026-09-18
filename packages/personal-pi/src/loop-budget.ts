import type { PersistentStateStore } from "./persistence.ts";
import type { LoopBudget, LoopUsage, TaskContract } from "./types.ts";

export const LOOP_USAGE_KEYS = [
	"attempts",
	"model_calls",
	"tool_calls",
	"handoffs",
	"elapsed_ms",
	"input_tokens",
	"output_tokens",
	"cost_usd",
	"state_growth_bytes",
] as const satisfies readonly (keyof LoopUsage)[];

export function emptyLoopUsage(): LoopUsage {
	return {
		attempts: 0,
		model_calls: 0,
		tool_calls: 0,
		handoffs: 0,
		elapsed_ms: 0,
		input_tokens: 0,
		output_tokens: 0,
		cost_usd: 0,
		state_growth_bytes: 0,
	};
}

export interface LoopBudgetDecision {
	allowed: boolean;
	projected: LoopUsage;
	exhausted: string[];
	reasons: string[];
}

type LoopBudgetLimit = Exclude<keyof LoopBudget, "on_exhaustion">;

function project(usage: LoopUsage, delta: Partial<LoopUsage>): LoopUsage {
	const next = { ...usage };
	for (const key of LOOP_USAGE_KEYS) next[key] += delta[key] ?? 0;
	return next;
}

export function evaluateLoopBudget(
	task: Pick<TaskContract, "loop_budget">,
	usage: LoopUsage,
	delta: Partial<LoopUsage> = {},
): LoopBudgetDecision {
	const projected = project(usage, delta);
	const budget = task.loop_budget;
	if (!budget) return { allowed: true, projected, exhausted: [], reasons: [] };
	const limits: Array<[keyof LoopUsage, LoopBudgetLimit]> = [
		["attempts", "max_attempts"],
		["model_calls", "max_model_calls"],
		["tool_calls", "max_tool_calls"],
		["handoffs", "max_handoffs"],
		["elapsed_ms", "max_elapsed_ms"],
		["input_tokens", "max_input_tokens"],
		["output_tokens", "max_output_tokens"],
		["cost_usd", "max_cost_usd"],
		["state_growth_bytes", "max_state_growth_bytes"],
	];
	const exhausted = limits.filter(([used, limit]) => projected[used] > budget[limit]).map(([, limit]) => limit);
	return {
		allowed: exhausted.length === 0,
		projected,
		exhausted,
		reasons: exhausted.map((limit) => `loop budget exhausted: ${limit}`),
	};
}

export class LoopBudgetExhaustedError extends Error {
	readonly exhausted: string[];

	constructor(decision: LoopBudgetDecision) {
		super(decision.reasons.join("; ") || "loop budget exhausted");
		this.name = "LoopBudgetExhaustedError";
		this.exhausted = [...decision.exhausted];
	}
}

export class LoopBudgetMissingError extends Error {
	constructor(taskId: string) {
		super(`loop budget required for executable task: ${taskId}`);
		this.name = "LoopBudgetMissingError";
	}
}

export class LoopBudgetController {
	private readonly store: PersistentStateStore;

	constructor(store: PersistentStateStore) {
		this.store = store;
	}

	probeAvailability(task: Pick<TaskContract, "id" | "loop_budget">): void {
		if (!task.loop_budget) throw new LoopBudgetMissingError(task.id);
		evaluateLoopBudget(task, emptyLoopUsage());
	}

	beforeRun(task: Pick<TaskContract, "id" | "loop_budget">): LoopUsage {
		return this.record(task, { attempts: 1 });
	}

	beforeModelCall(task: Pick<TaskContract, "id" | "loop_budget">): LoopUsage {
		return this.record(task, { model_calls: 1 });
	}

	beforeToolCall(task: Pick<TaskContract, "id" | "loop_budget">): LoopUsage {
		return this.record(task, { tool_calls: 1 });
	}

	beforeHandoff(task: Pick<TaskContract, "id" | "loop_budget">): LoopUsage {
		return this.record(task, { handoffs: 1 });
	}

	record(task: Pick<TaskContract, "id" | "loop_budget">, delta: Partial<LoopUsage>): LoopUsage {
		if (!task.loop_budget) throw new LoopBudgetMissingError(task.id);
		const current = this.store.getLoopUsage(task.id);
		const decision = evaluateLoopBudget(task, current, delta);
		if (!decision.allowed) throw new LoopBudgetExhaustedError(decision);
		return this.store.recordLoopUsage(task.id, delta);
	}

	usage(taskId: string): LoopUsage {
		return this.store.getLoopUsage(taskId);
	}
}
