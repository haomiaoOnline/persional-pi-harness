import type { ReadinessEvaluation, TaskContract, ValidationResult } from "./types.ts";

export type ToolOrigin = "builtin" | "extension" | "mcp" | "remote";

export interface ToolDescriptor {
	id: string;
	purpose: string;
	capability_tags: string[];
	origin: ToolOrigin;
	fallback_only?: boolean;
}

export interface ToolExposureOptions {
	simple_task?: boolean;
	include_bash_fallback?: boolean;
}

export interface ToolExposure {
	tools: ToolDescriptor[];
	default_builtin_count: number;
	matched_extension_count: number;
	remote_tools_last: boolean;
	registry_hidden_for_simple_task: boolean;
	reasons: string[];
}

export interface BashReplacementMeasurement {
	sample_size: number;
	replaceable_count: number;
	replaceable_rate: number;
	replaceable_commands: string[];
}

export interface ToolReviewResult {
	passed: boolean;
	checks: Record<string, boolean>;
	reasons: string[];
}

export interface HandoffReadyNotice {
	kind: "HANDOFF_READY";
	handoff_id: string;
	task_id: string;
	artifact_digest: string;
	producer_task_revision: number;
}

export type WorkerNotice = HandoffReadyNotice;

export interface ControllerWakeupHandlers {
	read_persistent_state: (taskId: string) => unknown;
	check_artifact_readiness: (input: {
		task_id: string;
		artifact_digest: string;
		producer_task_revision: number;
	}) => ReadinessEvaluation;
}

export interface WorkerNoticeHandling {
	accepted: boolean;
	wake_controller: boolean;
	state_rechecked: boolean;
	artifact_rechecked: boolean;
	artifact_ready: boolean;
	reasons: string[];
}

const DEFAULT_BUILTIN_TOOLS: readonly ToolDescriptor[] = [
	{ id: "Read", purpose: "read a bounded file or artifact", capability_tags: ["read"], origin: "builtin" },
	{ id: "Edit", purpose: "edit a bounded file", capability_tags: ["write"], origin: "builtin" },
	{ id: "Grep", purpose: "search text in bounded sources", capability_tags: ["search", "read"], origin: "builtin" },
	{ id: "Glob", purpose: "find paths by a bounded pattern", capability_tags: ["search", "read"], origin: "builtin" },
	{ id: "Find", purpose: "inspect a bounded directory tree", capability_tags: ["search", "read"], origin: "builtin" },
	{ id: "List", purpose: "list a bounded directory", capability_tags: ["read"], origin: "builtin" },
	{ id: "ApplyPatch", purpose: "apply a reviewable patch", capability_tags: ["write"], origin: "builtin" },
	{ id: "RunTests", purpose: "run a declared test target", capability_tags: ["test"], origin: "builtin" },
	{ id: "InspectDiff", purpose: "inspect the current diff", capability_tags: ["review", "read"], origin: "builtin" },
];

const BASH_FALLBACK: ToolDescriptor = {
	id: "Bash",
	purpose: "fallback shell execution when no narrow tool is equivalent",
	capability_tags: ["shell"],
	origin: "builtin",
	fallback_only: true,
};

function originRank(origin: ToolOrigin): number {
	return origin === "builtin" ? 0 : origin === "extension" ? 1 : origin === "mcp" ? 2 : 3;
}

function matchesCapability(tool: ToolDescriptor, task: TaskContract): boolean {
	const tags = new Set(task.execution.capability_tags);
	return tool.capability_tags.some((tag) => tags.has(tag));
}

function cloneTool(tool: ToolDescriptor): ToolDescriptor {
	return { ...tool, capability_tags: [...tool.capability_tags] };
}

export const DEFAULT_BUILTIN_TOOL_SET: readonly ToolDescriptor[] = DEFAULT_BUILTIN_TOOLS.map(cloneTool);

export class ProgressiveToolExpander {
	private readonly extensions: readonly ToolDescriptor[];

