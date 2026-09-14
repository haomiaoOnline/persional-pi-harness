import type { CommandRisk } from "./command-risk.ts";

export type LifecycleHookEvent = "on_start" | "pre_tool_use" | "post_tool_use" | "on_cwd_change";
export type DeterministicHookKind = "script" | "static_check";

export interface LifecycleToolContext {
	name: string;
	command: string;
	risk: CommandRisk;
}

export interface LifecycleHookContext {
	task_id: string;
	run_id?: string;
	cwd?: string;
	tool?: LifecycleToolContext;
	code_changed?: boolean;
	changed_files?: readonly string[];
}

export interface LifecycleHookOutcome {
	passed?: boolean;
	detail?: string;
	warning?: string;
	evidence?: readonly string[];
}

export interface DeterministicLifecycleHook {
	id: string;
	event: LifecycleHookEvent;
	kind: DeterministicHookKind;
	run: (context: LifecycleHookContext) => LifecycleHookOutcome | undefined | Promise<LifecycleHookOutcome | undefined>;
}

export interface LifecycleHookRunResult {
	allowed: boolean;
	blocked_tool_call: boolean;
	warnings: string[];
	evidence: string[];
	failures: string[];
}

export interface LifecycleHookManagerOptions {
	hooks?: readonly DeterministicLifecycleHook[];
	reload_scoped_rules?: (cwd: string) => readonly string[];
}

export class LifecycleHookError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LifecycleHookError";
	}
}

function validateHook(hook: DeterministicLifecycleHook): void {
	if (hook.id.length === 0) throw new LifecycleHookError("lifecycle hook id must not be empty");
	if (!(["on_start", "pre_tool_use", "post_tool_use", "on_cwd_change"] as string[]).includes(hook.event)) {
		throw new LifecycleHookError(`unsupported lifecycle hook event: ${hook.event}`);
	}
	if (!(hook.kind === "script" || hook.kind === "static_check")) {
		throw new LifecycleHookError(`only deterministic script/static_check hooks are allowed: ${hook.id}`);
	}
}

/** Hooks are deliberately callback-shaped but their kind is restricted to deterministic work. */
export class LifecycleHookManager {
	private readonly hooks: DeterministicLifecycleHook[] = [];
	private readonly reloadScopedRules?: (cwd: string) => readonly string[];

	constructor(options: LifecycleHookManagerOptions = {}) {
		this.reloadScopedRules = options.reload_scoped_rules;
		for (const hook of options.hooks ?? []) this.register(hook);
	}

	register(hook: DeterministicLifecycleHook): void {
		validateHook(hook);
		if (this.hooks.some((candidate) => candidate.id === hook.id))
			throw new LifecycleHookError(`duplicate lifecycle hook: ${hook.id}`);
		this.hooks.push(hook);
	}

	list(): DeterministicLifecycleHook[] {
		return [...this.hooks];
	}

	async run(event: LifecycleHookEvent, context: LifecycleHookContext): Promise<LifecycleHookRunResult> {
		const warnings: string[] = [];
		const evidence: string[] = [];
		const failures: string[] = [];
		if (event === "pre_tool_use" && !context.tool) {
			return {
				allowed: false,
				blocked_tool_call: true,
				warnings,
				evidence: ["hook:pre_tool_use:missing-tool-risk-context"],
				failures: ["pre_tool_use requires command risk context"],
			};
		}

		if (event === "on_cwd_change" && context.cwd && this.reloadScopedRules) {
			try {
				const rules = this.reloadScopedRules(context.cwd);
				evidence.push(`hook:cwd-reloaded:${rules.length}`);
			} catch (error) {
				failures.push(`cwd-rule-reload: ${error instanceof Error ? error.message : String(error)}`);
				evidence.push("hook:cwd-rule-reload:threw");
			}
		}

		const eventHooks = this.hooks.filter((hook) => hook.event === event);
		if (event === "post_tool_use" && context.code_changed === true && eventHooks.length === 0) {
			warnings.push("post_tool_use static checker is missing; Run continues with warning Evidence");
			evidence.push("hook-checker-missing:post_tool_use");
		}

		for (const hook of eventHooks) {
			try {
				const outcome = await hook.run({
					...context,
					changed_files: context.changed_files ? [...context.changed_files] : undefined,
				});
				if (outcome?.evidence) evidence.push(...outcome.evidence);
				if (outcome?.warning) warnings.push(outcome.warning);
				if (outcome?.passed === false) {
					failures.push(`${hook.id}: ${outcome.detail ?? "deterministic hook failed"}`);
					evidence.push(`hook:${hook.id}:failed`);
				}
			} catch (error) {
				failures.push(`${hook.id}: ${error instanceof Error ? error.message : String(error)}`);
				evidence.push(`hook:${hook.id}:threw`);
			}
		}
		return {
			allowed: failures.length === 0,
			blocked_tool_call: failures.length > 0,
			warnings,
			evidence,
			failures,
		};
	}
}
