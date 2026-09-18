import assert from "node:assert/strict";
import test from "node:test";
import { validateBundleExternalImports, validateBundleRequiredOutputs } from "./coding-agent-bundle-policy.mjs";

function metafile(path, external = true) {
	return {
		inputs: {
			"entry.js": {
				imports: [{ path, external }],
			},
		},
	};
}

test("bundle policy rejects an external private Personal PI core import", () => {
	assert.throws(
		() => validateBundleExternalImports([metafile("@personal-pi/core")], new Set()),
		/Bundle left unexpected external imports: @personal-pi\/core/,
	);
});

test("bundle policy permits embedded private code and declared externals", () => {
	assert.doesNotThrow(() =>
		validateBundleExternalImports(
			[metafile("../packages/personal-pi/src/interactive-ingress.ts", false), metafile("jiti")],
			new Set(["jiti"]),
		),
	);
});

test("bundle policy requires the permission-gate sidecar", () => {
	const withGate = {
		inputs: {},
		outputs: { "packages/coding-agent/dist/bundle/pi-permission-gate.js": { bytes: 1, inputs: {}, imports: [] } },
	};
	assert.doesNotThrow(() =>
		validateBundleRequiredOutputs([withGate], ["packages/coding-agent/dist/bundle/pi-permission-gate.js"]),
	);
	assert.throws(
		() => validateBundleRequiredOutputs([{ inputs: {}, outputs: {} }], ["dist/bundle/pi-permission-gate.js"]),
		/Bundle did not emit required output\(s\): dist\/bundle\/pi-permission-gate\.js/,
	);
});
