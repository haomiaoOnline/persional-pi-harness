import { emptyLoopUsage, evaluateLoopBudget, LOOP_USAGE_KEYS } from "./loop-budget.ts";
import { type RegisteredWorker, validateRegisteredWorkerForTask, type WorkerSelectionCandidate } from "./registry.ts";
import { evaluateTaskPermissions } from "./security.ts";
import type {
	LoopUsage,
	PermissionRequest,
	ReasoningDepth,
	RoleProfile,
	TaskContract,
	VerificationStrength,
	WorkerTier,
	WorkerType,
} from "./types.ts";

/** T15.2 remains a suggestion layer. It is not a dispatch or state authority. */
export const LEARNED_ROUTING_SCHEMA_VERSION = "t15.2.v1" as const;

export interface RoutingHistorySample {
	worker_id: string;
	task_type: string;
	successes: number;
	failures: number;
}

export interface RoutingScoreFactors {
	capability_match: number;
	historical_success_rate?: number;
	historical_sample_count: number;
	task_type_match: number;
	cost_penalty: number;
	latency_penalty: number;
}

export interface RoutingSuggestion {
	schema_version: typeof LEARNED_ROUTING_SCHEMA_VERSION;
	task_id: string;
	worker_id: string;
	worker_type: WorkerType;
	worker_tier: WorkerTier;
	reasoning_depth: ReasoningDepth;
	capability_tags: string[];
	score: number;
	factors: RoutingScoreFactors;
	verification_strength: VerificationStrength;
	authority: "advisory";
	task_state_mutation: false;
	permission_request?: PermissionRequest;
	projected_usage?: Partial<LoopUsage>;
}

export interface RoutingGuardInput {
	task: TaskContract;
	candidate: WorkerSelectionCandidate | RegisteredWorker;
	suggestion: RoutingSuggestion;
	role?: RoleProfile;
	approval_valid?: boolean;
	current_usage?: LoopUsage;
}

export interface RoutingGuardDecision {
	allowed: boolean;
	reasons: string[];
	checked_rules: string[];
}

export interface LearnedRoutingInput {
	task: TaskContract;
	candidates: readonly WorkerSelectionCandidate[];
	task_type?: string;
	historical_success?: readonly RoutingHistorySample[];
	role?: RoleProfile;
	approval_valid?: boolean;
	current_usage?: LoopUsage;
}

function tierRank(tier: WorkerTier): number {
	return tier === "cheap" ? 0 : tier === "standard" ? 1 : 2;
}

function verificationRank(strength: VerificationStrength | undefined): number {
	if (strength === undefined) return -1;
	return strength === "none" ? 0 : strength === "weak" ? 1 : 2;
}

function registrationOf(candidate: WorkerSelectionCandidate | RegisteredWorker): RegisteredWorker {
	return "registration" in candidate ? candidate.registration : candidate;
}

function historyFor(
	workerId: string,
	taskType: string,
	history: readonly RoutingHistorySample[],
): { rate?: number; sample_count: number } {
	const samples = history.filter((item) => item.worker_id === workerId && item.task_type === taskType);
	const successes = samples.reduce((sum, item) => sum + item.successes, 0);
	const failures = samples.reduce((sum, item) => sum + item.failures, 0);
	const total = successes + failures;
	return { rate: total > 0 ? successes / total : undefined, sample_count: total };
}

function validateHistory(history: readonly RoutingHistorySample[]): void {
	for (const sample of history) {
		if (!sample.worker_id || !sample.task_type) throw new Error("routing history requires worker_id and task_type");
		for (const value of [sample.successes, sample.failures]) {
			if (!Number.isInteger(value) || value < 0)
				throw new Error("routing history counts must be non-negative integers");
		}
	}
}

function baseSuggestion(
	task: TaskContract,
	candidate: WorkerSelectionCandidate,
	factors: RoutingScoreFactors,
): RoutingSuggestion {
	const registration = candidate.registration;
	return {
		schema_version: LEARNED_ROUTING_SCHEMA_VERSION,
		task_id: task.id,
		worker_id: candidate.worker_id,
		worker_type: registration.worker_type,
		worker_tier: registration.manifest.worker_plugin.cost_tier,
		reasoning_depth: task.execution.reasoning_depth,
		capability_tags: [...task.execution.capability_tags].sort(),
		score:
			factors.capability_match * 100 +
			(factors.historical_success_rate ?? 0) * 25 +
			factors.task_type_match * 10 -
			factors.cost_penalty -
			factors.latency_penalty,
		factors,
		verification_strength: task.verification.strength,
		authority: "advisory",
		task_state_mutation: false,
	};
}

function validateUsage(usage: Partial<LoopUsage>): string[] {
	const reasons: string[] = [];
	for (const key of LOOP_USAGE_KEYS) {
		const value = usage[key];
		if (value !== undefined && (!Number.isFinite(value) || value < 0))
			reasons.push(`projected usage must be finite and non-negative: ${key}`);
	}
	for (const key of Object.keys(usage)) {
		if (!(LOOP_USAGE_KEYS as readonly string[]).includes(key)) reasons.push(`unknown projected usage field: ${key}`);
	}
	return reasons;
}

/**
 * The only hard-rule implementation in this file. It calls the existing
 * security and Loop Budget predicates and only returns a decision; it never
 * changes the Task Contract, Registry, Persistent State, or execution result.
 */
