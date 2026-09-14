import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WorkspaceCachePayload {
	logged_in_services: string[];
	browser_profile_ref?: string;
	local_index_ref?: string;
}

export interface WorkspaceCacheRecord {
	role_id: string;
	cache_key: string;
	payload: WorkspaceCachePayload;
	authoritative: false;
	rebuildable: true;
	created_at: number;
	expires_at: number;
}

export interface WorkspaceCacheLookup<T> {
	value: T;
	cache_hit: boolean;
}

export interface WorkspaceCacheStats {
	entries: number;
	hits: number;
	misses: number;
	integrity_misses: number;
	persistence_errors: number;
}

interface WorkspaceCacheOptions {
	file_path?: string;
	now?: () => number;
}

function cacheKey(roleId: string, key: string): string {
	return `${roleId}\u0000${key}`;
}

function clonePayload(payload: WorkspaceCachePayload): WorkspaceCachePayload {
	return {
		logged_in_services: [...payload.logged_in_services],
		browser_profile_ref: payload.browser_profile_ref,
		local_index_ref: payload.local_index_ref,
	};
}

function validRecord(value: unknown): value is WorkspaceCacheRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<WorkspaceCacheRecord>;
	return (
		typeof record.role_id === "string" &&
		typeof record.cache_key === "string" &&
		record.authoritative === false &&
		record.rebuildable === true &&
		typeof record.created_at === "number" &&
		typeof record.expires_at === "number" &&
		!!record.payload &&
		Array.isArray(record.payload.logged_in_services) &&
		record.payload.logged_in_services.every((service) => typeof service === "string") &&
		(record.payload.browser_profile_ref === undefined || typeof record.payload.browser_profile_ref === "string") &&
		(record.payload.local_index_ref === undefined || typeof record.payload.local_index_ref === "string")
	);
}

export class WorkspaceCache {
	private readonly filePath?: string;
	private readonly now: () => number;
	private readonly entries = new Map<string, WorkspaceCacheRecord>();
	private hitCount = 0;
	private missCount = 0;
	private integrityMissCount = 0;
	private persistenceErrorCount = 0;

	constructor(options: WorkspaceCacheOptions = {}) {
		this.filePath = options.file_path;
		this.now = options.now ?? (() => Date.now());
		this.load();
	}

	put(roleId: string, key: string, payload: WorkspaceCachePayload, ttlMs: number): WorkspaceCacheRecord {
		if (roleId.length === 0 || key.length === 0) throw new Error("workspace cache role_id and key are required");
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("workspace cache ttl must be positive");
		const createdAt = this.now();
		const record: WorkspaceCacheRecord = {
			role_id: roleId,
			cache_key: key,
			payload: clonePayload(payload),
			authoritative: false,
			rebuildable: true,
			created_at: createdAt,
			expires_at: createdAt + ttlMs,
		};
		this.entries.set(cacheKey(roleId, key), record);
		this.persist();
		return structuredClone(record);
	}

	get(roleId: string, key: string): WorkspaceCacheRecord | undefined {
		const stored = this.entries.get(cacheKey(roleId, key));
		if (!stored || stored.expires_at <= this.now()) {
			this.missCount += 1;
			if (stored) {
				this.entries.delete(cacheKey(roleId, key));
				this.persist();
			}
			return undefined;
		}
		this.hitCount += 1;
		return structuredClone(stored);
	}

	rebuild(
		roleId: string,
		key: string,
		ttlMs: number,
		builder: () => WorkspaceCachePayload,
	): WorkspaceCacheLookup<WorkspaceCachePayload> {
		const cached = this.get(roleId, key);
		if (cached) return { value: clonePayload(cached.payload), cache_hit: true };
		const value = clonePayload(builder());
		this.put(roleId, key, value, ttlMs);
		return { value, cache_hit: false };
	}

	clear(roleId?: string): void {
		if (roleId === undefined) this.entries.clear();
		else for (const [key, entry] of this.entries) if (entry.role_id === roleId) this.entries.delete(key);
		this.persist();
	}

	list(): WorkspaceCacheRecord[] {
		return [...this.entries.values()].map((entry) => structuredClone(entry));
	}

	stats(): WorkspaceCacheStats {
		return {
			entries: this.entries.size,
			hits: this.hitCount,
			misses: this.missCount,
			integrity_misses: this.integrityMissCount,
			persistence_errors: this.persistenceErrorCount,
		};
	}

	private load(): void {
		if (!this.filePath || !existsSync(this.filePath)) return;
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
			if (!Array.isArray(parsed)) throw new Error("workspace cache root must be an array");
			for (const value of parsed) {
				if (!validRecord(value)) {
					this.integrityMissCount += 1;
					continue;
				}
				this.entries.set(cacheKey(value.role_id, value.cache_key), structuredClone(value));
			}
		} catch {
			this.integrityMissCount += 1;
			this.entries.clear();
		}
	}

	private persist(): void {
		if (!this.filePath) return;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, `${JSON.stringify([...this.entries.values()], null, 2)}\n`, "utf8");
		} catch {
			this.persistenceErrorCount += 1;
		}
	}
}
