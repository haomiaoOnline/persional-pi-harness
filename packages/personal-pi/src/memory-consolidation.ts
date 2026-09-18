import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateMasterHandoffReceipt } from "./handoff.ts";
import { validateResultContract, workReceiptErrors } from "./result.ts";
import { validateTaskContract } from "./schema.ts";
import { type ScheduleDefinition, TriggerGateway } from "./triggers.ts";
import type {
	DecisionRecord,
	EvidenceRecord,
	JsonValue,
	MasterHandoffReceipt,
	ResultContract,
	RunRecord,
	TaskContract,
} from "./types.ts";

export interface ColdEvidenceArchive {
	archive(evidence: EvidenceRecord): string;
	read(reference: string): EvidenceRecord | undefined;
}

export class MemoryColdEvidenceArchive implements ColdEvidenceArchive {
	private readonly records = new Map<string, EvidenceRecord>();

	archive(evidence: EvidenceRecord): string {
		const reference = `cold://evidence/${evidence.id}`;
		if (!this.records.has(reference)) this.records.set(reference, structuredClone(evidence));
		return reference;
	}

	read(reference: string): EvidenceRecord | undefined {
		const evidence = this.records.get(reference);
		return evidence ? structuredClone(evidence) : undefined;
	}

	list(): EvidenceRecord[] {
		return [...this.records.values()].map((evidence) => structuredClone(evidence));
	}
}

/** 文件冷存储只新增文件，从不删除原始 Evidence。 */
export class FileColdEvidenceArchive implements ColdEvidenceArchive {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true });
	}

	archive(evidence: EvidenceRecord): string {
		const fileName = `${createHash("sha256").update(evidence.id).digest("hex")}.json`;
		const path = join(this.directory, fileName);
		if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
		return `cold://file/${fileName}`;
	}

	read(reference: string): EvidenceRecord | undefined {
		const match = /^cold:\/\/file\/([a-f0-9]{64}\.json)$/.exec(reference);
		if (!match) return undefined;
		const path = join(this.directory, match[1]);
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as EvidenceRecord;
	}
}

export interface ConsolidationInput {
	task: TaskContract;
	run: RunRecord;
	result: ResultContract;
	evidence: EvidenceRecord;
	receipt: MasterHandoffReceipt;
	decisions: readonly DecisionRecord[];
	at?: string;
}

export interface ConsolidationRecord {
	id: string;
	idempotency_key: string;
	status: "CONSOLIDATED" | "NO_OP";
	task_id: string;
	run_id: string;
	consolidation_task_id: string;
	summary: string;
	compact_decisions: string[];
	archived_evidence_refs: string[];
	hot_path_before: { items: number; tokens: number };
	hot_path_after: { items: number; tokens: number };
	token_delta: number;
	evidence_refs: string[];
	reason: string;
	at: string;
}

export interface HotMemorySnapshot {
	items: string[];
	tokens: number;
}

export class MemoryConsolidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryConsolidationError";
	}
}

function tokenEstimate(value: string): number {
	return Math.max(1, Math.ceil(value.length / 4));
}

function contentKey(input: ConsolidationInput): string {
	const { evidence_refs: _evidenceRefs, ...semanticReceipt } = input.receipt;
	return createHash("sha256")
		.update(
			JSON.stringify({
				task_id: input.task.id,
				receipt: semanticReceipt,
				decisions: input.decisions,
			}),
		)
		.digest("hex");
}

