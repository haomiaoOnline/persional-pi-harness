import { parseWorkerPluginManifest, validateWorkerPluginManifest } from "./plugin.ts";
import { checkRoleBoundary } from "./roles.ts";
import type {
	RoleProfile,
	TaskContract,
	ValidationResult,
	WorkerPluginManifest,
	WorkerTier,
	WorkerType,
} from "./types.ts";
import type { WorkerAdapter } from "./worker.ts";
import type { WorkerSuccessRateTracker } from "./worker-feedback.ts";

export interface WorkerCapabilityDescriptor {
	languages: string[];
	latency_ms: number;
}

export interface WorkerRegistrationInput {
	worker_id: string;
	worker_type: WorkerType;
	manifest: WorkerPluginManifest;
	adapter: WorkerAdapter;
	capabilities?: Partial<WorkerCapabilityDescriptor>;
}

export interface RegisteredWorker {
	worker_id: string;
	worker_type: WorkerType;
	manifest: WorkerPluginManifest;
	adapter: WorkerAdapter;
	capabilities: WorkerCapabilityDescriptor;
	available: boolean;
}

export interface WorkerSelectionCandidate {
	worker_id: string;
	worker_type: WorkerType;
	score: number;
	historical_success_rate: number;
	reasons: string[];
	registration: RegisteredWorker;
}

export interface WorkerCandidateValidation {
	allowed: boolean;
	reasons: string[];
}

export class WorkerRegistrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerRegistrationError";
	}
}

export class NoWorkerAvailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoWorkerAvailableError";
	}
}

function tierRank(tier: WorkerTier): number {
	return tier === "cheap" ? 0 : tier === "standard" ? 1 : 2;
}

function cloneRegistration(registration: RegisteredWorker): RegisteredWorker {
	return {
		worker_id: registration.worker_id,
		worker_type: registration.worker_type,
		manifest: structuredClone(registration.manifest),
		adapter: registration.adapter,
		capabilities: {
			languages: [...registration.capabilities.languages],
			latency_ms: registration.capabilities.latency_ms,
		},
		available: registration.available,
	};
}

function registrationValidation(input: WorkerRegistrationInput): ValidationResult<WorkerPluginManifest> {
	const validation = validateWorkerPluginManifest(input.manifest);
	if (!validation.valid || !validation.value) return validation;
	const errors: string[] = [];
	if (input.worker_id.length === 0) errors.push("worker_id must not be empty");
	if (input.adapter.worker_id !== input.worker_id) errors.push("adapter worker_id must match worker_id");
	if (input.capabilities?.latency_ms !== undefined && input.capabilities.latency_ms < 0) {
		errors.push("latency_ms must be non-negative");
	}
	return errors.length === 0 ? validation : { valid: false, errors };
}

/** Canonical Registry admission predicate shared by selection and advisory routing. */
export function validateRegisteredWorkerForTask(
	task: TaskContract,
	registration: RegisteredWorker,
	role?: RoleProfile,
): WorkerCandidateValidation {
	const reasons: string[] = [];
	const plugin = registration.manifest.worker_plugin;
	if (!registration.available) reasons.push(`worker is unavailable: ${registration.worker_id}`);
	if (task.execution.worker_type !== "cli" && registration.worker_type !== task.execution.worker_type)
		reasons.push(`worker type violates Task Contract: ${registration.worker_type}`);
	if (tierRank(plugin.cost_tier) < tierRank(task.execution.worker_tier))
		reasons.push(`worker tier is below Task Contract requirement: ${task.execution.worker_tier}`);
	if (plugin.context_limit < task.context.budget.max_input_tokens)
		reasons.push(`worker context limit ${plugin.context_limit} is below ${task.context.budget.max_input_tokens}`);
	if (!plugin.models_supported.some((model) => model.reasoning_levels.includes(task.execution.reasoning_depth)))
		reasons.push(`manifest does not support reasoning depth: ${task.execution.reasoning_depth}`);
	const missingCapabilities = task.execution.capability_tags.filter((tag) => !plugin.capability_tags.includes(tag));
	if (missingCapabilities.length > 0)
		reasons.push(`worker capability tags missing: ${missingCapabilities.sort().join(", ")}`);
	if (role) {
		const boundary = checkRoleBoundary(role, task);
		if (!boundary.allowed) reasons.push(...boundary.reasons);
	}
	return { allowed: reasons.length === 0, reasons };
}

