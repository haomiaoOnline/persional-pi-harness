import { randomUUID } from "node:crypto";
import { digestFor } from "./artifacts.ts";
import {
	deliveryEvidencePackageDigest,
	evidenceHasType,
	validateDeliveryEvidencePackage,
	workspaceSnapshotRef,
} from "./evidence.ts";
import type { VerificationRecipeRegistry } from "./recipes.ts";
import { TaskStateMachine } from "./state-machine.ts";
import type {
	CommandEvidence,
	EvidenceRecord,
	ResultContract,
	ResultStatus,
	TaskContract,
	TaskRecord,
	VerificationRecord,
	WorkspaceSnapshot,
} from "./types.ts";

export type CommandRunner = (command: string) => Promise<CommandEvidence> | CommandEvidence;

/** Verifier 的唯一 Result 视图；不包含 Worker 的 summary、scratchpad 或解释文本。 */
export interface SanitizedVerifierResult {
	task_id: string;
	run_id: string;
	worker_id: string;
	lease_epoch: number;
	status: ResultStatus;
	changed_files: string[];
	artifacts: string[];
	evidence: string[];
	errors: string[];
	requested_context?: string[];
	work_receipt?: ResultContract["work_receipt"];
}

export interface VerificationRequest {
	task: TaskContract;
	evidence: EvidenceRecord;
	snapshot: WorkspaceSnapshot;
	currentSnapshot?: WorkspaceSnapshot;
	recipeRegistry?: VerificationRecipeRegistry;
	workerStatus?: ResultStatus;
	result?: SanitizedVerifierResult;
	checked_at?: string;
}

export interface VerifierInput {
	task: {
		id: string;
		task_revision: number;
		acceptance_criteria: string[];
		verification: TaskContract["verification"];
	};
	result?: SanitizedVerifierResult;
	evidence: {
		diff: EvidenceRecord["diff"];
		commands: EvidenceRecord["commands"];
		tool_results?: EvidenceRecord["tool_results"];
		test_result?: string;
		build_result?: string;
		artifacts: string[];
		evidence_types: string[];
		delivery_evidence_package?: EvidenceRecord["delivery_evidence_package"];
	};
	recipe_ref?: string;
}

export function buildVerifierInput(request: VerificationRequest): VerifierInput {
	return {
		task: {
			id: request.task.id,
			task_revision: request.task.task_revision,
			acceptance_criteria: [...request.task.acceptance_criteria],
			verification: structuredClone(request.task.verification),
		},
		result: request.result ? sanitizeResultForVerification(request.result) : undefined,
		evidence: {
			diff: structuredClone(request.evidence.diff),
			commands: structuredClone(request.evidence.commands),
			tool_results: request.evidence.tool_results ? structuredClone(request.evidence.tool_results) : undefined,
			test_result: request.evidence.test_result,
			build_result: request.evidence.build_result,
			artifacts: [...request.evidence.artifacts],
			evidence_types: [...request.evidence.evidence_types],
			delivery_evidence_package: request.evidence.delivery_evidence_package
				? structuredClone(request.evidence.delivery_evidence_package)
				: undefined,
		},
		recipe_ref: request.task.verification.recipe_ref,
	};
}