function consolidationTask(input: ConsolidationInput, idempotencyKey: string): TaskContract {
	return {
		id: `memory-consolidation-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 16)}`,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "memory_consolidation",
		title: `Consolidate completed task ${input.task.id}`,
		objective: "Summarize completed Task decisions and archive raw Evidence",
		requirements: ["preserve raw Evidence", "write compact memory"],
		constraints: ["deterministic", "no raw Evidence deletion"],
		scope: { files: [] },
		inputs: { source_task_id: input.task.id, source_run_id: input.run.id },
		data_sources: ["Persistent State", "Evidence"],
		data_references: [input.evidence.id],
		permissions: {
			filesystem: { read: [], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "cheap",
			reasoning_depth: "low",
			capability_tags: ["memory"],
			mode: "single",
			working_directory: input.task.execution.working_directory,
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["compact memory", "cold Evidence reference"],
		acceptance_criteria: ["raw Evidence remains readable from cold storage"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["archive exists"],
			evidence_required: ["memory_consolidation"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 1000 } },
		risk: "low",
		priority: "P2",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
	};
}

function validatedConsolidationTask(input: ConsolidationInput, idempotencyKey: string): TaskContract {
	const task = consolidationTask(input, idempotencyKey);
	if (!validateTaskContract(task).valid)
		throw new MemoryConsolidationError("generated consolidation Task Contract is invalid");
	return task;
}

function validateCompletedInput(input: ConsolidationInput): void {
	if (!validateTaskContract(input.task).valid) throw new MemoryConsolidationError("source Task Contract is invalid");
	if (input.run.task_id !== input.task.id || input.result.task_id !== input.task.id)
		throw new MemoryConsolidationError("Task, Run and Result identities do not match");
	if (input.result.run_id !== input.run.id || input.result.worker_id !== input.run.worker_id)
		throw new MemoryConsolidationError("completed Result is not bound to the Run");
	if (input.result.lease_epoch !== input.run.lease_epoch) throw new MemoryConsolidationError("lease epoch mismatch");
	if (input.run.status !== "SUCCEEDED" || input.result.status !== "success")
		throw new MemoryConsolidationError("only a completed successful Run can be consolidated");
	if (input.evidence.task_id !== input.task.id || input.evidence.run_id !== input.run.id)
		throw new MemoryConsolidationError("Evidence is not bound to the completed Run");
	if (!input.result.work_receipt) throw new MemoryConsolidationError("completed Result requires a Work Receipt");
	const receiptErrors = workReceiptErrors(input.result.work_receipt);
	if (receiptErrors.length > 0) throw new MemoryConsolidationError(receiptErrors.join("; "));
	if (!validateResultContract(input.result).valid) throw new MemoryConsolidationError("Result Contract is invalid");
	const handoff = validateMasterHandoffReceipt(input.receipt);
	if (!handoff.valid || !handoff.value) throw new MemoryConsolidationError("Master handoff receipt is invalid");
	if (
		input.receipt.task_id !== input.task.id ||
		input.receipt.status !== "DONE" ||
		input.receipt.acceptance !== "PASS"
	)
		throw new MemoryConsolidationError("Master handoff receipt is not the accepted terminal Task receipt");
	if (!input.receipt.evidence_refs.includes(input.evidence.id))
		throw new MemoryConsolidationError("Master handoff receipt does not reference the archived Evidence");
	if (JSON.stringify(input.receipt.work_receipt) !== JSON.stringify(input.result.work_receipt))
		throw new MemoryConsolidationError("Master handoff Work Receipt does not match the completed Result");
}

export interface MemoryConsolidatorOptions {
	trigger_gateway?: TriggerGateway;
	archive?: ColdEvidenceArchive;
	now?: () => string;
	max_hot_entries?: number;
}

/**
 * 后台整理复用 Trigger Gateway 创建内部 Task Contract；热路径只保留 compact
 * 摘要，原始 Evidence 通过 ColdEvidenceArchive 永久保留。
 */
export class MemoryConsolidator {
	private readonly trigger: TriggerGateway;
	private readonly archive: ColdEvidenceArchive;
	private readonly now: () => string;
	private readonly maxHotEntries: number;
	private readonly recordsByKey = new Map<string, ConsolidationRecord>();
	private readonly seenContent = new Set<string>();
	private hotItems: string[] = [];

	constructor(options: MemoryConsolidatorOptions = {}) {
		this.trigger = options.trigger_gateway ?? new TriggerGateway();
		this.archive = options.archive ?? new MemoryColdEvidenceArchive();
		this.now = options.now ?? (() => new Date().toISOString());
		this.maxHotEntries = options.max_hot_entries ?? 50;
		if (!Number.isInteger(this.maxHotEntries) || this.maxHotEntries < 1)
			throw new MemoryConsolidationError("max_hot_entries must be positive");
	}

	consolidate(input: ConsolidationInput): ConsolidationRecord {
		validateCompletedInput(input);
		const at = input.at ?? this.now();
		const idempotencyKey = `memory:${input.task.id}:${input.run.id}:${input.evidence.id}`;
		const generatedTask = validatedConsolidationTask(input, idempotencyKey);
		const triggerResult = this.trigger.createFromWebhook(
			{
				source: "memory-consolidation",
				event_id: idempotencyKey,
				payload: {
					task_id: input.task.id,
					run_id: input.run.id,
					evidence_id: input.evidence.id,
				} satisfies JsonValue,
				received_at: at,
			},
			() => generatedTask,
		);
		return this.consolidateAfterTrigger(input, at, triggerResult.task?.id ?? generatedTask.id);
	}

	/** 受控 schedule 入口；未命中 schedule 返回 undefined，不创建 Run。 */
	consolidateFromSchedule(
		schedule: ScheduleDefinition,
		at: Date,
		input: ConsolidationInput,
	): ConsolidationRecord | undefined {
		validateCompletedInput(input);
		const receivedAt = at.toISOString();
		const triggerKey = `schedule:${schedule.id}:${receivedAt.slice(0, 16)}`;
		const generatedTask = validatedConsolidationTask(input, triggerKey);
		const triggerResult = this.trigger.createFromSchedule(schedule, at, () => generatedTask);
		if (!triggerResult.created) {
			if (triggerResult.reason !== "duplicate idempotency_key") return undefined;
			const idempotencyKey = `memory:${input.task.id}:${input.run.id}:${input.evidence.id}`;
			const previous = this.recordsByKey.get(idempotencyKey);
			if (!previous) return undefined;
			return structuredClone(
				this.makeRecord({
					idempotencyKey,
					taskId: input.task.id,
					runId: input.run.id,
					consolidationTaskId: previous.consolidation_task_id,
					status: "NO_OP",
					summary: "no new completed-task content",
					compactDecisions: [],
					archivedEvidenceRefs: [],
					before: this.hotPath(),
					reason: "duplicate scheduled consolidation idempotency key",
					at: receivedAt,
				}),
			);
		}
		return this.consolidateAfterTrigger(input, receivedAt, triggerResult.task?.id ?? generatedTask.id);
	}

	private consolidateAfterTrigger(
		input: ConsolidationInput,
		at: string,
		consolidationTaskId: string,
	): ConsolidationRecord {
		const idempotencyKey = `memory:${input.task.id}:${input.run.id}:${input.evidence.id}`;
		const before = this.hotPath();
		const previous = this.recordsByKey.get(idempotencyKey);
		if (previous) {
			return structuredClone(
				this.makeRecord({
					idempotencyKey,
					taskId: input.task.id,
					runId: input.run.id,
					consolidationTaskId: previous.consolidation_task_id,
					status: "NO_OP",
					summary: "no new completed-task content",
					compactDecisions: [],
					archivedEvidenceRefs: [],
					before,
					reason: "duplicate consolidation idempotency key",
					at,
				}),
			);
		}

		const key = contentKey(input);
		if (this.seenContent.has(key)) {
			const archiveReference = this.archive.archive(input.evidence);
			const noOp = this.makeRecord({
				idempotencyKey,
				taskId: input.task.id,
				runId: input.run.id,
				consolidationTaskId,
				status: "NO_OP",
				summary: "no new completed-task content",
				compactDecisions: [],
				archivedEvidenceRefs: [archiveReference],
				before,
				reason: "content already consolidated",
				at,
			});
			this.recordsByKey.set(idempotencyKey, noOp);
			return structuredClone(noOp);
		}

		const archiveReference = this.archive.archive(input.evidence);
		const summary = JSON.stringify({
			task_id: input.receipt.task_id,
			status: input.receipt.status,
			git_sha: input.receipt.git_sha,
			acceptance: input.receipt.acceptance,
			evidence_refs: input.receipt.evidence_refs,
			unresolved_risks: input.receipt.unresolved_risks,
			next_action: input.receipt.next_action,
			work_receipt: input.receipt.work_receipt,
		});
		const compactDecisions = input.decisions.map((decision) => `${decision.decision_type}:${decision.decision}`);
		this.hotItems.push(summary, ...compactDecisions);
		if (this.hotItems.length > this.maxHotEntries) this.hotItems = this.hotItems.slice(-this.maxHotEntries);
		this.seenContent.add(key);
		const after = this.hotPath();
		const record = this.makeRecord({
			idempotencyKey,
			taskId: input.task.id,
			runId: input.run.id,
			consolidationTaskId,
			status: "CONSOLIDATED",
			summary,
			compactDecisions,
			archivedEvidenceRefs: [archiveReference],
			before,
			after,
			reason: "completed Task summarized and raw Evidence archived",
			at,
		});
		this.recordsByKey.set(idempotencyKey, record);
		return structuredClone(record);
	}

	hotPath(): HotMemorySnapshot {
		return { items: [...this.hotItems], tokens: this.hotItems.reduce((sum, item) => sum + tokenEstimate(item), 0) };
	}

	list(): ConsolidationRecord[] {
		return [...this.recordsByKey.values()].map((record) => structuredClone(record));
	}

	private makeRecord(input: {
		idempotencyKey: string;
		taskId: string;
		runId: string;
		consolidationTaskId: string;
		status: ConsolidationRecord["status"];
		summary: string;
		compactDecisions: string[];
		archivedEvidenceRefs: string[];
		before: HotMemorySnapshot;
		after?: HotMemorySnapshot;
		reason: string;
		at: string;
	}): ConsolidationRecord {
		const after = input.after ?? input.before;
		return {
			id: randomUUID(),
			idempotency_key: input.idempotencyKey,
			status: input.status,
			task_id: input.taskId,
			run_id: input.runId,
			consolidation_task_id: input.consolidationTaskId,
			summary: input.summary,
			compact_decisions: [...input.compactDecisions],
			archived_evidence_refs: [...input.archivedEvidenceRefs],
			hot_path_before: { items: input.before.items.length, tokens: input.before.tokens },
			hot_path_after: { items: after.items.length, tokens: after.tokens },
			token_delta: after.tokens - input.before.tokens,
			evidence_refs: [...input.archivedEvidenceRefs],
			reason: input.reason,
			at: input.at,
		};
	}
}
