import { assertProtocolMetadataIsolation } from "./protocol.ts";
import type { PromptPayload, TaskContract } from "./types.ts";

/**
 * Prompt 只投影业务字段。协议版本、租约和幂等信息由调用方另行携带，
 * 因而模型既看不到控制面元数据，也不能把它们当成业务指令解释。
 */
export function buildPromptPayload(task: TaskContract): PromptPayload {
	const payload: PromptPayload = {
		objective: task.objective,
		requirements: [...task.requirements],
		constraints: [...task.constraints],
		scope: { files: [...task.scope.files] },
		inputs: structuredClone(task.inputs),
		context: structuredClone(task.context),
	};
	assertProtocolMetadataIsolation(payload);
	return payload;
}
