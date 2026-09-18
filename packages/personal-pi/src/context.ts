import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateMasterHandoffReceipt } from "./handoff.ts";
import type {
	ContextCacheStats,
	ContextManifest,
	ContextReference,
	EvidenceSummary,
	ReadinessEvaluation,
	ResolvedContext,
	ResolvedContextItem,
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

export class ContextCompactionPolicy {
	buildReport(summaries: readonly EvidenceSummary[]): string {
		return summaries
			.map(
				(summary) =>
					`${summary.task_id}: ${summary.status} — ${summary.summary} [evidence:${summary.evidence_ref}]`,
			)
			.join("\n");
	}
}

export function contextSourceLabel(reference: ContextReference): string {
	return reference.source_path ? basename(reference.source_path) : reference.digest;
}
