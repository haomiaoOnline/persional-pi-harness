import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: Record<string, string>;
	dependencies?: Record<string, string>;
	piConfig: { name: string; configDir: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { source: string };
		"./experimental/plugin": { source: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin).toEqual({ pph: "dist/bundle/cli.js" });
		expect(packageJson.piConfig).toEqual({ name: "pph", configDir: ".pph" });
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
		expect(packageJson.dependencies?.["@personal-pi/core"]).toBeUndefined();
	});

	// Regression for #9132: internal experimental entrypoints must not be published runtime exports.
	test("keeps experimental exports source-only", () => {
		expect(packageJson.exports["./client"]).toEqual({ source: "./src/client/index.ts" });
		expect(packageJson.exports["./experimental/plugin"]).toEqual({ source: "./src/experimental/plugin.ts" });
	});
});
