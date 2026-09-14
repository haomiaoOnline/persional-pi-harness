import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EffectJournal, EffectJournalError, PersistentStateStore } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T5.5 persistent Effect Journal", () => {
	test("reuses a committed effect after restart and rejects a changed action", async () => {
		const directory = mkdtempSync(join(tmpdir(), "personal-pi-effects-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "state.json");
		let actionRuns = 0;
		const first = new EffectJournal(new PersistentStateStore(path));
		const committed = await first.run(
			"effect-persisted",
			"local-file",
			() => {
				actionRuns += 1;
			},
			{ action_digest: "action-v1" },
		);
		const restarted = new EffectJournal(new PersistentStateStore(path));
		const reused = await restarted.run(
			"effect-persisted",
			"local-file",
			() => {
				actionRuns += 1;
			},
			{ action_digest: "action-v1" },
		);

		expect(committed).toMatchObject({ committed: true, reused: false, record: { status: "committed" } });
		expect(reused).toMatchObject({ committed: true, reused: true, record: { status: "committed" } });
		expect(actionRuns).toBe(1);
		expect(new PersistentStateStore(path).read().effects).toHaveLength(1);
		await expect(
			restarted.run("effect-persisted", "local-file", () => undefined, { action_digest: "action-v2" }),
		).rejects.toThrow(EffectJournalError);
	});
});
