import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateMasterHandoffReceipt } from "./handoff.ts";
import type {
	ContextCacheStats,
	ContextCompactionReport,
	ContextManifest,
	ContextReference,
	DecisionRecord,
	PersistentState,
	PromptViewAudit,
	ReadinessEvaluation,
	ResolvedContext,
	ResolvedContextItem,
	ToolResultEnvelope,
	ValidationResult,
} from "./types.ts";

export const ContextManifestSchema = Type.Object(
	{
		required: Type.Array(Type.String()),
		optional: Type.Array(Type.String()),
		excluded: Type.Array(Type.String()),
		budget: Type.Object({ max_input_tokens: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);

function textDigest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function manifestDigest(manifest: ContextManifest): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function tokenEstimate(content: string): number {
	return Math.max(1, Math.ceil(content.length / 4));
}

function compactToBudget(content: string, maxTokens: number): string {
	const maxCharacters = Math.max(1, maxTokens * 4);
	if (content.length <= maxCharacters) return content;
	if (maxCharacters <= 24) return content.slice(0, maxCharacters);
	const marker = "\n…[compacted]…\n";
	const available = maxCharacters - marker.length;
	const head = Math.ceil(available * 0.6);
	return `${content.slice(0, head)}${marker}${content.slice(-Math.max(1, available - head))}`;
}

export class ContextManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextManifestError";
	}
}

export class MissingContextReferenceError extends Error {
	readonly digest: string;

	constructor(digest: string) {
		super(`context reference not found or failed hash check: ${digest}`);
		this.name = "MissingContextReferenceError";
		this.digest = digest;
	}
}

export class ContextBudgetExceededError extends Error {
	constructor(message = "上下文超预算") {
		super(message);
		this.name = "ContextBudgetExceededError";
	}
}

interface StoredContext {
	content: string;
	source_path?: string;
	held_out?: boolean;
}

export class ContextStore {
	private readonly rootPath?: string;
	private readonly objects = new Map<string, StoredContext>();
	private readonly misses = new Set<string>();

	constructor(rootPath?: string) {
		this.rootPath = rootPath;
		if (rootPath) mkdirSync(rootPath, { recursive: true });
	}

	put(content: string, options: { source_path?: string; held_out?: boolean } = {}): ContextReference {
		const digest = textDigest(content);
		this.objects.set(digest, { content, source_path: options.source_path, held_out: options.held_out });
		if (this.rootPath) {
			const path = join(this.rootPath, digest);
			if (!existsSync(path)) writeFileSync(path, content, "utf8");
		}
		return {
			digest,
			source_path: options.source_path,
			token_estimate: tokenEstimate(content),
			held_out: options.held_out,
		};
	}

	putSource(sourcePath: string, options: { held_out?: boolean } = {}): ContextReference {
		return this.put(readFileSync(sourcePath, "utf8"), { source_path: sourcePath, held_out: options.held_out });
	}

	get(
		digest: string,
		options: { evaluation?: boolean } = {},
	): { reference: ContextReference; content: string } | undefined {
		let stored = this.objects.get(digest);
		if (!stored && this.rootPath) {
			const path = join(this.rootPath, digest);
			if (existsSync(path)) stored = { content: readFileSync(path, "utf8") };
		}
		if (!stored || textDigest(stored.content) !== digest || (options.evaluation && stored.held_out)) {
			this.misses.add(digest);
			return undefined;
		}
		return {
			reference: {
				digest,
				source_path: stored.source_path,
				token_estimate: tokenEstimate(stored.content),
				held_out: stored.held_out,
			},
			content: stored.content,
		};
	}

	stats(): { objects: number; integrity_misses: number } {
		return { objects: this.objects.size, integrity_misses: this.misses.size };
	}
}

export function validateContextManifest(value: unknown): ValidationResult<ContextManifest> {
	if (!Value.Check(ContextManifestSchema, value)) {
		return {
			valid: false,
			errors: [...Value.Errors(ContextManifestSchema, value)].map((error) => {
				const path = "path" in error && typeof error.path === "string" ? error.path : "/";
				return `${path || "/"}: ${error.message}`;
			}),
		};
	}
	const manifest = value as ContextManifest;
	const seen = new Set<string>();
	const errors: string[] = [];
	for (const [group, references] of Object.entries({
		required: manifest.required,
		optional: manifest.optional,
		excluded: manifest.excluded,
	})) {
		for (const reference of references) {
			if (seen.has(reference)) errors.push(`/${group}: duplicate or overlapping context reference ${reference}`);
			seen.add(reference);
		}
	}
	return errors.length === 0 ? { valid: true, value: manifest, errors: [] } : { valid: false, errors };
}

export interface ContextResolverOptions {
	evaluation?: boolean;
	reuse_cache?: boolean;
}

export class ContextResolver {
	private readonly cache = new Map<string, ResolvedContext>();
	private hitCount = 0;
	private missCount = 0;
	private readonly store: ContextStore;

	constructor(store: ContextStore) {
		this.store = store;
	}

	resolve(manifest: ContextManifest, options: ContextResolverOptions = {}): ResolvedContext {
		const validation = validateContextManifest(manifest);
		if (!validation.valid) throw new ContextManifestError(validation.errors.join("; "));
		const key = manifestDigest(manifest);
		const cached = options.reuse_cache !== false ? this.cache.get(key) : undefined;
		if (
			cached?.items.every((item) => this.store.get(item.digest, { evaluation: options.evaluation }) !== undefined)
		) {
			this.hitCount += 1;
			return { ...structuredClone(cached), cache_hit: true };
		}
		this.missCount += 1;
		const excluded = new Set(manifest.excluded);
		const required = manifest.required.filter((digest) => !excluded.has(digest));
		const optional = manifest.optional.filter((digest) => !excluded.has(digest));
		const loadedRequired = required.map((digest) => {
			const value = this.store.get(digest, { evaluation: options.evaluation });
			if (!value) throw new MissingContextReferenceError(digest);
			return { digest, content: value.content, token_estimate: value.reference.token_estimate };
		});
		if (loadedRequired.length > manifest.budget.max_input_tokens) throw new ContextBudgetExceededError();

		const items: ResolvedContextItem[] = [];
		let totalTokens = 0;
		for (let index = 0; index < loadedRequired.length; index += 1) {
			const source = loadedRequired[index];
			const remainingRequired = loadedRequired.length - index - 1;
			const available = manifest.budget.max_input_tokens - totalTokens - remainingRequired;
			const content = compactToBudget(source.content, Math.max(1, Math.min(source.token_estimate, available)));
			const item = { digest: source.digest, content, token_estimate: tokenEstimate(content) };
			items.push(item);
			totalTokens += item.token_estimate;
		}

		const omittedOptional: string[] = [];
		for (const digest of optional) {
			const value = this.store.get(digest, { evaluation: options.evaluation });
			if (!value) {
				omittedOptional.push(digest);
				continue;
			}
			const remaining = manifest.budget.max_input_tokens - totalTokens;
			if (remaining < 1) {
				omittedOptional.push(digest);
				continue;
			}
			const content = compactToBudget(value.content, Math.min(value.reference.token_estimate, remaining));
			const item = { digest, content, token_estimate: tokenEstimate(content) };
			if (totalTokens + item.token_estimate > manifest.budget.max_input_tokens) {
				omittedOptional.push(digest);
				continue;
			}
			items.push(item);
			totalTokens += item.token_estimate;
		}
		const resolved: ResolvedContext = {
			items,
			text: items.map((item) => item.content).join("\n\n"),
			total_tokens: totalTokens,
			cache_hit: false,
			omitted_optional: omittedOptional,
			manifest_digest: key,
		};
		this.cache.set(key, structuredClone(resolved));
		return resolved;
	}

	stats(): ContextCacheStats {
		return { hits: this.hitCount, misses: this.missCount };
	}

	clearCache(): void {
		this.cache.clear();
	}
}

const CONTAMINATION_MARKER = /\b(?:error|failed|failure|stale|outdated|obsolete|stack trace)\b|错误|失败|过期|陈旧/i;

export function buildPromptViewAudit(input: {
	turn_id: string;
	prompt_text: string;
	resolved_context?: ResolvedContext;
	tool_results?: readonly ToolResultEnvelope[];
}): PromptViewAudit {
	const context = input.resolved_context;
	const toolResults = input.tool_results ?? [];
	const sources = [
		"task_prompt",
		...(context?.items.map((item) => `context:${item.digest}`) ?? []),
		...toolResults.map((result) => `tool:${result.artifact_id}`),
	];
	const truncatedItems = [
		...(context?.omitted_optional.map((digest) => `context:${digest}`) ?? []),
		...(context?.items
			.filter((item) => item.content.includes("…[compacted]…"))
			.map((item) => `context:${item.digest}`) ?? []),
		...toolResults.filter((result) => result.truncated).map((result) => `tool:${result.artifact_id}`),
	];
	const visibleToolBytes = toolResults.reduce(
		(sum, result) => sum + Buffer.byteLength(JSON.stringify(result), "utf8"),
		0,
	);
	const totalSize = Buffer.byteLength(input.prompt_text, "utf8") + visibleToolBytes;
	const contaminatedContextBytes =
		context?.items
			.filter((item) => CONTAMINATION_MARKER.test(item.content))
			.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0) ?? 0;
	const contaminatedToolBytes = toolResults
		.filter((result) => result.status !== "success")
		.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result), "utf8"), 0);
	return {
		turn_id: input.turn_id,
		total_size: totalSize,
		sources: [...new Set(sources)],
		truncated_items: [...new Set(truncatedItems)],
		contamination_ratio:
			totalSize > 0 ? Math.min(1, (contaminatedContextBytes + contaminatedToolBytes) / totalSize) : 0,
	};
}

