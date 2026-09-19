import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ValidationResult } from "./types.ts";

export interface ResourceCeiling {
	max_parallel_workers: number;
	max_memory_mb_per_worker: number;
	max_total_memory_mb: number;
	on_pressure: "degrade_to_serial";
}

export const ResourceCeilingSchema = Type.Object(
	{
		max_parallel_workers: Type.Integer({ minimum: 1 }),
		max_memory_mb_per_worker: Type.Number({ exclusiveMinimum: 0 }),
		max_total_memory_mb: Type.Number({ exclusiveMinimum: 0 }),
		on_pressure: Type.Literal("degrade_to_serial"),
	},
	{ additionalProperties: false },
);

export function validateResourceCeiling(value: unknown): ValidationResult<ResourceCeiling> {
	if (!Value.Check(ResourceCeilingSchema, value))
		return {
			valid: false,
			errors: [...Value.Errors(ResourceCeilingSchema, value)].map((error) => {
				const path = "path" in error && typeof error.path === "string" ? error.path : "/";
				return `${path || "/"}: ${error.message}`;
			}),
		};
	return { valid: true, value: value as ResourceCeiling, errors: [] };
}

export interface WorkerMemoryMonitor {
	workerMemoryMb(pid: number): number | undefined;
}

export class PsWorkerMemoryMonitor implements WorkerMemoryMonitor {
	workerMemoryMb(pid: number): number | undefined {
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		try {
			const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 1_000,
			}).trim();
			const rssKb = Number(output);
			return Number.isFinite(rssKb) && rssKb >= 0 ? rssKb / 1024 : undefined;
		} catch {
			return undefined;
		}
	}
}

export interface ResourceParallelismDecision {
	mode: "parallel" | "serial";
	reason: string;
}

export function evaluateResourceParallelism(input: {
	ceiling: ResourceCeiling;
	requested_workers: number;
	worker_memory_mb: readonly (number | undefined)[];
}): ResourceParallelismDecision {
	const validation = validateResourceCeiling(input.ceiling);
	if (!validation.valid) return { mode: "serial", reason: "resource ceiling is invalid; degrade_to_serial" };
	if (!Number.isInteger(input.requested_workers) || input.requested_workers < 1)
		return { mode: "serial", reason: "requested worker count is invalid; degrade_to_serial" };
	if (input.requested_workers <= 1) return { mode: "serial", reason: "single worker execution" };
	if (input.requested_workers > input.ceiling.max_parallel_workers)
		return { mode: "serial", reason: "max_parallel_workers reached; degrade_to_serial" };
	const selected = input.worker_memory_mb.slice(0, input.requested_workers);
	if (selected.length < input.requested_workers || selected.some((memory) => memory === undefined))
		return { mode: "serial", reason: "memory monitoring unavailable; degrade_to_serial" };
	const measured = selected as number[];
	if (measured.some((memory) => !Number.isFinite(memory) || memory < 0))
		return { mode: "serial", reason: "memory monitoring unavailable; degrade_to_serial" };
	if (measured.some((memory) => memory > input.ceiling.max_memory_mb_per_worker))
		return { mode: "serial", reason: "worker memory pressure; degrade_to_serial" };
	if (measured.reduce((sum, memory) => sum + memory, 0) > input.ceiling.max_total_memory_mb)
		return { mode: "serial", reason: "total memory pressure; degrade_to_serial" };
	return { mode: "parallel", reason: "resource ceiling allows parallel execution" };
}
