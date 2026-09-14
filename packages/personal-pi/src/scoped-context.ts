import { createHash } from "node:crypto";

export type ContextScope = "org" | "project" | "directory";
export type DirectoryKind = "standard" | "legacy";

export interface ScopedContextEntry {
	key: string;
	content?: string;
	excluded?: boolean;
	/** 只在显式 legacy directory layer 中生效。 */
	legacy_only?: boolean;
}

export interface ScopedContextLayer {
	scope: ContextScope;
	entries: readonly ScopedContextEntry[];
	directory_kind?: DirectoryKind;
}

export interface EffectiveScopedContextEntry {
	key: string;
	content?: string;
	excluded: boolean;
	source_scope: ContextScope;
}

export interface ScopedContextAssembly {
	status: "READY" | "BLOCKED";
	items: EffectiveScopedContextEntry[];
	excluded_keys: string[];
	source_by_key: Record<string, ContextScope>;
	conflicts: string[];
	manifest_digest: string;
}

const SCOPE_ORDER: readonly ContextScope[] = ["org", "project", "directory"];

function entrySignature(entry: ScopedContextEntry): string {
	return JSON.stringify({ content: entry.content ?? null, excluded: entry.excluded === true });
}

function applicable(layer: ScopedContextLayer, entry: ScopedContextEntry): boolean {
	return entry.legacy_only !== true || layer.directory_kind === "legacy";
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * 先在同一 scope 内检测矛盾，再按 org → project → directory 覆盖。
 * 同级冲突返回 BLOCKED，绝不通过猜测决定哪一条生效。
 */
export function assembleScopedContext(layers: readonly ScopedContextLayer[]): ScopedContextAssembly {
	const conflicts: string[] = [];
	const effective = new Map<string, EffectiveScopedContextEntry>();
	const sourceByKey: Record<string, ContextScope> = {};
	for (const scope of SCOPE_ORDER) {
		const sameScope = layers.filter((layer) => layer.scope === scope);
		const byKey = new Map<string, { entry: ScopedContextEntry; layer: ScopedContextLayer }>();
		for (const layer of sameScope) {
			for (const entry of layer.entries) {
				if (entry.key.length === 0 || !applicable(layer, entry)) continue;
				const previous = byKey.get(entry.key);
				if (previous && entrySignature(previous.entry) !== entrySignature(entry)) {
					conflicts.push(`${scope}:${entry.key}`);
					continue;
				}
				byKey.set(entry.key, { entry, layer });
			}
		}
		for (const [key, value] of byKey) {
			const next = {
				key,
				content: value.entry.content,
				excluded: value.entry.excluded === true,
				source_scope: scope,
			};
			effective.set(key, next);
			sourceByKey[key] = scope;
		}
	}

	const uniqueConflicts = [...new Set(conflicts)].sort();
	const entries = [...effective.values()].sort((left, right) => left.key.localeCompare(right.key));
	return {
		status: uniqueConflicts.length > 0 ? "BLOCKED" : "READY",
		items:
			uniqueConflicts.length > 0 ? [] : entries.filter((entry) => !entry.excluded && entry.content !== undefined),
		excluded_keys: entries.filter((entry) => entry.excluded).map((entry) => entry.key),
		source_by_key: sourceByKey,
		conflicts: uniqueConflicts,
		manifest_digest: digest(layers),
	};
}