export function sanitizeResultForVerification(
	result: ResultContract | SanitizedVerifierResult,
): SanitizedVerifierResult {
	return {
		task_id: result.task_id,
		run_id: result.run_id,
		worker_id: result.worker_id,
		lease_epoch: result.lease_epoch,
		status: result.status,
		changed_files: [...result.changed_files],
		artifacts: [...result.artifacts],
		evidence: [...result.evidence],
		errors: [...result.errors],
		requested_context: result.requested_context ? [...result.requested_context] : undefined,
		work_receipt: result.work_receipt ? structuredClone(result.work_receipt) : undefined,
	};
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
		const verifierInput = buildVerifierInput(request);
		const checks: string[] = [];
		const reasons: string[] = [];
		let status: VerificationRecord["status"] = "PASS";
		const deliveryPackage = request.evidence.delivery_evidence_package;
		const packageValidation = validateDeliveryEvidencePackage(deliveryPackage);
		if (!packageValidation.valid || !packageValidation.value) {
			status = "UNKNOWN";
			reasons.push(`delivery evidence package is incomplete: ${packageValidation.errors.join("; ")}`);
		} else {
			const packageValue = packageValidation.value;
			if (packageValue.task_revision !== request.task.task_revision) {
				status = "UNKNOWN";
				reasons.push("delivery evidence package task revision is stale");
			}
			if (
				packageValue.actual_diff.digest !== request.evidence.diff.digest ||
				packageValue.actual_diff.digest !== request.snapshot.diff_digest ||
				packageValue.artifact_digest !== request.snapshot.artifact_digest ||
				packageValue.workspace_snapshot_ref !== workspaceSnapshotRef(request.snapshot)
			) {
				status = "UNKNOWN";
				reasons.push("delivery evidence package does not match verification workspace snapshot");
			}
		}
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
				if (
					recipe.required_provider_mode &&
					request.evidence.delivery_evidence_package?.provider_mode !== recipe.required_provider_mode
				) {
					status = "UNKNOWN";
					reasons.push(
						`provider mode ${request.evidence.delivery_evidence_package?.provider_mode ?? "missing"} does not satisfy recipe requirement ${recipe.required_provider_mode}`,
					);
				}
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
			const result = commandResults.get(command);
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
		if ((verifierInput.result?.status ?? request.workerStatus) === "failure") {
			// Worker 自称成功不能直接放行；Worker 已明确失败时只会让结论更差。
			status = "FAIL";
			reasons.push("worker result reported failure");
		}
		return {
			id: randomUUID(),
			task_id: request.task.id,
			evidence_id: request.evidence.id,
			delivery_evidence_package_digest: packageValidation.value
				? deliveryEvidencePackageDigest(packageValidation.value)
				: undefined,
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
	markDone(
		task: TaskRecord,
		verification: VerificationRecord,
		currentSnapshot: WorkspaceSnapshot,
		result?: ResultContract,
		evidence?: EvidenceRecord,
	): TaskRecord {
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
		if (!verification.evidence_id || !evidence || verification.evidence_id !== evidence.id)
			throw new AcceptanceGateError("verification is not bound to the canonical Evidence record");
		if (evidence.task_id !== task.id || evidence.run_id !== result?.run_id)
			throw new AcceptanceGateError("Evidence does not belong to the accepted Task/Run");
		const packageValidation = validateDeliveryEvidencePackage(evidence.delivery_evidence_package);
		if (!packageValidation.valid || !packageValidation.value)
			throw new AcceptanceGateError("delivery evidence package is incomplete");
		const deliveryPackage = packageValidation.value;
		if (
			!verification.delivery_evidence_package_digest ||
			verification.delivery_evidence_package_digest !== deliveryEvidencePackageDigest(deliveryPackage)
		)
			throw new AcceptanceGateError("verification delivery evidence package digest is stale");
		if (
			deliveryPackage.task_revision !== task.task_revision ||
			deliveryPackage.actual_diff.digest !== currentSnapshot.diff_digest ||
			deliveryPackage.artifact_digest !== currentSnapshot.artifact_digest ||
			deliveryPackage.workspace_snapshot_ref !== workspaceSnapshotRef(currentSnapshot)
		)
			throw new AcceptanceGateError("delivery evidence package does not match accepted workspace snapshot");
		if (
			result?.status === "success" &&
			(!result.work_receipt ||
				(!result.work_receipt.no_op &&
					result.work_receipt.artifacts_created.length === 0 &&
					!result.work_receipt.state_changed &&
					result.work_receipt.effects_count === 0) ||
				(result.work_receipt.no_op && !result.work_receipt.no_op_reason))
		) {
			throw new AcceptanceGateError(
				"work_receipt_anomaly: successful result has no observable work or no-op reason",
			);
		}
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