export class WorkerRegistry {
	private readonly workers = new Map<string, RegisteredWorker>();
	private readonly feedback?: Pick<WorkerSuccessRateTracker, "rate">;

	constructor(options: { feedback?: Pick<WorkerSuccessRateTracker, "rate"> } = {}) {
		this.feedback = options.feedback;
	}

	register(input: WorkerRegistrationInput): RegisteredWorker {
		if (this.workers.has(input.worker_id))
			throw new WorkerRegistrationError(`worker already registered: ${input.worker_id}`);
		const validation = registrationValidation(input);
		if (!validation.valid) throw new WorkerRegistrationError(validation.errors.join("; "));
		const registration: RegisteredWorker = {
			worker_id: input.worker_id,
			worker_type: input.worker_type,
			manifest: structuredClone(input.manifest),
			adapter: input.adapter,
			capabilities: {
				languages: [...(input.capabilities?.languages ?? [])],
				latency_ms: input.capabilities?.latency_ms ?? 0,
			},
			available: true,
		};
		this.workers.set(input.worker_id, registration);
		return cloneRegistration(registration);
	}

	registerManifest(input: Omit<WorkerRegistrationInput, "manifest"> & { source: string }): RegisteredWorker {
		const parsed = parseWorkerPluginManifest(input.source);
		if (!parsed.valid || !parsed.value) throw new WorkerRegistrationError(parsed.errors.join("; "));
		return this.register({ ...input, manifest: parsed.value });
	}

	get(workerId: string): RegisteredWorker | undefined {
		const registration = this.workers.get(workerId);
		return registration ? cloneRegistration(registration) : undefined;
	}

	list(): RegisteredWorker[] {
		return [...this.workers.values()].map(cloneRegistration);
	}

	setAvailability(workerId: string, available: boolean): RegisteredWorker {
		const registration = this.workers.get(workerId);
		if (!registration) throw new WorkerRegistrationError(`unknown worker: ${workerId}`);
		registration.available = available;
		return cloneRegistration(registration);
	}

	unregister(workerId: string): void {
		if (!this.workers.delete(workerId)) throw new WorkerRegistrationError(`unknown worker: ${workerId}`);
	}

	selectCandidates(task: TaskContract, role?: RoleProfile): WorkerSelectionCandidate[] {
		const requiredTags = new Set(task.execution.capability_tags);
		const requestedTier = tierRank(task.execution.worker_tier);
		const candidates: WorkerSelectionCandidate[] = [];
		for (const registration of this.workers.values()) {
			if (!validateRegisteredWorkerForTask(task, registration, role).allowed) continue;
			const plugin = registration.manifest.worker_plugin;

			const tierDifference = tierRank(plugin.cost_tier) - requestedTier;
			const matchingTags = [...requiredTags].filter((tag) => plugin.capability_tags.includes(tag)).length;
			const preferredMatches = role
				? role.preferred_tools.filter((tool) => plugin.capability_tags.includes(tool)).length
				: 0;
			const historicalSuccessRate = this.feedback?.rate(registration.worker_id, task.type)?.rate ?? 0.5;
			const score =
				matchingTags * 100 +
				preferredMatches * 10 -
				tierDifference * 5 -
				registration.capabilities.latency_ms / 1000;
			candidates.push({
				worker_id: registration.worker_id,
				worker_type: registration.worker_type,
				score,
				historical_success_rate: historicalSuccessRate,
				reasons: [
					`capability_tags matched ${matchingTags}/${requiredTags.size}`,
					`reasoning_depth ${task.execution.reasoning_depth} supported`,
					`context_limit ${plugin.context_limit} >= ${task.context.budget.max_input_tokens}`,
					`cost_tier ${plugin.cost_tier} satisfies ${task.execution.worker_tier}`,
				],
				registration: cloneRegistration(registration),
			});
		}
		return candidates.sort(
			(left, right) =>
				right.score - left.score ||
				right.historical_success_rate - left.historical_success_rate ||
				left.worker_id.localeCompare(right.worker_id),
		);
	}

	select(task: TaskContract, role?: RoleProfile): WorkerSelectionCandidate {
		const candidates = this.selectCandidates(task, role);
		const selected = candidates[0];
		if (!selected) throw new NoWorkerAvailableError(`no registered worker satisfies task ${task.id}`);
		return selected;
	}
}
