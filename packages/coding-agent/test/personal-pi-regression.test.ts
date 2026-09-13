import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir } from "../src/config.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let testRoot: string;
const personalRegressionEnabled = process.env.PPH_PERSONAL_REGRESSION === "1";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
	testRoot = mkdtempSync(join(tmpdir(), "pph-personal-regression-test-"));
});

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

describe.skipIf(!personalRegressionEnabled)("Personal PI identity", () => {
	test("keeps the PPH application and namespace identity", () => {
		expect(APP_NAME).toBe("pph");
		expect(CONFIG_DIR_NAME).toBe(".pph");
		expect(ENV_AGENT_DIR).toBe("PPH_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("PPH_CODING_AGENT_SESSION_DIR");

		const previousAgentDir = process.env[ENV_AGENT_DIR];
		delete process.env[ENV_AGENT_DIR];
		try {
			expect(getAgentDir()).toBe(join(homedir(), ".pph", "agent"));
		} finally {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	});

	test("reads and writes project settings in .pph, never the legacy .pi path", async () => {
		const projectDir = join(testRoot, "project");
		const agentDir = join(testRoot, "agent");
		const legacySettings = join(projectDir, ".pi", "settings.json");
		const personalSettings = join(projectDir, CONFIG_DIR_NAME, "settings.json");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		// 这个夹具故意同时放入旧命名空间，确保测试验证的是 PPH 的真实边界。
		writeJson(legacySettings, { defaultModel: "legacy-pi-model" });
		writeJson(personalSettings, { defaultModel: "personal-pph-model" });

		const settings = SettingsManager.create(projectDir, agentDir);
		expect(settings.getDefaultModel()).toBe("personal-pph-model");

		settings.setProjectPackages(["npm:@pph/example"]);
		await settings.flush();

		expect(JSON.parse(readFileSync(personalSettings, "utf8")).packages).toEqual(["npm:@pph/example"]);
		expect(JSON.parse(readFileSync(legacySettings, "utf8"))).toEqual({
			defaultModel: "legacy-pi-model",
		});
	});

	test("discovers system prompts and prompts from .pph only", async () => {
		const projectDir = join(testRoot, "project");
		const agentDir = join(testRoot, "agent");
		mkdirSync(join(projectDir, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME, "prompts"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		writeFileSync(join(projectDir, ".pi", "SYSTEM.md"), "legacy system prompt\n");
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "SYSTEM.md"), "personal system prompt\n");
		writeFileSync(join(projectDir, ".pi", "prompts", "deploy.md"), "legacy deploy prompt\n");
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "prompts", "deploy.md"), "personal deploy prompt\n");

		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });
		await loader.reload();

		expect(loader.getSystemPrompt()).toBe("personal system prompt\n");
		const deployPrompt = loader.getPrompts().prompts.find((prompt) => prompt.name === "deploy");
		expect(deployPrompt?.filePath).toBe(join(projectDir, CONFIG_DIR_NAME, "prompts", "deploy.md"));
	});
});

describe.skipIf(!personalRegressionEnabled)("Personal PI distribution metadata", () => {
	test("keeps package, shrinkwrap, and install-lock names aligned", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const shrinkwrap = JSON.parse(readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
		const installLock = JSON.parse(
			readFileSync(new URL("../install-lock/package-lock.json", import.meta.url), "utf8"),
		);

		expect(packageJson.name).toBe("@earendil-works/pi-coding-agent");
		expect(packageJson.bin).toEqual({ pph: "dist/bundle/cli.js" });
		expect(shrinkwrap.packages[""].name).toBe("@earendil-works/pi-coding-agent");
		expect(shrinkwrap.packages[""].bin).toEqual({ pph: "dist/bundle/cli.js" });
		expect(installLock.packages[""].name).toBe("@earendil-works/pi-coding-agent-install");
		expect(installLock.packages["node_modules/@earendil-works/pi-coding-agent"].bin).toEqual({
			pph: "dist/bundle/cli.js",
		});
	});
});
