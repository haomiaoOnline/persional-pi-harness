import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseWorkerPluginManifest, validateWorkerPluginManifest, type WorkerPluginManifest } from "../src/index.ts";

const exampleFiles = [
	new URL("../examples/worker-plugins/codex-cli.plugin_manifest.yaml", import.meta.url),
	new URL("../examples/worker-plugins/claude-cli.plugin_manifest.yaml", import.meta.url),
	new URL("../examples/worker-plugins/pi-agent-deepseek-v4-flash.plugin_manifest.yaml", import.meta.url),
	new URL("../examples/worker-plugins/codex-cli-existing-session.plugin_manifest.yaml", import.meta.url),
];

describe("T12.0-A Worker Plugin Manifest", () => {
	test("validates both static example manifests", () => {
		for (const file of exampleFiles) {
			const result = parseWorkerPluginManifest(readFileSync(file, "utf8"));
			expect(result.valid, file.toString()).toBe(true);
			expect(result.value?.worker_plugin.discovery.type).toBe("static_config");
		}
	});

	test("keeps auth metadata secret-free and maps reasoning levels to Task Contract values", () => {
		const result = parseWorkerPluginManifest(readFileSync(exampleFiles[0], "utf8"));
		const manifest = result.value as WorkerPluginManifest;

		expect(manifest.worker_plugin.auth).toEqual({ type: "api_key", env_var: "CODEX_API_KEY" });
		expect(manifest.worker_plugin.models_supported[0]?.reasoning_levels).toEqual(["low", "medium", "high"]);
		expect(JSON.stringify(manifest)).not.toMatch(/secret|token|key-[a-z0-9]+/i);
	});

	test("real CLI manifests point to checked-in adapter entries", () => {
		for (const file of exampleFiles.slice(2)) {
			const result = parseWorkerPluginManifest(readFileSync(file, "utf8"));
			expect(result.valid, file.toString()).toBe(true);
			const entry = result.value?.worker_plugin.adapter_entry;
			expect(entry).toBeTruthy();
			expect(existsSync(join(dirname(fileURLToPath(file)), "..", "..", entry as string))).toBe(true);
			expect(result.value?.worker_plugin.auth.type).toBe("none");
		}
	});

	test("rejects auto discovery, absolute adapter paths, and invalid auth declarations", () => {
		const autoDiscovery = validateWorkerPluginManifest({
			worker_plugin: {
				id: "future-worker",
				adapter_entry: "adapters/future.ts",
				models_supported: [{ model: "future", reasoning_levels: ["high"] }],
				capability_tags: ["coding"],
				context_limit: 1000,
				cost_tier: "standard",
				auth: { type: "none" },
				discovery: { type: "auto_probe" },
			},
		});
		const absolutePath = validateWorkerPluginManifest({
			worker_plugin: {
				id: "future-worker",
				adapter_entry: "/tmp/future.ts",
				models_supported: [{ model: "future", reasoning_levels: ["high"] }],
				capability_tags: ["coding"],
				context_limit: 1000,
				cost_tier: "standard",
				auth: { type: "api_key" },
				discovery: { type: "static_config" },
			},
		});

		expect(autoDiscovery.valid).toBe(false);
		expect(absolutePath.valid).toBe(false);
		expect(absolutePath.errors.join(" ")).toContain("env_var");
		expect(absolutePath.errors.join(" ")).toContain("relative entry path");
	});
});