	constructor(extensions: readonly ToolDescriptor[] = []) {
		const ids = new Set<string>();
		for (const tool of [...DEFAULT_BUILTIN_TOOLS, ...extensions, BASH_FALLBACK]) {
			if (tool.id.length === 0 || tool.purpose.length === 0) throw new Error("tool id and purpose are required");
			if (ids.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
			ids.add(tool.id);
			if (!(["builtin", "extension", "mcp", "remote"] as string[]).includes(tool.origin))
				throw new Error(`unsupported tool origin: ${tool.origin}`);
		}
		this.extensions = extensions.map(cloneTool);
	}

	expose(task: TaskContract, options: ToolExposureOptions = {}): ToolExposure {
		const simple = options.simple_task === true;
		const builtins = DEFAULT_BUILTIN_TOOLS.map(cloneTool);
		const matchedExtensions = simple
			? []
			: this.extensions.filter((tool) => matchesCapability(tool, task)).map(cloneTool);
		const matched = [...matchedExtensions];
		const dedicated = matched.some((tool) => tool.id !== "Bash" && !tool.fallback_only);
		if (options.include_bash_fallback === true && !dedicated) matched.push(cloneTool(BASH_FALLBACK));
		const tools = [...builtins, ...matched].sort((left, right) => originRank(left.origin) - originRank(right.origin));
		return {
			tools,
			default_builtin_count: builtins.length,
			matched_extension_count: matchedExtensions.length,
			remote_tools_last: tools.every(
				(tool, index) =>
					tool.origin !== "remote" || tools.slice(index).every((candidate) => candidate.origin === "remote"),
			),
			registry_hidden_for_simple_task: simple && this.extensions.length > 0,
			reasons: simple
				? ["simple task receives only the narrow built-in set"]
				: ["extension/MCP/remote tools require a matching capability tag; remote tools are last"],
		};
	}

	listRegistry(): ToolDescriptor[] {
		return this.extensions.map(cloneTool);
	}
}

function commandHasNarrowEquivalent(command: string): boolean {
	const normalized = command.trim();
	return /^(cat|head|tail|sed|ls|pwd)(?:\s|$)/.test(normalized) || /^(rg|grep|find|fd)(?:\s|$)/.test(normalized);
}

export function measureBashReplacement(commands: readonly string[]): BashReplacementMeasurement {
	const replaceableCommands = commands.filter(commandHasNarrowEquivalent);
	return {
		sample_size: commands.length,
		replaceable_count: replaceableCommands.length,
		replaceable_rate: commands.length === 0 ? 0 : replaceableCommands.length / commands.length,
		replaceable_commands: [...replaceableCommands],
	};
}

export function reviewToolDesign(tools: readonly ToolDescriptor[]): ToolReviewResult {
	const reasons: string[] = [];
	const checks = {
		default_under_twenty: DEFAULT_BUILTIN_TOOLS.length < 20,
		unique_ids: new Set(tools.map((tool) => tool.id)).size === tools.length,
		narrow_purpose: tools.every((tool) => tool.purpose.length > 0 && !/\band\b/i.test(tool.purpose)),
		remote_last: tools.every(
			(tool, index) =>
				tool.origin !== "remote" || tools.slice(index).every((candidate) => candidate.origin === "remote"),
		),
		bash_is_fallback_only: tools.filter((tool) => tool.id === "Bash").every((tool) => tool.fallback_only === true),
	};
	for (const [check, passed] of Object.entries(checks)) if (!passed) reasons.push(`tool review failed: ${check}`);
	return { passed: reasons.length === 0, checks, reasons };
}

export function validateWorkerNotice(value: unknown): ValidationResult<WorkerNotice> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { valid: false, errors: ["/: notice must be an object"] };
	const candidate = value as Record<string, unknown>;
	const allowed = new Set(["kind", "handoff_id", "task_id", "artifact_digest", "producer_task_revision"]);
	const errors = Object.keys(candidate)
		.filter((key) => !allowed.has(key))
		.map((key) => `/${key}: unsupported notice field`);
	if (candidate.kind !== "HANDOFF_READY") errors.push("/kind: only HANDOFF_READY is allowed");
	for (const key of ["handoff_id", "task_id", "artifact_digest"])
		if (typeof candidate[key] !== "string" || candidate[key].length === 0)
			errors.push(`/${key}: must be a non-empty string`);
	if (!Number.isInteger(candidate.producer_task_revision) || (candidate.producer_task_revision as number) < 1)
		errors.push("/producer_task_revision: must be a positive integer");
	return errors.length > 0
		? { valid: false, errors }
		: { valid: true, value: candidate as unknown as WorkerNotice, errors: [] };
}

/** 只返回 Controller 重新读取后的 readiness 结果，不把消息当成状态真相。 */
export function handleWorkerNotice(notice: unknown, handlers: ControllerWakeupHandlers): WorkerNoticeHandling {
	const validation = validateWorkerNotice(notice);
	if (!validation.valid || !validation.value) {
		return {
			accepted: false,
			wake_controller: false,
			state_rechecked: false,
			artifact_rechecked: false,
			artifact_ready: false,
			reasons: validation.errors,
		};
	}
	const value = validation.value;
	let stateRechecked = false;
	try {
		handlers.read_persistent_state(value.task_id);
		stateRechecked = true;
		const readiness = handlers.check_artifact_readiness({
			task_id: value.task_id,
			artifact_digest: value.artifact_digest,
			producer_task_revision: value.producer_task_revision,
		});
		return {
			accepted: true,
			wake_controller: true,
			state_rechecked: true,
			artifact_rechecked: true,
			artifact_ready: readiness.ready,
			reasons: [...readiness.reasons],
		};
	} catch (error) {
		return {
			accepted: true,
			wake_controller: true,
			state_rechecked: stateRechecked,
			artifact_rechecked: false,
			artifact_ready: false,
			reasons: [error instanceof Error ? error.message : String(error)],
		};
	}
}
