import { randomUUID } from "node:crypto";
import type { DeliveryActionRecord, HumanApprovalAction, HumanApprovalRecord } from "./types.ts";

const ACTIONS = new Set<HumanApprovalAction>(["commit", "push", "publish"]);
const FINAL_STATUSES = {
	commit: new Set(["COMMITTED", "FAILED", "BLOCKED"]),
	push: new Set(["PUSHED", "FAILED", "BLOCKED"]),
	publish: new Set(["PUBLISHED", "FAILED", "BLOCKED"]),
} as const;

function nonEmpty(value: string, field: string): void {
	if (!value.trim()) throw new Error(`${field} must not be empty`);
}

function timestamp(value: string, field: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp`);
	return parsed;
}

export function validateHumanApprovalRecord(record: HumanApprovalRecord): void {
	nonEmpty(record.id, "approval id");
	nonEmpty(record.task_id, "approval task_id");
	if (!Number.isInteger(record.task_revision) || record.task_revision < 1)
		throw new Error("approval task_revision must be a positive integer");
	if (!ACTIONS.has(record.action)) throw new Error(`unsupported approval action: ${record.action}`);
	nonEmpty(record.action_digest, "approval action_digest");
	nonEmpty(record.approved_by, "approval approved_by");
	const approvedAt = timestamp(record.approved_at, "approval approved_at");
	const expiresAt = timestamp(record.expires_at, "approval expires_at");
	if (expiresAt <= approvedAt) throw new Error("approval expires_at must be later than approved_at");
}

export interface HumanApprovalAuthorizationInput {
	task_id: string;
	task_revision: number;
	action: HumanApprovalAction;
	action_digest: string;
	now: string;
}

export function assertHumanApprovalAuthorizes(
	record: HumanApprovalRecord,
	expected: HumanApprovalAuthorizationInput,
): void {
	validateHumanApprovalRecord(record);
	if (
		record.task_id !== expected.task_id ||
		record.task_revision !== expected.task_revision ||
		record.action !== expected.action ||
		record.action_digest !== expected.action_digest
	)
		throw new Error(`human approval binding mismatch: ${record.id}`);
	const now = timestamp(expected.now, "approval authorization now");
	const approvedAt = Date.parse(record.approved_at);
	const expiresAt = Date.parse(record.expires_at);
	if (now < approvedAt) throw new Error(`human approval is not active yet: ${record.id}`);
	if (now >= expiresAt) throw new Error(`human approval is expired: ${record.id}`);
}

export function validateDeliveryActionRecord(record: DeliveryActionRecord): void {
	nonEmpty(record.id, "delivery action id");
	nonEmpty(record.task_id, "delivery action task_id");
	if (!Number.isInteger(record.task_revision) || record.task_revision < 1)
		throw new Error("delivery action task_revision must be a positive integer");
	if (!ACTIONS.has(record.action)) throw new Error(`unsupported delivery action: ${record.action}`);
	if (!FINAL_STATUSES[record.action].has(record.status))
		throw new Error(`invalid final status for ${record.action}: ${record.status}`);
	for (const [field, value] of [
		["approval_id", record.approval_id],
		["action_digest", record.action_digest],
		["acceptance_id", record.acceptance_id],
		["evidence_id", record.evidence_id],
		["delivery_evidence_package_digest", record.delivery_evidence_package_digest],
	] as const)
		nonEmpty(value, `delivery action ${field}`);
	if (record.detail !== undefined) nonEmpty(record.detail, "delivery action detail");
	if (record.action === "commit") {
		nonEmpty(record.repo_path, "commit repo_path");
		nonEmpty(record.parent_sha, "commit parent_sha");
		if (!Array.isArray(record.scope_files) || record.scope_files.length === 0)
			throw new Error("commit scope_files must not be empty");
		if (record.scope_files.some((file) => !file.trim()))
			throw new Error("commit scope_files must not contain empty paths");
		if (new Set(record.scope_files).size !== record.scope_files.length)
			throw new Error("commit scope_files must not contain duplicates");
		if (record.status === "COMMITTED") nonEmpty(record.commit_sha, "commit commit_sha");
		if (record.commit_sha !== undefined) nonEmpty(record.commit_sha, "commit commit_sha");
	}
	if (record.action === "push") {
		for (const [field, value] of [
			["repo_path", record.repo_path],
			["commit_sha", record.commit_sha],
			["remote", record.remote],
			["refspec", record.refspec],
		] as const)
			nonEmpty(value, `push ${field}`);
	}
	if (record.action === "publish") {
		for (const [field, value] of [
			["commit_sha", record.commit_sha],
			["package_name", record.package_name],
			["version", record.version],
			["registry", record.registry],
		] as const)
			nonEmpty(value, `publish ${field}`);
	}
	timestamp(record.attempted_at, "delivery action attempted_at");
}

export function createHumanApprovalRecord(
	input: Omit<HumanApprovalRecord, "id"> & { id?: string },
): HumanApprovalRecord {
	const record: HumanApprovalRecord = { ...input, id: input.id ?? randomUUID() };
	validateHumanApprovalRecord(record);
	return structuredClone(record);
}

type DeliveryActionRecordInput =
	| (Omit<Extract<DeliveryActionRecord, { action: "commit" }>, "id"> & { id?: string })
	| (Omit<Extract<DeliveryActionRecord, { action: "push" }>, "id"> & { id?: string })
	| (Omit<Extract<DeliveryActionRecord, { action: "publish" }>, "id"> & { id?: string });

export function createDeliveryActionRecord(input: DeliveryActionRecordInput): DeliveryActionRecord {
	const record = { ...input, id: input.id ?? randomUUID() } as DeliveryActionRecord;
	validateDeliveryActionRecord(record);
	return structuredClone(record);
}
