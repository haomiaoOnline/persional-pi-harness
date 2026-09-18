export const SESSION_HARD_MAX_TOOL_CALLS = 60;
export const SESSION_HARD_MAX_ELAPSED_MS = 45 * 60 * 1000;

export interface SessionHardLimitDecision {
	allowed: boolean;
	reason?: string;
}

/**
 * Last-resort execution limits for an interactive coding-agent session.
 *
 * These limits intentionally do not depend on Personal PI Pipeline state or
 * configuration. They remain active when the governed ingress path is absent
 * or broken, which is the failure mode they exist to contain.
 */
export class SessionHardLimits {
	private toolCallCount = 0;
	private readonly startedAt: number;
	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
		this.startedAt = now();
	}

	checkBeforeToolCall(): SessionHardLimitDecision {
		this.toolCallCount += 1;
		if (this.toolCallCount > SESSION_HARD_MAX_TOOL_CALLS) {
			return {
				allowed: false,
				reason: `Session hard limit reached: more than ${SESSION_HARD_MAX_TOOL_CALLS} tool calls. Continue through a governed PPH Task instead.`,
			};
		}

		if (this.now() - this.startedAt > SESSION_HARD_MAX_ELAPSED_MS) {
			return {
				allowed: false,
				reason:
					"Session hard limit reached: more than 45 minutes elapsed. Continue through a governed PPH Task instead.",
			};
		}

		return { allowed: true };
	}
}
