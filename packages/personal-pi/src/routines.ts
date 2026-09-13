import { randomUUID } from "node:crypto";
import type { PlaybookEntry, ReferenceArchitecturePlaybook } from "./planning.ts";
import { validateTaskContract } from "./schema.ts";
import type { EvidenceRecord, ResultContract, RunRecord, TaskContract, VerificationRecord } from "./types.ts";

export interface RoutineParameter {
	name: string;
	path: string;
}

export interface RoutineTemplate {
	id: string;
	task_type: string;
	source_task_id: string;
	source_run_id: string;
	parameters: RoutineParameter[];
	contract: TaskContract;
	playbook_entry: PlaybookEntry;
	approved_at: string;
}

export interface RoutineCaptureInput {
	task: TaskContract;
	run: RunRecord;
	result: ResultContract;
	evidence: EvidenceRecord;
	verification: VerificationRecord;
	human_approved: boolean;
	parameter_paths: string[];
	approved_at?: string;
}

export interface RoutineRegressionCase {
	template_id: string;
	reason: string;
	at: string;
}

export class RoutineCaptureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutineCaptureError";
	}
}

function mutableRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new RoutineCaptureError("path is not an object");
	return value as Record<string, unknown>;
}

function parameterName(path: string): string {
	const name = path.split(".").at(-1) ?? path;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RoutineCaptureError(`invalid parameter path: ${path}`);
	return name;
}

function readPath(root: unknown, path: string): unknown {
	let cursor = root;
	for (const segment of path.split(".")) cursor = mutableRecord(cursor)[segment];
	return cursor;
}

function writePath(root: unknown, path: string, value: unknown): void {
	const segments = path.split(".");
	let cursor: unknown = root;
	for (const segment of segments.slice(0, -1)) cursor = mutableRecord(cursor)[segment];
	mutableRecord(cursor)[segments.at(-1) as string] = value;
}

function replaceParameter(value: string): string {
	return value;
}

export class RoutineCapture {
	private readonly playbook: ReferenceArchitecturePlaybook;
	private readonly templates = new Map<string, RoutineTemplate>();
	private readonly regressionCases: RoutineRegressionCase[] = [];

	constructor(playbook: ReferenceArchitecturePlaybook) {
		this.playbook = playbook;
	}

	capture(input: RoutineCaptureInput): RoutineTemplate {
		if (!input.human_approved) throw new RoutineCaptureError("human approval is required before Playbook write");
		if (input.run.status !== "SUCCEEDED" || input.result.status !== "success")
			throw new RoutineCaptureError("only a successful Run can become a routine");
		if (input.verification.status !== "PASS") throw new RoutineCaptureError("routine source verification must PASS");
		if (input.evidence.evidence_types.length === 0) throw new RoutineCaptureError("routine source requires Evidence");
		if (input.result.task_id !== input.task.id || input.result.run_id !== input.run.id)
			throw new RoutineCaptureError("routine source identity does not match Task and Run");

		const contract = structuredClone(input.task);
		const parameters: RoutineParameter[] = [];
		const names = new Set<string>();
		for (const path of input.parameter_paths) {
			if (path === "id") throw new RoutineCaptureError("task id cannot be parameterized");
			const name = parameterName(path);
			if (names.has(name)) throw new RoutineCaptureError(`duplicate routine parameter: ${name}`);
			if (typeof readPath(contract, path) !== "string")
				throw new RoutineCaptureError(`parameter path must point to a string: ${path}`);
			writePath(contract, path, replaceParameter(`{{${name}}}`));
			parameters.push({ name, path });
			names.add(name);
		}
		const validation = validateTaskContract(contract);
		if (!validation.valid)
			throw new RoutineCaptureError(`parameterized contract is invalid: ${validation.errors.join("; ")}`);
		const id = `routine-${randomUUID()}`;
		const playbookEntry: PlaybookEntry = {
			id: `playbook-${id}`,
			task_types: [input.task.type],
			clauses: [`routine_template:${id}`, `source_run:${input.run.id}`],
		};
		this.playbook.add(playbookEntry);
		const template: RoutineTemplate = {
			id,
			task_type: input.task.type,
			source_task_id: input.task.id,
			source_run_id: input.run.id,
			parameters,
			contract,
			playbook_entry: playbookEntry,
			approved_at: input.approved_at ?? new Date().toISOString(),
		};
		this.templates.set(id, structuredClone(template));
		return structuredClone(template);
	}

	get(templateId: string): RoutineTemplate | undefined {
		const template = this.templates.get(templateId);
		return template ? structuredClone(template) : undefined;
	}

	list(): RoutineTemplate[] {
		return [...this.templates.values()].map((template) => structuredClone(template));
	}

	reuse(templateId: string, values: Record<string, string>): TaskContract {
		const template = this.templates.get(templateId);
		if (!template) throw new RoutineCaptureError(`unknown routine template: ${templateId}`);
		const contract = structuredClone(template.contract);
		for (const parameter of template.parameters) {
			const value = values[parameter.name];
			if (value === undefined || value.length === 0)
				throw new RoutineCaptureError(`missing routine parameter: ${parameter.name}`);
			writePath(contract, parameter.path, value);
		}
		contract.id = values.task_id && values.task_id.length > 0 ? values.task_id : randomUUID();
		const validation = validateTaskContract(contract);
		if (!validation.valid)
			throw new RoutineCaptureError(`reused contract is invalid: ${validation.errors.join("; ")}`);
		return contract;
	}

	recordReuseFailure(templateId: string, reason: string, at = new Date().toISOString()): RoutineRegressionCase {
		const regression = { template_id: templateId, reason, at };
		this.regressionCases.push(regression);
		return { ...regression };
	}

	regressions(): RoutineRegressionCase[] {
		return this.regressionCases.map((regression) => ({ ...regression }));
	}
}
