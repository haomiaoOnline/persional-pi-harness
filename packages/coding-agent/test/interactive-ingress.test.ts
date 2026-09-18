import { describe, expect, test, vi } from "vitest";
import {
	createInteractiveIngressForMode,
	governedInteractiveBusyReason,
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
});
