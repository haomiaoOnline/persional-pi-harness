import { accessSync, constants } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AppMode } from "../../core/project-trust.ts";

export interface InteractiveWorkSubmission {
	text: string;
	images?: ImageContent[];
}

export interface InteractiveIngressResult {
	summary?: string;
}

export interface InteractiveExecutionSurfaceIdentity {
	pph_commit: string;
	bundle_sha256: string;
}

export interface InteractiveWorkerStatus {
	worker_capability: "available" | "unavailable";
	execution_mode: "normal" | "root_only" | "degraded";
	delivery_status: "normal" | "degraded";
}

export interface InteractiveWorkerRoute {
	cwd: string;
	command: string;
	command_args_prefix: string[];
	provider?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	active_tools: string[];
	worker_status: InteractiveWorkerStatus;
}

export interface InteractiveIngressFactoryContext {
	getWorkerRoute(): InteractiveWorkerRoute;
	/** Persist audit-only execution metadata outside LLM context. */
	recordExecutionSurface?(metadata: Readonly<Record<string, unknown>>): void;
}

export type InteractiveIngressHandler = (submission: InteractiveWorkSubmission) => Promise<InteractiveIngressResult>;

export type InteractiveIngressFactory = (
	context: InteractiveIngressFactoryContext,
) => InteractiveIngressHandler | Promise<InteractiveIngressHandler>;

export function probeLocalInteractiveWorkerStatus(
	command: string,
	commandArgsPrefix: readonly string[],
): InteractiveWorkerStatus {
	try {
		const cliEntry = commandArgsPrefix[0];
		if (!command || !cliEntry) throw new Error("worker route is incomplete");
		accessSync(command, constants.X_OK);
		accessSync(cliEntry, constants.R_OK);
		return { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" };
	} catch {
		return { worker_capability: "unavailable", execution_mode: "root_only", delivery_status: "degraded" };
	}
}

export async function createInteractiveIngressForMode(
	mode: AppMode,
	factory: InteractiveIngressFactory | undefined,
	context: InteractiveIngressFactoryContext,
): Promise<InteractiveIngressHandler | undefined> {
	if (mode !== "interactive" || !factory) return undefined;
	return await factory(context);
}

export function enforceInteractiveIngressBinding(
	handler: InteractiveIngressHandler | undefined,
	options: {
		required: boolean;
		execution_surface?: InteractiveExecutionSurfaceIdentity;
		recordExecutionSurface?(metadata: Readonly<Record<string, unknown>>): void;
	},
): InteractiveIngressHandler | undefined {
	if (handler || !options.required) return handler;
	options.recordExecutionSurface?.({
		entrypoint: "interactive",
		pph_commit: options.execution_surface?.pph_commit ?? "unknown",
		bundle_sha256: options.execution_surface?.bundle_sha256 ?? "unknown",
		ingress_bound: false,
		pipeline_bound: false,
		scheduler_enabled: false,
		scheduler_kind: "direct",
	});
	return async () => {
		throw new Error("governed interactive ingress is required but not bound");
	};
}

export function governedInteractiveBusyReason(
	handler: InteractiveIngressHandler | undefined,
	state: { isCompacting: boolean; isStreaming: boolean },
): string | undefined {
	if (!handler) return undefined;
	if (state.isCompacting) return "Governed interactive work is blocked while compaction is in progress";
	if (state.isStreaming) return "Governed interactive work is blocked while a worker turn is in progress";
	return undefined;
}

export async function routeInteractiveSubmission(
	handler: InteractiveIngressHandler | undefined,
	submission: InteractiveWorkSubmission,
	fallback: (submission: InteractiveWorkSubmission) => Promise<InteractiveIngressResult>,
): Promise<InteractiveIngressResult> {
	if (handler) {
		return await handler(submission);
	}
	return await fallback(submission);
}