/**
 * Builds a new cross-Task context projection from receipt-only handoffs.
 * It intentionally has no API for prior ResolvedContext or Worker transcript.
 */
export class FreshContextBuilder {
	build(receipts: readonly unknown[], maxInputTokens: number): ResolvedContext {
		if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1)
			throw new ContextBudgetExceededError("Fresh Context requires a positive Task context budget");
		const seenTasks = new Set<string>();
		const items: ResolvedContextItem[] = [];
		let totalTokens = 0;
		for (const value of receipts) {
			const validation = validateMasterHandoffReceipt(value);
			if (!validation.valid || !validation.value)
				throw new ContextManifestError(`invalid Master handoff receipt: ${validation.errors.join("; ")}`);
			const receipt = validation.value;
			if (seenTasks.has(receipt.task_id))
				throw new ContextManifestError(`duplicate Master handoff receipt for ${receipt.task_id}`);
			seenTasks.add(receipt.task_id);
			const content = JSON.stringify(receipt);
			const tokens = tokenEstimate(content);
			if (totalTokens + tokens > maxInputTokens)
				throw new ContextBudgetExceededError("Fresh Context receipts exceed the Task context budget");
			items.push({ digest: textDigest(content), content, token_estimate: tokens });
			totalTokens += tokens;
		}
		const manifestDigest = createHash("sha256")
			.update(JSON.stringify(items.map((item) => item.digest)))
			.digest("hex");
		return {
			items,
			text: items.map((item) => item.content).join("\n"),
			total_tokens: totalTokens,
			cache_hit: false,
			omitted_optional: [],
			manifest_digest: manifestDigest,
		};
	}
}

