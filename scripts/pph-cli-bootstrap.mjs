#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { setupCli } from "../packages/coding-agent/dist/cli/setup.js";
import { main } from "../packages/coding-agent/dist/main.js";
import { createPersonalPiInteractiveIngressFactory } from "../packages/personal-pi/src/interactive-ingress.ts";

setupCli();
void main(process.argv.slice(2), {
	interactiveIngressFactory: createPersonalPiInteractiveIngressFactory({
		permission_gate_path: fileURLToPath(new URL("./pi-permission-gate.js", import.meta.url)),
	}),
});
