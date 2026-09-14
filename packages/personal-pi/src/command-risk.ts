import { createHash } from "node:crypto";
import { evaluateTaskPermissions } from "./security.ts";
import type { CommandEvidence, TaskContract } from "./types.ts";

export type CommandRisk = "safe" | "risky" | "danger";
export type CommandAction = "auto_run" | "ask_user" | "block";

export interface CommandRiskMatch {
	prefix?: string;
	contains?: string;
	pattern?: string;
}

export interface CommandRiskRule {
	id: string;
	risk: CommandRisk;
	match: CommandRiskMatch;
	reason: string;
}

export interface CommandRiskClassification {
	command: string;
	risk: CommandRisk;
	rule_id: string;
	reason: string;
}

export interface CommandApproval {
	action_digest: string;
	bound_revision: number;
	approved_at?: string;
	expires_at?: string;
}

export interface CommandAuthorization {
	classification: CommandRiskClassification;
	action: CommandAction;
	action_digest: string;
	bound_revision: number;
	reasons: string[];
}

export class CommandRiskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandRiskError";
	}
}

const DEFAULT_RULES: readonly CommandRiskRule[] = [
	{
		id: "danger-destructive-filesystem",
		risk: "danger",
		match: { pattern: "(^|\\s)(rm\\s+-rf|mkfs(?:\\s|$)|dd\\s+if=|shutdown(?:\\s|$)|reboot(?:\\s|$))" },
		reason: "destructive filesystem or host command",
	},
	{
		id: "danger-destructive-git",
		risk: "danger",
		match: {
			pattern:
				"(^|\\s)git\\s+(reset\\s+--hard|clean\\s+(?:-[a-z]*f|--force)(?:\\s|$)|push\\b[^\\n]*--force(?:-with-lease)?(?:\\s|$))",
		},
		reason: "destructive or forceful git operation",
	},
	{
		id: "danger-pipe-to-shell",
		risk: "danger",
		match: { pattern: "\\|\\s*(sh|bash|zsh)(?:\\s|$)" },
		reason: "unreviewed remote content is piped into a shell",
	},
	{
		id: "risky-publish",
		risk: "risky",
		match: { pattern: "^(npm|pnpm)\\s+publish(?:\\s|$)" },
		reason: "publishes a package",
	},
	{ id: "risky-git-write", risk: "risky", match: { prefix: "git commit" }, reason: "changes repository history" },
	{ id: "risky-git-push", risk: "risky", match: { prefix: "git push" }, reason: "writes to a remote repository" },
	{
		id: "risky-package-install",
		risk: "risky",
		match: { pattern: "^(npm|pnpm)\\s+(install|ci)(?:\\s|$)" },
		reason: "changes installed dependencies",
	},
	{
		id: "risky-filesystem-write",
		risk: "risky",
		match: { pattern: "^(cp|mv|mkdir|touch|chmod|chown)(?:\\s|$)" },
		reason: "changes filesystem state",
	},
	{
		id: "safe-inspection",
		risk: "safe",
		match: { pattern: "^(cat|diff|fd|find|grep|head|ls|pwd|rg|sed|tail|which)(?:\\s|$)" },
		reason: "read-only inspection command",
	},
	{
		id: "safe-git-inspection",
		risk: "safe",
		match: { pattern: "^git\\s+(diff|log|show|status)(?:\\s|$)" },
		reason: "read-only git inspection",
	},
	{
		id: "safe-test-check",
		risk: "safe",
		match: { pattern: "^(node --test|npm run (check|test)|npm exec)(?:\\s|$)" },
		reason: "declared verification/check command",
	},
];

const RISK_ORDER: readonly CommandRisk[] = ["danger", "risky", "safe"];

