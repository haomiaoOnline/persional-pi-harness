import { describe, expect, test } from "vitest";
import { ProviderResilienceController } from "../src/index.ts";

function register(controller: ProviderResilienceController, providerId: string, overrides = {}) {
	controller.register({
		provider_id: providerId,
		rate_limit: { max_requests: 10, interval_ms: 1000 },
		failure_threshold: 2,
		cooldown_ms: 1000,
		...overrides,
	});
}

describe("T12.6 Provider Quota / Backpressure / Circuit Breaker", () => {
	test("queues rate-limited work and reports quota remaining", () => {
		const controller = new ProviderResilienceController();
		register(controller, "primary", { rate_limit: { max_requests: 1, interval_ms: 1000 }, quota_limit: 2 });

		expect(controller.admit("primary", { at: 1_000 }).action).toBe("ALLOW");
		expect(controller.enqueue("request-2", "primary", { at: 1_000 }).action).toBe("QUEUE");
		expect(controller.status("primary").quota_remaining).toBe(1);
		expect(controller.drain(2_100)).toHaveLength(1);
		expect(controller.status("primary").quota_remaining).toBe(0);
		expect(controller.enqueue("request-3", "primary", { at: 2_100 }).action).toBe("QUEUE");
		expect(controller.queueDepth()).toBe(1);
	});

	test("opens after consecutive 429/500 failures, falls back, and recovers after cooldown", () => {
		const controller = new ProviderResilienceController();
		register(controller, "primary");
		register(controller, "backup");

		expect(controller.admit("primary", { at: 1_000 }).action).toBe("ALLOW");
		controller.recordResponse("primary", 429, 1_001);
		expect(controller.admit("primary", { at: 1_002 }).action).toBe("QUEUE");
		expect(controller.admit("primary", { at: 2_002 }).action).toBe("ALLOW");
		controller.recordResponse("primary", 500, 2_003);
		expect(controller.status("primary").state).toBe("OPEN");

		const fallback = controller.admit("primary", { fallback_provider_id: "backup", at: 2_100 });
		expect(fallback.action).toBe("FALLBACK");
		expect(fallback.provider_id).toBe("backup");
		expect(fallback.fallback_from).toBe("primary");

		const probe = controller.admit("primary", { at: 4_004 });
		expect(probe.action).toBe("ALLOW");
		expect(controller.status("primary").state).toBe("HALF_OPEN");
		controller.recordResponse("primary", 200, 4_005);
		expect(controller.status("primary").state).toBe("CLOSED");
	});

	test("keeps blocked requests queued until a provider or fallback becomes available", () => {
		const controller = new ProviderResilienceController();
		register(controller, "primary", { failure_threshold: 1, cooldown_ms: 500 });
		controller.admit("primary", { at: 1_000 });
		controller.recordResponse("primary", 500, 1_001);
		const queued = controller.enqueue("queued-request", "primary", { at: 1_100 });
		expect(queued.action).toBe("QUEUE");
		expect(controller.drain(1_200)).toEqual([]);
		expect(controller.drain(2_100)).toHaveLength(1);
	});
});