export function evaluateContextReadiness(
	manifest: ContextManifest,
	resolver: ContextResolver,
	options: ContextResolverOptions = {},
): ReadinessEvaluation {
	try {
		resolver.resolve(manifest, options);
		return { ready: true, state: "READY", reasons: [] };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "context resolution failed";
		return { ready: false, state: "NOT_READY", reasons: [reason] };
	}
}

export const ContextCompactionReportSchema = Type.Object(
	{
		facts: Type.Array(Type.String()),
		decisions: Type.Array(Type.String()),
		completed_tasks: Type.Array(Type.String()),
		open_tasks: Type.Array(Type.String()),
		open_risks: Type.Array(Type.String()),
		verified_evidence: Type.Array(Type.String()),
		failed_attempts: Type.Array(
			Type.Object({ error_fingerprint: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		),
		next_action: Type.String(),
		git_sha: Type.String(),
		artifact_refs: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export interface ContextCompactionBuildInput {
	state: PersistentState;
	task_ids?: readonly string[];
	anchor_task_id?: string;
	tool_results?: readonly ToolResultEnvelope[];
	next_action?: string;
	git_sha?: string;
	artifact_refs?: readonly string[];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function resolveDecisionTaskId(record: DecisionRecord, state: PersistentState): string | undefined {
	for (const input of record.inputs) {
		if (state.tasks.some((task) => task.id === input)) return input;
		const run = state.runs.find((candidate) => candidate.id === input);
		if (run) return run.task_id;
		const verification = state.verifications.find((candidate) => candidate.id === input);
		if (verification) return verification.task_id;
		const evidence = state.evidence.find((candidate) => candidate.id === input);
		if (evidence) return evidence.task_id;
	}
	return undefined;
}

function latestDecisions(records: readonly DecisionRecord[], state: PersistentState, taskIds: Set<string>): string[] {
	const latest = new Map<string, { record: DecisionRecord; task_id: string }>();
	for (const record of records) {
		const taskId = resolveDecisionTaskId(record, state);
		if (!taskId || !taskIds.has(taskId)) continue;
		const key = `${taskId}\0${record.decision_type}`;
		const current = latest.get(key);
		if (
			!current ||
			record.at > current.record.at ||
			(record.at === current.record.at && record.id.localeCompare(current.record.id) > 0)
		)
			latest.set(key, { record, task_id: taskId });
	}
	return [...latest.values()]
		.sort(
			(left, right) =>
				left.task_id.localeCompare(right.task_id) ||
				left.record.decision_type.localeCompare(right.record.decision_type),
		)
		.map((entry) => `${entry.task_id}:${entry.record.decision_type}:${entry.record.decision}`);
}

function validReceipt(state: PersistentState, taskId: string) {
	const receipt = state.handoff_receipts.find((candidate) => candidate.task_id === taskId);
	const task = state.tasks.find((candidate) => candidate.id === taskId);
	const binding = state.handoff_bindings[taskId];
	const latestRun = state.runs.filter((candidate) => candidate.task_id === taskId).at(-1);
	return receipt &&
		task?.state === receipt.status &&
		binding?.task_revision === task.task_revision &&
		binding.run_id === latestRun?.id
		? receipt
		: undefined;
}

function receiptErrorFingerprint(errorSummary: string | undefined): string | undefined {
	const match = errorSummary?.match(/\berror_fingerprint=([A-Za-z0-9_-]+)/);
	return match?.[1];
}

export function validateContextCompactionReport(value: unknown): ValidationResult<ContextCompactionReport> {
	if (!Value.Check(ContextCompactionReportSchema, value))
		return {
			valid: false,
			errors: [...Value.Errors(ContextCompactionReportSchema, value)].map((error) => {
				const path = "path" in error && typeof error.path === "string" ? error.path : "/";
				return `${path || "/"}: ${error.message}`;
			}),
		};
	return { valid: true, value: value as ContextCompactionReport, errors: [] };
}

export class ContextCompactionPolicy {
	buildReport(input: ContextCompactionBuildInput): ContextCompactionReport {
		const state = input.state;
		const taskIds = new Set(input.task_ids ?? state.tasks.map((task) => task.id));
		const tasks = state.tasks.filter((task) => taskIds.has(task.id));
		const receipts = tasks.map((task) => validReceipt(state, task.id)).filter((receipt) => receipt !== undefined);
		const anchorTaskId = input.anchor_task_id ?? (taskIds.size === 1 ? [...taskIds][0] : undefined);
		const anchorReceipt = anchorTaskId ? validReceipt(state, anchorTaskId) : undefined;
		const anchorRun = anchorTaskId ? state.runs.filter((run) => run.task_id === anchorTaskId).at(-1) : undefined;
		const currentRevisionByTask = new Map(tasks.map((task) => [task.id, task.task_revision]));
		const passingEvidenceIds = unique(
			state.verifications
				.filter(
					(verification) =>
						taskIds.has(verification.task_id) &&
						verification.status === "PASS" &&
						verification.task_revision === currentRevisionByTask.get(verification.task_id) &&
						verification.evidence_id !== undefined &&
						state.evidence.some(
							(evidence) =>
								evidence.id === verification.evidence_id && evidence.task_id === verification.task_id,
						),
				)
				.map((verification) => verification.evidence_id as string),
		).sort();
		const currentEvidence = state.evidence.filter(
			(evidence) =>
				taskIds.has(evidence.task_id) &&
				evidence.delivery_evidence_package?.task_revision === currentRevisionByTask.get(evidence.task_id),
		);
		const fingerprints = unique([
			...(input.tool_results ?? [])
				.map((toolResult) => toolResult.error_fingerprint)
				.filter((fingerprint): fingerprint is string => fingerprint !== null),
			...currentEvidence.flatMap((evidence) =>
				(evidence.tool_results ?? [])
					.map((toolResult) => toolResult.error_fingerprint)
					.filter((fingerprint): fingerprint is string => fingerprint !== null),
			),
			...receipts
				.map((receipt) => receiptErrorFingerprint(receipt.failure?.error_summary))
				.filter((fingerprint): fingerprint is string => fingerprint !== undefined),
		]).sort();
		const report: ContextCompactionReport = {
			facts: [],
			decisions: latestDecisions(state.decisions, state, taskIds),
			completed_tasks: tasks
				.filter((task) => task.state === "DONE")
				.map((task) => task.id)
				.sort(),
			open_tasks: tasks
				.filter((task) => !["DONE", "CANCELLED", "OBSOLETE"].includes(task.state))
				.map((task) => task.id)
				.sort(),
			open_risks: unique(receipts.flatMap((receipt) => receipt.unresolved_risks)).sort(),
			verified_evidence: passingEvidenceIds,
			failed_attempts: fingerprints.map((fingerprint) => ({ error_fingerprint: fingerprint })),
			next_action: input.next_action ?? anchorReceipt?.next_action ?? "",
			git_sha: input.git_sha ?? anchorReceipt?.git_sha ?? anchorRun?.workspace_commit_hash ?? "",
			artifact_refs: unique([
				...(input.artifact_refs ?? []),
				...(input.tool_results ?? []).map((toolResult) => toolResult.artifact_id),
				...currentEvidence.flatMap((evidence) => [
					...evidence.artifacts,
					...(evidence.tool_results ?? []).map((toolResult) => toolResult.artifact_id),
				]),
				...receipts.flatMap((receipt) => receipt.failure?.artifact_refs ?? []),
			]).sort(),
		};
		const validation = validateContextCompactionReport(report);
		if (!validation.valid) throw new Error(`invalid context compaction report: ${validation.errors.join("; ")}`);
		return structuredClone(report);
	}
}

export function contextSourceLabel(reference: ContextReference): string {
	return reference.source_path ? basename(reference.source_path) : reference.digest;
}