export class RoutingRuleGuard {
	validate(input: RoutingGuardInput): RoutingGuardDecision {
		const { task, suggestion } = input;
		const registration = registrationOf(input.candidate);
		const plugin = registration.manifest.worker_plugin;
		const checkedRules = [
			"task_identity",
			"suggestion_authority",
			"worker_availability",
			"worker_type",
			"worker_tier",
			"capability_tags",
			"context_limit",
			"reasoning_depth",
			"role_boundary",
			"permissions",
			"approval",
			"verification_strength",
			"loop_budget",
		];
		const reasons: string[] = [];
		if (suggestion.task_id !== task.id) reasons.push(`task_id mismatch: expected ${task.id}`);
		if (suggestion.authority !== "advisory" || suggestion.task_state_mutation !== false)
			reasons.push("routing suggestion is not advisory-only");
		if (!registration.available) reasons.push(`worker is unavailable: ${registration.worker_id}`);
		if (suggestion.worker_id !== registration.worker_id) reasons.push("suggestion worker_id does not match Registry");
		if (suggestion.worker_type !== registration.worker_type)
			reasons.push("suggestion worker_type does not match Registry");
		if (task.execution.worker_type !== "cli" && registration.worker_type !== task.execution.worker_type)
			reasons.push(`worker type violates Task Contract: ${registration.worker_type}`);
		if (suggestion.worker_tier !== plugin.cost_tier) reasons.push("suggestion worker_tier does not match manifest");
		if (suggestion.reasoning_depth !== task.execution.reasoning_depth)
			reasons.push(`reasoning depth must remain ${task.execution.reasoning_depth}`);
		if (task.role_profile_ref && !input.role) reasons.push("role profile is required for this Task Contract");
		if (task.role_profile_ref && input.role && task.role_profile_ref !== input.role.id)
			reasons.push(`role profile mismatch: expected ${task.role_profile_ref}`);
		const canonicalRegistry = validateRegisteredWorkerForTask(task, registration, input.role);
		if (!canonicalRegistry.allowed) reasons.push(...canonicalRegistry.reasons);

		const permission = evaluateTaskPermissions(task, suggestion.permission_request ?? {}, input.role);
		if (!permission.allowed) reasons.push(...permission.reasons);
		if (task.approval.required && input.approval_valid !== true)
			reasons.push("required Task approval is not valid for this suggestion");
		if (verificationRank(suggestion.verification_strength) < verificationRank(task.verification.strength))
			reasons.push(`verification strength cannot be reduced below ${task.verification.strength}`);

		if (suggestion.projected_usage) {
			reasons.push(...validateUsage(suggestion.projected_usage));
			const hasPositiveUsage = LOOP_USAGE_KEYS.some((key) => (suggestion.projected_usage?.[key] ?? 0) > 0);
			if (hasPositiveUsage && !task.loop_budget) {
				reasons.push("projected route usage has no Task Contract Loop Budget");
			} else if (task.loop_budget) {
				const budget = evaluateLoopBudget(
					task,
					input.current_usage ?? emptyLoopUsage(),
					suggestion.projected_usage,
				);
				if (!budget.allowed) reasons.push(...budget.reasons);
			}
		}
		return { allowed: reasons.length === 0, reasons: [...new Set(reasons)], checked_rules: checkedRules };
	}
}

export class LearnedRoutingAdvisor {
	private readonly guard: RoutingRuleGuard;

	constructor(guard = new RoutingRuleGuard()) {
		this.guard = guard;
	}

	recommend(input: LearnedRoutingInput): RoutingSuggestion[] {
		const taskType = input.task_type ?? input.task.type;
		const history = input.historical_success ?? [];
		validateHistory(history);
		const suggestions: RoutingSuggestion[] = [];
		for (const candidate of [...input.candidates].sort((left, right) =>
			left.worker_id.localeCompare(right.worker_id),
		)) {
			const registration = candidate.registration;
			const plugin = registration.manifest.worker_plugin;
			const required = new Set(input.task.execution.capability_tags);
			const matching = [...required].filter((tag) => plugin.capability_tags.includes(tag)).length;
			const historyValue = historyFor(candidate.worker_id, taskType, history);
			const factors: RoutingScoreFactors = {
				capability_match: required.size === 0 ? 1 : matching / required.size,
				historical_success_rate: historyValue.rate,
				historical_sample_count: historyValue.sample_count,
				task_type_match: historyValue.sample_count > 0 ? 1 : 0,
				cost_penalty: Math.max(0, tierRank(plugin.cost_tier) - tierRank(input.task.execution.worker_tier)) * 5,
				latency_penalty: registration.capabilities.latency_ms / 1000,
			};
			const suggestion = baseSuggestion(input.task, candidate, factors);
			const guardResult = this.guard.validate({
				task: input.task,
				candidate,
				suggestion,
				role: input.role,
				approval_valid: input.approval_valid,
				current_usage: input.current_usage,
			});
			if (!guardResult.allowed) continue;
			// Re-check immediately before returning the advisory result. There is no
			// public path from an unguarded score to a route selection.
			const finalGuard = this.guard.validate({
				task: input.task,
				candidate,
				suggestion,
				role: input.role,
				approval_valid: input.approval_valid,
				current_usage: input.current_usage,
			});
			if (finalGuard.allowed) suggestions.push(structuredClone(suggestion));
		}
		return suggestions.sort(
			(left, right) => right.score - left.score || left.worker_id.localeCompare(right.worker_id),
		);
	}
}

export function recommendRouting(input: LearnedRoutingInput): RoutingSuggestion[] {
	return new LearnedRoutingAdvisor().recommend(input);
}
