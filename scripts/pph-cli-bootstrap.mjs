#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupCli } from "../packages/coding-agent/dist/cli/setup.js";
import { main } from "../packages/coding-agent/dist/main.js";
import { createPersonalPiInteractiveIngressFactory } from "../packages/personal-pi/src/interactive-ingress.ts";
import { runPersonalPiStableCli } from "../packages/personal-pi/src/stable-cli.ts";

const permissionGatePath = fileURLToPath(new URL("./pi-permission-gate.js", import.meta.url));
const bootstrapPath = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const executionSurface = {
	pph_commit: (() => {
		try {
			return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
		} catch {
			return "unknown";
		}
	})(),
	bundle_sha256: createHash("sha256").update(readFileSync(bootstrapPath)).digest("hex"),
};
const providerMode = process.env.PPH_PROVIDER_MODE;
if (providerMode !== undefined && !["mock", "local", "real"].includes(providerMode)) {
	throw new Error("PPH_PROVIDER_MODE must be one of: mock, local, real");
}
const argv = process.argv.slice(2);
const stable = await runPersonalPiStableCli(argv, {
	permission_gate_path: permissionGatePath,
	execution_surface: executionSurface,
});
if (stable.handled) {
	if (stable.stdout) process.stdout.write(stable.stdout);
	if (stable.stderr) process.stderr.write(stable.stderr);
	process.exitCode = stable.exit_code;
} else {
	setupCli();
	await main(argv, {
				interactiveIngressFactory: createPersonalPiInteractiveIngressFactory({
					permission_gate_path: permissionGatePath,
					provider_mode: providerMode,
					execution_surface: executionSurface,
				}),
				requireInteractiveIngress: true,
				executionSurfaceIdentity: executionSurface,
			});
}
