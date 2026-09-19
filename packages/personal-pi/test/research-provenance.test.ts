import { describe, expect, test } from "vitest";
import { EvidenceCollector, validateSourceProvenance } from "../src/index.ts";

describe("T4.1-B research source provenance", () => {
	test("preserves conflicting sourced facts instead of collapsing them", () => {
		const collector = new EvidenceCollector();
		const evidence = collector.collect({
			task_id: "research-facts",
			run_id: "run-research-facts",
			source_provenance: [
				{
					source_ref: "official:metric-a",
					source_type: "official",
					observed_at: "2026-09-19T00:00:00.000Z",
					metric: "monthly_active_users",
					value: 100,
					unit: "million_users",
					period: "2026-08",
					confidence: 0.95,
				},
				{
					source_ref: "third-party:metric-a",
					source_type: "third_party",
					observed_at: "2026-09-19T00:00:00.000Z",
					metric: "monthly_active_users",
					value: 92,
					unit: "million_users",
					period: "2026-08",
					confidence: 0.7,
				},
			],
		});
		expect(evidence.source_provenance).toHaveLength(2);
		expect(evidence.source_provenance?.map((item) => item.value)).toEqual([100, 92]);
	});

	test("requires a formula or input Evidence refs for derived facts", () => {
		const invalid = {
			source_ref: "derived:cost",
			source_type: "derived",
			observed_at: "2026-09-19T00:00:00.000Z",
			metric: "monthly_cost",
			value: 42,
			confidence: 0.8,
		};
		expect(validateSourceProvenance(invalid)).toMatchObject({ valid: false });
		expect(validateSourceProvenance({ ...invalid, formula_ref: "daily_tokens * token_price * 30" })).toMatchObject({
			valid: true,
			errors: [],
		});
	});
});
