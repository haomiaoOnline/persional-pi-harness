import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	loadKnownExternalGapRegistry,
	parseKnownExternalGapRegistry,
	validateKnownExternalGapRegistry,
} from "../src/index.ts";

const registryPath = new URL("../../../docs/stage-gates/known_gaps.yaml", import.meta.url);

describe("T0.3 Known External Gap Registry", () => {
	test("loads the canonical GAP-01 record with non-blocking MVP impact", () => {
		const registry = loadKnownExternalGapRegistry(registryPath.pathname);
		const gap = registry.known_gaps.find((entry) => entry.id === "GAP-01");

		expect(gap).toMatchObject({
			id: "GAP-01",
			resolution: "Phase 14 Multi-CRI",
			mvp_impact: "NON_BLOCKING",
		});
		expect(gap?.evidence).toContain("observed_runtime_model=unknown");
		expect(gap?.decision).toContain("requested or configured model");
	});

	test("rejects duplicate IDs and a blocking GAP-01", () => {
		const result = validateKnownExternalGapRegistry({
			version: 1,
			known_gaps: [
				{
					id: "GAP-01",
					symptoms: "symptoms",
					evidence: "evidence",
					root_cause: "root cause",
					decision: "decision",
					resolution: "Phase 14 Multi-CRI",
					current_consequence: "consequence",
					mvp_impact: "BLOCKING",
				},
				{
					id: "GAP-01",
					symptoms: "symptoms",
					evidence: "evidence",
					root_cause: "root cause",
					decision: "decision",
					resolution: "resolution",
					current_consequence: "consequence",
					mvp_impact: "NON_BLOCKING",
				},
			],
		});

		expect(result.valid).toBe(false);
		expect(result.errors.join("; ")).toContain("duplicate gap id GAP-01");
		expect(result.errors.join("; ")).toContain("GAP-01 must be NON_BLOCKING");
	});

	test("reports malformed YAML without accepting partial data", () => {
		const result = parseKnownExternalGapRegistry("version: [broken");

		expect(result.valid).toBe(false);
		expect(result.value).toBeUndefined();
		expect(result.errors[0]).toContain("invalid YAML");
	});

	test("canonical file is the same content used by the loader", () => {
		const source = readFileSync(registryPath, "utf8");
		const parsed = parseKnownExternalGapRegistry(source);

		expect(parsed.valid).toBe(true);
		expect(parsed.value?.known_gaps).toHaveLength(2);
		expect(parsed.value?.known_gaps.find((entry) => entry.id === "GAP-03")?.mvp_impact).toBe("NON_BLOCKING");
	});
});
