#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { setupCli } from "../packages/coding-agent/dist/cli/setup.js";
import { main } from "../packages/coding-agent/dist/main.js";
import { createPersonalPiInteractiveIngressFactory } from "../packages/personal-pi/src/interactive-ingress.ts";
import { runPersonalPiStableCli } from "../packages/personal-pi/src/stable-cli.ts";

const permissionGatePath = fileURLToPath(new URL("./pi-permission-gate.js", import.meta.url));
const providerMode = process.env.PPH_PROVIDER_MODE;
if (providerMode !== undefined && !["mock", "local", "real"].includes(providerMode)) {
	throw new Error("PPH_PROVIDER_MODE must be one of: mock, local, real");
}
const argv = process.argv.slice(2);
const stable = await runPersonalPiStableCli(argv, { permission_gate_path: permissionGatePath });
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
		}),
	});
}
