import { describe, expect, test, vi } from "vitest";
import {
	createInteractiveIngressForMode,
	enforceInteractiveIngressBinding,
	governedInteractiveBusyReason,
	probeLocalInteractiveWorkerStatus,
	routeInteractiveSubmission,
} from "../src/modes/interactive/interactive-ingress.ts";

describe("T7.0 interactive ingress routing", () => {
	const workerRoute = {
		cwd: "/tmp/pph-mode-separation",
		command: process.execPath,
		command_args_prefix: ["cli.js"],
		provider: "test-provider",
		model: "test-model",
		active_tools: ["read"],
		worker_status: {
			worker_capability: "available" as const,
			execution_mode: "normal" as const,
			delivery_status: "normal" as const,
		},
	};

	test("routes governed top-level work through ingress without raw prompt fallback", async () => {
		const fallback = vi.fn(async () => ({ summary: "raw" }));
		const handler = vi.fn(async () => ({}));
		await routeInteractiveSubmission(handler, { text: "govern this" }, fallback);
		expect(handler).toHaveBeenCalledOnce();
		expect(fallback).not.toHaveBeenCalled();
	});

	test("fails closed when ingress throws and never falls back to the raw session prompt", async () => {
		const fallback = vi.fn(async () => ({ summary: "raw" }));
		const handler = vi.fn(async () => {
			throw new Error("ingress blocked");
		});
		await expect(routeInteractiveSubmission(handler, { text: "blocked" }, fallback)).rejects.toThrow(
			"ingress blocked",
		);
		expect(fallback).not.toHaveBeenCalled();
	});

	test("preserves legacy raw prompt behavior when no ingress is configured", async () => {
		const fallback = vi.fn(async () => ({ summary: "raw" }));
		await routeInteractiveSubmission(undefined, { text: "legacy" }, fallback);
		expect(fallback).toHaveBeenCalledOnce();
	});

	test("fails closed and records an unbound execution surface when governed ingress is required", async () => {
		const fallback = vi.fn(async () => ({ summary: "raw" }));
		const recordExecutionSurface = vi.fn();
		const handler = enforceInteractiveIngressBinding(undefined, {
			required: true,
			execution_surface: { pph_commit: "commit-fixture", bundle_sha256: "bundle-fixture" },
			recordExecutionSurface,
		});

		await expect(routeInteractiveSubmission(handler, { text: "must be governed" }, fallback)).rejects.toThrow(
			"governed interactive ingress is required but not bound",
		);
		expect(fallback).not.toHaveBeenCalled();
		expect(recordExecutionSurface).toHaveBeenCalledWith({
			entrypoint: "interactive",
			pph_commit: "commit-fixture",
			bundle_sha256: "bundle-fixture",
			ingress_bound: false,
			pipeline_bound: false,
			scheduler_enabled: false,
			scheduler_kind: "direct",
		});
	});

	test.each(["print", "json", "rpc"] as const)("does not construct interactive ingress in %s mode", async (mode) => {
		const factory = vi.fn(async () => vi.fn(async () => ({})));
		const context = { getWorkerRoute: vi.fn(() => workerRoute) };

		expect(await createInteractiveIngressForMode(mode, factory, context)).toBeUndefined();
		expect(factory).not.toHaveBeenCalled();
		expect(context.getWorkerRoute).not.toHaveBeenCalled();
	});

	test("constructs interactive ingress only in interactive mode", async () => {
		const handler = vi.fn(async () => ({}));
		const factory = vi.fn(async () => handler);
		const context = { getWorkerRoute: vi.fn(() => workerRoute) };

		expect(await createInteractiveIngressForMode("interactive", factory, context)).toBe(handler);
		expect(factory).toHaveBeenCalledOnce();
		expect(factory).toHaveBeenCalledWith(context);
	});

	test("blocks governed work-bearing submissions while streaming or compacting", () => {
		const handler = async () => ({});
		expect(governedInteractiveBusyReason(handler, { isCompacting: true, isStreaming: false })).toContain(
			"compaction",
		);
		expect(governedInteractiveBusyReason(handler, { isCompacting: false, isStreaming: true })).toContain(
			"worker turn",
		);
		expect(governedInteractiveBusyReason(handler, { isCompacting: false, isStreaming: false })).toBeUndefined();
		expect(governedInteractiveBusyReason(undefined, { isCompacting: true, isStreaming: true })).toBeUndefined();
	});

	test("derives availability from the local child command and CLI entry instead of assuming it", () => {
		expect(probeLocalInteractiveWorkerStatus(process.execPath, [process.argv[1] ?? ""])).toEqual({
			worker_capability: "available",
			execution_mode: "normal",
			delivery_status: "normal",
		});
		expect(probeLocalInteractiveWorkerStatus(process.execPath, ["/definitely/missing/pph-cli.js"])).toEqual({
			worker_capability: "unavailable",
			execution_mode: "root_only",
			delivery_status: "degraded",
		});
	});
});
