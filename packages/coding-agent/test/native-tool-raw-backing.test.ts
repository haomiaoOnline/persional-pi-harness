import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { DEFAULT_RAW_RESULT_MAX_BYTES } from "../src/core/tools/raw-result-backing.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const cleanupPaths: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-native-raw-"));
	cleanupPaths.push(directory);
	return directory;
}

function trackBacking(path: string | undefined): string {
	expect(path).toBeDefined();
	expect(existsSync(path!)).toBe(true);
	cleanupPaths.push(path!);
	return path!;
}

afterEach(() => {
	while (cleanupPaths.length > 0) rmSync(cleanupPaths.pop() as string, { recursive: true, force: true });
});

describe("native tool full raw backing before display truncation", () => {
	it("read preserves the complete selected text before model-facing truncation", async () => {
		const directory = tempDir();
		const file = join(directory, "large.txt");
		const source = `${Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join("\n")}\nREAD_TAIL_MARKER`;
		writeFileSync(file, source, "utf8");
		const result = await createReadTool(directory).execute("read-raw", { path: file });
		const backing = trackBacking(result.details?.fullOutputPath);

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(readFileSync(backing, "utf8")).toBe(source);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("READ_TAIL_MARKER");
	});

	it("grep preserves the unshortened match line before long-line/display truncation", async () => {
		const directory = tempDir();
		const file = join(directory, "match.txt");
		const longLine = `needle ${"x".repeat(4000)} GREP_TAIL_MARKER`;
		writeFileSync(file, `${longLine}\n`, "utf8");
		const result = await createGrepTool(directory).execute("grep-raw", { pattern: "needle", path: file });
		const backing = trackBacking(result.details?.fullOutputPath);
		const displayed = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.details?.linesTruncated).toBe(true);
		expect(readFileSync(backing, "utf8")).toContain("GREP_TAIL_MARKER");
		expect(displayed).not.toContain("GREP_TAIL_MARKER");
	});

	it("find preserves all results within the user result limit before byte truncation", async () => {
		const directory = tempDir();
		const results = Array.from(
			{ length: 1000 },
			(_, index) => `${"deep/".repeat(8)}file-${String(index).padStart(4, "0")}-${"x".repeat(80)}.ts`,
		);
		const tool = createFindTool(directory, { operations: { exists: () => true, glob: () => results } });
		const result = await tool.execute("find-raw", { pattern: "*.ts", limit: 1000 });
		const backing = trackBacking(result.details?.fullOutputPath);
		const raw = readFileSync(backing, "utf8");

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(raw).toContain("file-0000-");
		expect(raw).toContain("file-0999-");
	});

	it("ls preserves all entries within the user entry limit before byte truncation", async () => {
		const directory = tempDir();
		const entries = Array.from(
			{ length: 500 },
			(_, index) => `entry-${String(index).padStart(4, "0")}-${"x".repeat(120)}`,
		);
		const tool = createLsTool(directory, {
			operations: {
				exists: () => true,
				stat: () => ({ isDirectory: () => true }),
				readdir: () => entries,
			},
		});
		const result = await tool.execute("ls-raw", { path: directory, limit: 500 });
		const backing = trackBacking(result.details?.fullOutputPath);
		const raw = readFileSync(backing, "utf8");

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(raw).toContain("entry-0000-");
		expect(raw).toContain("entry-0499-");
	});

	it("does not create a backing file when read output is already complete", async () => {
		const directory = tempDir();
		const file = join(directory, "small.txt");
		writeFileSync(file, "small complete result", "utf8");
		const result = await createReadTool(directory).execute("read-small", { path: file });
		expect(result.details).toBeUndefined();
	});

	it("fails conservatively when a truncated read semantic result exceeds the hard raw cap", async () => {
		const directory = tempDir();
		const file = join(directory, "over-cap.txt");
		writeFileSync(file, `${"x".repeat(DEFAULT_RAW_RESULT_MAX_BYTES)}\nOVER_CAP_MARKER`, "utf8");
		await expect(createReadTool(directory).execute("read-over-cap", { path: file })).rejects.toThrow(/safety cap/i);
	});
});