function matches(rule: CommandRiskRule, command: string): boolean {
	const match = rule.match;
	if (match.prefix && (command === match.prefix || command.startsWith(`${match.prefix} `))) return true;
	if (match.contains && command.includes(match.contains)) return true;
	if (match.pattern) {
		try {
			return new RegExp(match.pattern).test(command);
		} catch {
			throw new CommandRiskError(`invalid command risk rule pattern: ${rule.id}`);
		}
	}
	return false;
}

export class CommandRiskClassifier {
	private readonly rules: readonly CommandRiskRule[];

	constructor(rules: readonly CommandRiskRule[] = DEFAULT_RULES) {
		const ids = new Set<string>();
		for (const rule of rules) {
			if (rule.id.length === 0 || rule.reason.length === 0)
				throw new CommandRiskError("command risk rule is incomplete");
			if (ids.has(rule.id)) throw new CommandRiskError(`duplicate command risk rule: ${rule.id}`);
			ids.add(rule.id);
		}
		this.rules = [...rules];
	}

	listRules(): CommandRiskRule[] {
		return this.rules.map((rule) => ({ ...rule, match: { ...rule.match } }));
	}

	classify(command: string): CommandRiskClassification {
		if (command.trim().length === 0) throw new CommandRiskError("command must not be empty");
		for (const risk of RISK_ORDER) {
			const rule = this.rules.find((candidate) => candidate.risk === risk && matches(candidate, command));
			if (rule) return { command, risk, rule_id: rule.id, reason: rule.reason };
		}
		return {
			command,
			risk: "risky",
			rule_id: "default-unknown-command",
			reason: "unknown commands require user approval",
		};
	}
}

export function commandActionDigest(task: Pick<TaskContract, "id" | "task_revision">, command: string): string {
	return createHash("sha256")
		.update(JSON.stringify({ task_id: task.id, task_revision: task.task_revision, command }))
		.digest("hex");
}

function approvalMatches(
	approval: CommandApproval | undefined,
	actionDigest: string,
	taskRevision: number,
	now: string,
): boolean {
	if (!approval || approval.action_digest !== actionDigest || approval.bound_revision !== taskRevision) return false;
	if (!approval.expires_at) return true;
	const expiry = Date.parse(approval.expires_at);
	return Number.isFinite(expiry) && expiry >= Date.parse(now);
}

export function authorizeCommand(
	task: TaskContract,
	command: string,
	classifier = new CommandRiskClassifier(),
	options: { approval?: CommandApproval; now?: string } = {},
): CommandAuthorization {
	const classification = classifier.classify(command);
	const actionDigest = commandActionDigest(task, command);
	const boundRevision = task.task_revision;
	const permission = evaluateTaskPermissions(task, { shell: [command] });
	if (!permission.allowed) {
		return {
			classification,
			action: "block",
			action_digest: actionDigest,
			bound_revision: boundRevision,
			reasons: permission.reasons,
		};
	}
	if (classification.risk === "danger") {
		return {
			classification,
			action: "block",
			action_digest: actionDigest,
			bound_revision: boundRevision,
			reasons: [`danger command is permanently blocked: ${classification.reason}`],
		};
	}
	if (classification.risk === "safe") {
		return {
			classification,
			action: "auto_run",
			action_digest: actionDigest,
			bound_revision: boundRevision,
			reasons: [classification.reason],
		};
	}
	const now = options.now ?? new Date().toISOString();
	const approved = approvalMatches(options.approval, actionDigest, boundRevision, now);
	return {
		classification,
		action: approved ? "auto_run" : "ask_user",
		action_digest: actionDigest,
		bound_revision: boundRevision,
		reasons: approved
			? ["risky command has a revision-bound approval"]
			: [`user approval required: ${classification.reason}`],
	};
}

export async function runAuthorizedCommand(
	authorization: CommandAuthorization,
	runner: (command: string) => Promise<CommandEvidence> | CommandEvidence,
): Promise<CommandEvidence> {
	if (authorization.action !== "auto_run") {
		throw new CommandRiskError(`${authorization.action}: ${authorization.reasons.join("; ")}`);
	}
	return runner(authorization.classification.command);
}
