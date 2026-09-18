import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactHandoffContract, ArtifactRecord, GraphEdge, JsonValue, ReadinessEvaluation } from "./types.ts";

function canonicalize(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] ?? null)}`)
		.join(",")}}`;
}

function digestFor(value: JsonValue): string {
	return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export type ArtifactValidator = (payload: JsonValue) => boolean;

export class ArtifactStore {
	private readonly records = new Map<string, ArtifactRecord>();
	private readonly validators = new Map<string, ArtifactValidator>();
	private readonly rootPath?: string;

	constructor(rootPath?: string) {
		this.rootPath = rootPath;
		if (rootPath) mkdirSync(rootPath, { recursive: true });
	}

	storageRootPath(): string | undefined {
		return this.rootPath;
	}

	isDurable(): boolean {
		return typeof this.rootPath === "string" && this.rootPath.length > 0;
	}

	registerSchema(type: string, schemaVersion: number, validator: ArtifactValidator): void {
		this.validators.set(`${type}@${schemaVersion}`, validator);
	}

	put(
		type: string,
		schemaVersion: number,
		payload: JsonValue,
		producerTaskId: string,
		producerTaskRevision: number,
	): ArtifactRecord {
		const record = {
			digest: digestFor(payload),
			type,
			schema_version: schemaVersion,
			payload,
			producer_task_id: producerTaskId,
			producer_task_revision: producerTaskRevision,
		};
		this.records.set(record.digest, record);
		if (this.rootPath) {
			const path = join(this.rootPath, `${record.digest}.json`);
			if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		}
		return structuredClone(record);
	}

	get(digest: string): ArtifactRecord | undefined {
		let record = this.records.get(digest);
		if (!record && this.rootPath && /^[a-f0-9]{64}$/.test(digest)) {
			const path = join(this.rootPath, `${digest}.json`);
			if (existsSync(path)) {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as ArtifactRecord;
				if (parsed.digest === digest && digestFor(parsed.payload) === digest) {
					record = parsed;
					this.records.set(digest, parsed);
				}
			}
		}
		return record ? structuredClone(record) : undefined;
	}

	checkHandoff(edge: GraphEdge, contract: ArtifactHandoffContract): ReadinessEvaluation {
		const reasons: string[] = [];
		const record = this.get(contract.binding.artifact_digest);
		if (!record) reasons.push("产物不存在");
		if (record && record.type !== contract.readiness.requires_artifact.type) reasons.push("产物类型不匹配");
		if (record && record.schema_version !== contract.readiness.requires_artifact.schema_version) {
			reasons.push("产物 schema 版本不匹配");
		}
		if (record && record.producer_task_revision !== contract.binding.producer_task_revision) {
			reasons.push("产物 producer revision 不匹配");
		}
		const validator = this.validators.get(
			`${contract.readiness.requires_artifact.type}@${contract.readiness.requires_artifact.schema_version}`,
		);
		if (record && !validator) reasons.push("缺少产物 schema 校验器");
		if (record && validator && !validator(record.payload)) reasons.push("产物契约不匹配");
		if (reasons.length > 0) {
			return { ready: false, state: "BLOCKED", reasons: reasons.map((reason) => `${edge.id}: ${reason}`) };
		}
		return { ready: true, state: "READY", reasons: [] };
	}
}

export { canonicalize, digestFor };
