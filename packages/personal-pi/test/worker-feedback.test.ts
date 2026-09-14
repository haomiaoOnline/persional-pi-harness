import { describe, expect, test } from "vitest";
import { WorkerSuccessRateTracker } from "../src/index.ts";

describe("T12.5 Worker success-rate feedback", () => {
	test("records worker_id plus task_type counters and can be restored from a snapshot", () => {
		const tracker = new WorkerSuccessRateTracker();
		tracker.record({ worker_id: "worker-a", task_type: "backend", success: true });
		tracker.record({ worker_id: "worker-a", task_type: "backend", success: false });
		tracker.record({ worker_id: "worker-a", task_type: "backend", success: true });

		expect(tracker.rate("worker-a", "backend")).toEqual({
			worker_id: "worker-a",
			task_type: "backend",
			successes: 2,
			failures: 1,
			total: 3,
			rate: 2 / 3,
		});
		expect(new WorkerSuccessRateTracker(tracker.snapshot()).rate("worker-a", "backend")?.rate).toBe(2 / 3);
		expect(tracker.rate("worker-a", "research")).toBeUndefined();
	});
});
