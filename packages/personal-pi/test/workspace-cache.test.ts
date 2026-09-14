import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceCache, type WorkspaceCachePayload } from "../src/index.ts";

const temporaryDirectories: string[] = [];

function payload(): WorkspaceCachePayload {
	return {
		logged_in_services: ["browser.example"],
		browser_profile_ref: "profile-ref-1",
		local_index_ref: "sha256:index-1",
	};
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T12.7 Role Workspace Persistence Cache", () => {
	test("persists only rebuildable metadata and honors TTL across cache instances", () => {
		let clock = 1_000;
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-workspace-cache-"));
		temporaryDirectories.push(directory);
		const filePath = join(directory, "workspace-cache.json");
		const first = new WorkspaceCache({ file_path: filePath, now: () => clock });
		const record = first.put("backend-engineer", "browser", payload(), 100);

		expect(record.authoritative).toBe(false);
		expect(record.rebuildable).toBe(true);
		expect(
			new WorkspaceCache({ file_path: filePath, now: () => clock }).get("backend-engineer", "browser")?.payload,
		).toEqual(payload());
		clock = 1_101;
		expect(first.get("backend-engineer", "browser")).toBeUndefined();
	});

	test("rebuilds after clear without making the task depend on the cache", () => {
		const cache = new WorkspaceCache();
		let rebuilds = 0;
		const rebuild = () => {
			rebuilds += 1;
			return payload();
		};

		expect(cache.rebuild("qa", "browser", 1_000, rebuild).cache_hit).toBe(false);
		expect(cache.rebuild("qa", "browser", 1_000, rebuild).cache_hit).toBe(true);
		cache.clear();
		const rerun = cache.rebuild("qa", "browser", 1_000, rebuild);
		expect(rerun).toEqual({ value: payload(), cache_hit: false });
		expect(rebuilds).toBe(2);
	});

	test("ignores corrupted cache data and rebuilds from the authoritative task path", () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-workspace-cache-corrupt-"));
		temporaryDirectories.push(directory);
		const filePath = join(directory, "workspace-cache.json");
		writeFileSync(filePath, "not-json", "utf8");
		const cache = new WorkspaceCache({ file_path: filePath });
		const result = cache.rebuild("researcher", "index", 1_000, payload);

		expect(result.cache_hit).toBe(false);
		expect(result.value).toEqual(payload());
		expect(cache.stats().integrity_misses).toBe(1);
		expect(JSON.stringify(cache.list())).not.toMatch(/password|secret|token|api[_-]?key/i);
	});
});
