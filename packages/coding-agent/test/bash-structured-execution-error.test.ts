import { existsSync, readFileSync, rmSync } from "node:fs";
import { AgentToolExecutionError } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

const cleanupPaths: string[] = [];

afterEach(() => {
	while (cleanupPaths.length > 0) rmSync(cleanupPaths.pop() as string, { force: true });
});

function textOf(error: AgentToolExecutionError): string {
	return error.result.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

function chattyOperations(outcome: "nonzero" | "timeout" | "abort"): BashOperations {
	return {
		exec: async (_command, _cwd, { onData, onStdout, onStderr }) => {
			for (let i = 1; i <= 3000; i++) {
				const data = Buffer.from(`stdout-${i}\n`, "utf8");
				onStdout?.(data);
				onData(data);
			}
			const stderr = Buffer.from("STDERR_EXACT_MARKER\n", "utf8");
			onStderr?.(stderr);
			onData(stderr);
			if (outcome === "nonzero") return { exitCode: 23 };
			throw new Error(outcome === "timeout" ? "timeout:5" : "aborted");
		},
	};
}

async function executeFailure(outcome: "nonzero" | "timeout" | "abort"): Promise<AgentToolExecutionError> {
	const bash = createBashTool(process.cwd(), {
		operations: chattyOperations(outcome),
		exposeSessionEnvironment: false,
	});
	try {
		await bash.execute(`structured-${outcome}`, { command: `chatty-${outcome}` });
	} catch (error) {
		expect(error).toBeInstanceOf(AgentToolExecutionError);
		return error as AgentToolExecutionError;
	}
	throw new Error(`expected ${outcome} bash execution to fail`);
}

describe("bash structured execution failures", () => {
	for (const testCase of [
		{ outcome: "nonzero" as const, status: "Command exited with code 23" },
		{ outcome: "timeout" as const, status: "Command timed out after 5 seconds" },
		{ outcome: "abort" as const, status: "Command aborted" },
	]) {
		it(`preserves truncated full output details for ${testCase.outcome}`, async () => {
			const error = await executeFailure(testCase.outcome);
			expect(error.message).toContain(testCase.status);
			expect(textOf(error)).toContain(testCase.status);
			const details = error.result.details as
				| {
						fullOutputPath?: string;
						truncation?: { truncated?: boolean };
						stdoutFullOutputPath?: string;
						stderrFullOutputPath?: string;
						stdoutBytes?: number;
						stderrBytes?: number;
						streamSeparation?: string;
						outcome?: { kind: string; exit_code: number | null; timeout_seconds?: number };
				  }
				| undefined;
			expect(details?.truncation?.truncated).toBe(true);
			for (const path of [details?.fullOutputPath, details?.stdoutFullOutputPath, details?.stderrFullOutputPath]) {
				expect(path).toBeDefined();
				expect(existsSync(path!)).toBe(true);
				cleanupPaths.push(path!);
			}
			const stdout = readFileSync(details!.stdoutFullOutputPath!, "utf8");
			const stderr = readFileSync(details!.stderrFullOutputPath!, "utf8");
			expect(stdout).toContain("stdout-1\nstdout-2\nstdout-3");
			expect(stdout).toContain("stdout-2998\nstdout-2999\nstdout-3000");
			expect(stdout).not.toContain("STDERR_EXACT_MARKER");
			expect(stderr).toBe("STDERR_EXACT_MARKER\n");
			expect(details?.stdoutBytes).toBe(Buffer.byteLength(stdout));
			expect(details?.stderrBytes).toBe(Buffer.byteLength(stderr));
			expect(details?.streamSeparation).toBe("exact");
			if (testCase.outcome === "nonzero") expect(details?.outcome).toEqual({ kind: "exit", exit_code: 23 });
			if (testCase.outcome === "timeout")
				expect(details?.outcome).toEqual({ kind: "timeout", exit_code: null, timeout_seconds: 5 });
			if (testCase.outcome === "abort") expect(details?.outcome).toEqual({ kind: "abort", exit_code: null });
		});
	}

	it("preserves exact local stdout/stderr streams and the real nonzero exit code", async () => {
		const bash = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
		let error: unknown;
		try {
			await bash.execute("local-exit-code", {
				command: "printf 'LOCAL_STDOUT_MARKER\\n'; printf 'LOCAL_STDERR_MARKER\\n' >&2; exit 7",
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(AgentToolExecutionError);
		const details = (error as AgentToolExecutionError).result.details as {
			stdoutFullOutputPath?: string;
			stderrFullOutputPath?: string;
			streamSeparation?: string;
			outcome?: { kind: string; exit_code: number | null };
		};
		for (const path of [details.stdoutFullOutputPath, details.stderrFullOutputPath]) {
			expect(path).toBeDefined();
			expect(existsSync(path!)).toBe(true);
			cleanupPaths.push(path!);
		}
		expect(readFileSync(details.stdoutFullOutputPath!, "utf8")).toBe("LOCAL_STDOUT_MARKER\n");
		expect(readFileSync(details.stderrFullOutputPath!, "utf8")).toBe("LOCAL_STDERR_MARKER\n");
		expect(details.streamSeparation).toBe("exact");
		expect(details.outcome).toEqual({ kind: "exit", exit_code: 7 });
	});
});
