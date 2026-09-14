import { describe, expect, test } from "vitest";
import { authorizeCommand, CommandRiskClassifier, commandActionDigest, runAuthorizedCommand } from "../src/index.ts";
import { makeV3Task } from "./v3-fixtures.ts";

function task() {
	return makeV3Task("command-risk", {
		permissions: {
			filesystem: { read: ["."], write: ["tmp"] },
			shell: { allowed: ["git status", "git push", "rm -rf"] },
			network: "deny",
			credentials: "deny",
		},
	});
}

describe("T10.4 command risk classification", () => {
	test("classifies safe, risky and danger declarative rules", () => {
		const classifier = new CommandRiskClassifier();
		expect(classifier.classify("git status").risk).toBe("safe");
		expect(classifier.classify("git push origin feature").risk).toBe("risky");
		expect(classifier.classify("rm -rf tmp").risk).toBe("danger");
	});

	test("checks Task shell whitelist before allowing a safe command", () => {
		const result = authorizeCommand(task(), "git diff");
		expect(result.action).toBe("block");
		expect(result.reasons.join(" ")).toContain("outside scope");
	});

	test("asks for approval for risky commands and accepts only digest/revision-bound approval", () => {
		const contract = task();
		const pending = authorizeCommand(contract, "git push origin feature");
		expect(pending.action).toBe("ask_user");
		const approved = authorizeCommand(contract, "git push origin feature", new CommandRiskClassifier(), {
			approval: {
				action_digest: commandActionDigest(contract, "git push origin feature"),
				bound_revision: contract.task_revision,
				expires_at: "2999-01-01T00:00:00.000Z",
			},
			now: "2026-09-15T00:00:00.000Z",
		});
		expect(approved.action).toBe("auto_run");
		const stale = authorizeCommand(
			{ ...contract, task_revision: 2 },
			"git push origin feature",
			new CommandRiskClassifier(),
			{
				approval: {
					action_digest: pending.action_digest,
					bound_revision: contract.task_revision,
				},
			},
		);
		expect(stale.action).toBe("ask_user");
	});

	test("permanently blocks danger even when Task permission and an approval exist", () => {
		const contract = task();
		const result = authorizeCommand(contract, "rm -rf tmp", new CommandRiskClassifier(), {
			approval: {
				action_digest: commandActionDigest(contract, "rm -rf tmp"),
				bound_revision: contract.task_revision,
			},
		});
		expect(result.action).toBe("block");
		expect(result.reasons.join(" ")).toContain("permanently blocked");
	});

	test("does not invoke a runner for ask_user or block decisions", async () => {
		let calls = 0;
		const authorization = authorizeCommand(task(), "git push origin feature");
		await expect(
			runAuthorizedCommand(authorization, () => {
				calls += 1;
				return { command: "git push origin feature", exit_code: 0, stdout: "", stderr: "" };
			}),
		).rejects.toThrow("ask_user");
		expect(calls).toBe(0);
	});
});
