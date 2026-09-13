import type { ProtocolEnvelope, TaskContract } from "./types.ts";

export const PROTOCOL_METADATA_FIELDS = [
	"schema_version",
	"task_revision",
	"graph_revision",
	"lease_epoch",
	"idempotency_key",
	"action_digest",
] as const;

export function createProtocolEnvelope(
	task: TaskContract,
	leaseEpoch: number,
	actionDigest?: string,
): ProtocolEnvelope {
	return {
		task_id: task.id,
		schema_version: task.schema_version,
		task_revision: task.task_revision,
		graph_revision: task.graph_revision,
		lease_epoch: leaseEpoch,
		idempotency_key: task.execution.idempotency_key,
		action_digest: actionDigest,
	};
}

export function assertProtocolMetadataIsolation(prompt: object): void {
	const forbidden = new Set<string>(PROTOCOL_METADATA_FIELDS);
	const visit = (value: unknown, path: string): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				visit(item, `${path}[${index}]`);
			});
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			if (forbidden.has(key)) throw new Error(`protocol metadata leaked into prompt at ${path}.${key}`);
			visit(child, `${path}.${key}`);
		}
	};
	visit(prompt, "prompt");
}
