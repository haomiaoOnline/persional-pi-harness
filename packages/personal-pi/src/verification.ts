import { randomUUID } from "node:crypto";
import { digestFor } from "./artifacts.ts";
import { evidenceHasType } from "./evidence.ts";
import type { VerificationRecipeRegistry } from "./recipes.ts";
import { TaskStateMachine } from "./state-machine.ts";
import type {
	CommandEvidence,
	EvidenceRecord,
	ResultStatus,
	TaskContract,
	TaskRecord,
	VerificationRecord,
	WorkspaceSnapshot,
} from "./types.ts";

export type CommandRunner = (command: string) => Promise<CommandEvidence> | CommandEvidence;

export interface VerificationRequest {
	task: TaskContract;
	evidence: EvidenceRecord;
	snapshot: WorkspaceSnapshot;
	currentSnapshot?: WorkspaceSnapshot;
	commandRunner?: CommandRunner;
	recipeRegistry?: VerificationRecipeRegistry;
	workerStatus?: ResultStatus;
	checked_at?: string;
}

function missingEvidence(task: TaskContract, evidence: EvidenceRecord): string[] {
	return task.verification.evidence_required.filter((required) => !evidenceHasType(evidence, required));
}

function snapshotMatches(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
	return (
		left.commit_hash === right.commit_hash &&
		left.diff_digest === right.diff_digest &&
		left.artifact_digest === right.artifact_digest
	);
}

export class VerificationEngine {
	async verify(request: VerificationRequest): Promise<VerificationRecord> {
		const checks: string[] = [];
		const reasons: string[] = [];
		let status: VerificationRecord["status"] = "PASS";
		const missing = missingEvidence(request.task, request.evidence);
		if (missing.length > 0) {
			status = "UNKNOWN";
			reasons.push(`missing evidence: ${missing.join(", ")}`);
		}
		if (request.task.verification.recipe_ref) {
			const recipe = request.recipeRegistry?.get(request.task.verification.recipe_ref);
			if (!recipe) {
				reasons.push(`missing verification recipe: ${request.task.verification.recipe_ref}`);
				if (status === "PASS") status = "UNKNOWN";
			} else {
				const missingChecks = recipe.required.filter((check) => !request.evidence.evidence_types.includes(check));
				const missingRecipeEvidence = recipe.evidence.filter((type) => !evidenceHasType(request.evidence, type));
				if (missingChecks.length > 0 || missingRecipeEvidence.length > 0) {
					status = "UNKNOWN";
					if (missingChecks.length > 0) reasons.push(`recipe checks missing: ${missingChecks.join(", ")}`);
					if (missingRecipeEvidence.length > 0)
						reasons.push(`recipe evidence missing: ${missingRecipeEvidence.join(", ")}`);
				}
				checks.push(`recipe:${recipe.id}`);
			}
		}

		const commandResults = new Map(request.evidence.commands.map((command) => [command.command, command]));
		for (const command of request.task.verification.commands) {
			let result = commandResults.get(command);
			if (!result && request.commandRunner) {
				try {
					result = await request.commandRunner(command);
				} catch (error) {
					status = "UNKNOWN";
					reasons.push(
						`verification environment error: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			if (!result) {
				status = "UNKNOWN";
				reasons.push(`missing command evidence: ${command}`);
				continue;
			}
			checks.push(`command:${command}`);
			if (result.exit_code !== 0) {
				status = "FAIL";
				reasons.push(`command failed: ${command}`);
			}
		}
		if (request.workerStatus === "failure") {
			// Worker 自称成功不能直接放行；Worker 已明确失败时只会让结论更差。
			status = "FAIL";
			reasons.push("worker result reported failure");
		}
		return {
			id: randomUUID(),
			task_id: request.task.id,
			status,
			verification_confidence: status === "PASS" ? request.task.verification.strength : "none",
			task_revision: request.task.task_revision,
			commit_hash: request.snapshot.commit_hash,
			diff_digest: request.snapshot.diff_digest,
			artifact_digest: request.snapshot.artifact_digest,
			checked_at: request.checked_at ?? new Date().toISOString(),
			checks,
			reasons,
		};
	}
}

export class AcceptanceGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcceptanceGateError";
	}
}

export class AcceptanceGate {
	markDone(task: TaskRecord, verification: VerificationRecord, currentSnapshot: WorkspaceSnapshot): TaskRecord {
		if (task.state !== "VERIFYING") throw new AcceptanceGateError("task must be VERIFYING before acceptance");
		if (verification.status !== "PASS")
			throw new AcceptanceGateError(`verification is ${verification.status}, not PASS`);
		if (verification.task_revision !== task.task_revision)
			throw new AcceptanceGateError("verification task revision is stale");
		const recordedSnapshot = {
			commit_hash: verification.commit_hash,
			diff_digest: verification.diff_digest,
			artifact_digest: verification.artifact_digest,
		};
		if (!snapshotMatches(recordedSnapshot, currentSnapshot))
			throw new AcceptanceGateError("verification PASS invalidated by workspace change");
		return new TaskStateMachine().transition(task, "DONE", "independent verification passed");
	}
}

export function canUnlockDownstream(
	verification: VerificationRecord,
	downstreamRisk: "low" | "medium" | "high",
): boolean {
	if (verification.status !== "PASS") return false;
	if (downstreamRisk === "high" && verification.verification_confidence !== "strong") return false;
	return verification.verification_confidence !== "none";
}

export function captureWorkspaceSnapshot(
	commitHash: string,
	changedFiles: readonly string[],
	artifacts: readonly string[],
): WorkspaceSnapshot {
	return {
		commit_hash: commitHash,
		diff_digest: digestFor([...changedFiles]),
		artifact_digest: digestFor([...artifacts]),
	};
}
