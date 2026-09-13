import { randomUUID } from "node:crypto";
import { buildPromptPayload } from "./prompt.ts";
import { validateResultContract } from "./result.ts";
import { checkRoleBoundary } from "./roles.ts";
import { validateTaskContract } from "./schema.ts";
import type { ResultContract, WorkerExecutionInput, WorkerExecutionOutput, WorkerProtocolRequest } from "./types.ts";

export interface WorkerAdapter {
	readonly worker_id: string;
	execute(request: WorkerProtocolRequest): Promise<ResultContract>;
}

export type PiWorkerExecutor = (input: WorkerExecutionInput) => Promise<WorkerExecutionOutput> | WorkerExecutionOutput;

function failureResult(
	request: WorkerProtocolRequest,
	workerId: string,
	summary: string,
	errors: string[],
): ResultContract {
	return {
		task_id: request.task.id,
		run_id: request.run_id ?? randomUUID(),
		worker_id: workerId,
		lease_epoch: request.protocol.lease_epoch,
		status: "failure",
		summary,
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors,
	};
}

export class PiWorker implements WorkerAdapter {
	readonly worker_id: string;
	private readonly executor: PiWorkerExecutor;

	constructor(workerId: string, executor: PiWorkerExecutor) {
		this.worker_id = workerId;
		this.executor = executor;
	}

	async execute(request: WorkerProtocolRequest): Promise<ResultContract> {
		const validation = validateTaskContract(request.task);
		if (!validation.valid) return failureResult(request, this.worker_id, "invalid task contract", validation.errors);
		if (request.protocol.task_id !== request.task.id)
			return failureResult(request, this.worker_id, "protocol task mismatch", ["task_id mismatch"]);
		if (request.role_profile && request.task.role_profile_ref !== request.role_profile.id) {
			return failureResult(request, this.worker_id, "role profile mismatch", [
				"role_profile_ref does not match supplied profile",
			]);
		}
		if (request.task.role_profile_ref && !request.role_profile) {
			return failureResult(request, this.worker_id, "role profile is required", ["missing role profile"]);
		}
		if (request.role_profile) {
			const boundary = checkRoleBoundary(request.role_profile, request.task);
			if (!boundary.allowed)
				return failureResult(request, this.worker_id, "DENIED by role boundary", boundary.reasons);
			const requestedActions = request.requested_actions ?? [];
			const prohibited = new Set(request.role_profile.prohibited_actions.map((action) => action.toLowerCase()));
			const deniedAction = requestedActions.find((action) => prohibited.has(action.toLowerCase()));
			if (deniedAction)
				return failureResult(request, this.worker_id, "DENIED by role prohibited_actions", [
					`prohibited action: ${deniedAction}`,
				]);
		}

		try {
			const output = await this.executor({
				prompt: buildPromptPayload(request.task),
				role_profile: request.role_profile,
				requested_actions: [...(request.requested_actions ?? [])],
			});
			const result: ResultContract = {
				task_id: request.task.id,
				run_id: request.run_id ?? randomUUID(),
				worker_id: this.worker_id,
				lease_epoch: request.protocol.lease_epoch,
				status: output.status,
				summary: output.summary,
				changed_files: [...(output.changed_files ?? [])],
				artifacts: [...(output.artifacts ?? [])],
				evidence: [...(output.evidence ?? [])],
				errors: [...(output.errors ?? [])],
				requested_context: output.requested_context ? [...output.requested_context] : undefined,
			};
			const resultValidation = validateResultContract(result);
			return resultValidation.valid
				? result
				: failureResult(request, this.worker_id, "worker returned malformed result", resultValidation.errors);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return failureResult(request, this.worker_id, "worker execution failed", [message]);
		}
	}
}
