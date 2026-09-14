import { evaluateTaskPermissions, type PermissionDecision } from "./security.ts";
import type { PermissionRequest, TaskContract } from "./types.ts";

export type PermissionPhase = "exploring" | "planning" | "acting";

const PHASE_ORDER: Record<PermissionPhase, number> = {
	exploring: 0,
	planning: 1,
	acting: 2,
};

const DEFAULT_READ_ONLY_SHELL = [
	"cat",
	"diff",
	"fd",
	"find",
	"git diff",
	"git log",
	"git show",
	"git status",
	"grep",
	"head",
	"ls",
	"pwd",
	"rg",
	"sed",
	"tail",
	"type",
	"which",
];

const DEFAULT_READ_ONLY_GIT = ["diff", "log", "show", "status"];

export interface PermissionPhaseOptions {
	simple_task?: boolean;
	read_only_shell_prefixes?: readonly string[];
	read_only_git_actions?: readonly string[];
}

export interface PhasedPermissionDecision extends PermissionDecision {
	phase: PermissionPhase;
	/** 非 acting 阶段的写请求可以在推进阶段后由调用方重试。 */
	retryable_after_phase_advance: boolean;
}

export class PermissionPhaseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermissionPhaseError";
	}
}

function matchesPrefix(value: string, prefixes: readonly string[]): boolean {
	const normalized = value.trim();
	// Shell composition or redirection can turn a read-looking prefix into a write
	// or execution path, so Explore/Plan never treats it as read-only.
	if (/[;&|><`$()\\\n\r]/.test(normalized)) return false;
	return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function emptyGranted(): PermissionDecision["granted"] {
	return { filesystem: { read: [], write: [] }, shell: [], network: false, git: [], credentials: false };
}

function phaseDenied(phase: PermissionPhase, reasons: string[]): PhasedPermissionDecision {
	return {
		allowed: false,
		reasons,
		granted: emptyGranted(),
		phase,
		retryable_after_phase_advance: phase !== "acting",
	};
}

/**
 * Run 内的权限只允许单向升级。Explore/Plan 对未知 shell 命令也按写操作
 * 处理，避免把“读命令”交给模糊判断；Act 仍然不能超过 Task Contract。
 */
export class PhasedPermissionController {
	private readonly task: TaskContract;
	private readonly readOnlyShellPrefixes: readonly string[];
	private readonly readOnlyGitActions: readonly string[];
	private currentPhase: PermissionPhase;

	constructor(task: TaskContract, options: PermissionPhaseOptions = {}) {
		this.task = task;
		this.readOnlyShellPrefixes = options.read_only_shell_prefixes ?? DEFAULT_READ_ONLY_SHELL;
		this.readOnlyGitActions = options.read_only_git_actions ?? DEFAULT_READ_ONLY_GIT;
		this.currentPhase = options.simple_task ? "acting" : "exploring";
	}

	phase(): PermissionPhase {
		return this.currentPhase;
	}

	advanceTo(next: PermissionPhase): PermissionPhase {
		if (PHASE_ORDER[next] < PHASE_ORDER[this.currentPhase]) {
			throw new PermissionPhaseError(`permission phase cannot move backwards: ${this.currentPhase} -> ${next}`);
		}
		if (PHASE_ORDER[next] > PHASE_ORDER[this.currentPhase] + 1) {
			throw new PermissionPhaseError(
				`permission phase must advance one step at a time: ${this.currentPhase} -> ${next}`,
			);
		}
		this.currentPhase = next;
		return this.currentPhase;
	}

	request(request: PermissionRequest = {}): PhasedPermissionDecision {
		if (this.currentPhase !== "acting") {
			const reasons: string[] = [];
			if ((request.filesystem?.write?.length ?? 0) > 0)
				reasons.push(`${this.currentPhase} phase is read-only; filesystem write requires acting`);
			if ((request.network ?? false) === true)
				reasons.push(`${this.currentPhase} phase is read-only; network access requires acting`);
			if ((request.credentials ?? false) === true)
				reasons.push(`${this.currentPhase} phase is read-only; credential access requires acting`);
			const mutatingShell = (request.shell ?? []).filter(
				(command) => !matchesPrefix(command, this.readOnlyShellPrefixes),
			);
			if (mutatingShell.length > 0)
				reasons.push(`${this.currentPhase} phase is read-only; shell command requires acting: ${mutatingShell[0]}`);
			const mutatingGit = (request.git ?? []).filter((action) => !matchesPrefix(action, this.readOnlyGitActions));
			if (mutatingGit.length > 0)
				reasons.push(`${this.currentPhase} phase is read-only; git action requires acting: ${mutatingGit[0]}`);
			if (reasons.length > 0) return phaseDenied(this.currentPhase, reasons);
		}

		const decision = evaluateTaskPermissions(this.task, request);
		return {
			...decision,
			phase: this.currentPhase,
			retryable_after_phase_advance: false,
		};
	}
}
