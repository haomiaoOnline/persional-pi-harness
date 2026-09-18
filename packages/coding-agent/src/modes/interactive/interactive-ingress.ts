import type { ImageContent } from "@earendil-works/pi-ai";
import type { AppMode } from "../../core/project-trust.ts";

export interface InteractiveWorkSubmission {
	text: string;
	images?: ImageContent[];
}

export interface InteractiveIngressResult {
	summary?: string;
}

export interface InteractiveWorkerRoute {
	cwd: string;
	command: string;
	command_args_prefix: string[];
	provider?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	active_tools: string[];
}

export interface InteractiveIngressFactoryContext {
	getWorkerRoute(): InteractiveWorkerRoute;
}

export type InteractiveIngressHandler = (submission: InteractiveWorkSubmission) => Promise<InteractiveIngressResult>;

export type InteractiveIngressFactory = (
	context: InteractiveIngressFactoryContext,
) => InteractiveIngressHandler | Promise<InteractiveIngressHandler>;

export async function createInteractiveIngressForMode(
	mode: AppMode,
	factory: InteractiveIngressFactory | undefined,
	context: InteractiveIngressFactoryContext,
): Promise<InteractiveIngressHandler | undefined> {
	if (mode !== "interactive" || !factory) return undefined;
	return await factory(context);
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
