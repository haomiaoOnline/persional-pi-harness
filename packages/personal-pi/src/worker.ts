import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { LoopBudgetExhaustedError, LoopBudgetMissingError } from "./loop-budget.ts";
import { buildPromptPayload } from "./prompt.ts";
import { createModelIdentity, createWorkReceipt, validateResultContract } from "./result.ts";
import { checkRoleBoundary } from "./roles.ts";
import { validateTaskContract } from "./schema.ts";
import { authorizeWorkerExecution, filterSensitiveContext, type PermissionDecision } from "./security.ts";
import type {
	ModelIdentity,
	ResultContract,
	WorkerExecutionControls,
	WorkerExecutionInput,
	WorkerExecutionOutput,
	WorkerProtocolRequest,
	WorkerStatus,
} from "./types.ts";

export interface WorkerAdapter {
	readonly worker_id: string;
	readonly requested_model?: string;
	getModelIdentity?(): ModelIdentity;
	execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract>;
}

export type PiWorkerExecutor = (input: WorkerExecutionInput) => Promise<WorkerExecutionOutput> | WorkerExecutionOutput;

export function workerStatusForAvailability(available: boolean): WorkerStatus {
	return available
		? { worker_capability: "available", execution_mode: "normal", delivery_status: "normal" }
		: { worker_capability: "unavailable", execution_mode: "root_only", delivery_status: "degraded" };
}

/** Conservative local capability probe used by composition roots before dispatch. */
export function probeLocalProcessWorkerStatus(command: string, entryPath?: string): WorkerStatus {
	try {
		accessSync(command, constants.X_OK);
		if (entryPath) accessSync(entryPath, constants.R_OK);
		return workerStatusForAvailability(true);
	} catch {
		return workerStatusForAvailability(false);
	}
}

function failureResult(
	request: WorkerProtocolRequest,
	workerId: string,
	summary: string,
	errors: string[],
	requestedModel: string,
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
		model_identity: createModelIdentity(requestedModel),
	};
}

export class PiWorker implements WorkerAdapter {
	readonly worker_id: string;
	readonly requested_model: string;
	private readonly executor: PiWorkerExecutor;

	constructor(workerId: string, executor: PiWorkerExecutor, requestedModel = "unknown") {
		this.worker_id = workerId;
		this.executor = executor;
		this.requested_model = requestedModel.trim() || "unknown";
	}

	getModelIdentity(): ModelIdentity {
		return createModelIdentity(this.requested_model);
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls): Promise<ResultContract> {
		const validation = validateTaskContract(request.task);
		if (!validation.valid)
			return failureResult(
				request,
				this.worker_id,
				"invalid task contract",
				validation.errors,
				this.requested_model,
			);
		if (request.protocol.task_id !== request.task.id)
			return failureResult(
				request,
				this.worker_id,
				"protocol task mismatch",
				["task_id mismatch"],
				this.requested_model,
			);
		if (request.role_profile && request.task.role_profile_ref !== request.role_profile.id) {
			return failureResult(
				request,
				this.worker_id,
				"role profile mismatch",
				["role_profile_ref does not match supplied profile"],
				this.requested_model,
			);
		}
		if (request.task.role_profile_ref && !request.role_profile) {
			return failureResult(
				request,
				this.worker_id,
				"role profile is required",
				["missing role profile"],
				this.requested_model,
			);
		}
		if (request.role_profile) {
			const boundary = checkRoleBoundary(request.role_profile, request.task);
			if (!boundary.allowed)
				return failureResult(
					request,
					this.worker_id,
					"DENIED by role boundary",
					boundary.reasons,
					this.requested_model,
				);
			const requestedActions = request.requested_actions ?? [];
			const prohibited = new Set(request.role_profile.prohibited_actions.map((action) => action.toLowerCase()));
			const deniedAction = requestedActions.find((action) => prohibited.has(action.toLowerCase()));
			if (deniedAction)
				return failureResult(
					request,
					this.worker_id,
					"DENIED by role prohibited_actions",
					[`prohibited action: ${deniedAction}`],
					this.requested_model,
				);
		}

		let permission: PermissionDecision;
		try {
			permission = authorizeWorkerExecution(request.task, request.permission_request, request.role_profile);
		} catch (error) {
			return failureResult(
				request,
				this.worker_id,
				"DENIED by permission contract",
				[error instanceof Error ? error.message : String(error)],
				this.requested_model,
			);
		}

		try {
			const safeContext = request.resolved_context
				? filterSensitiveContext(request.resolved_context, permission.granted.credentials).context
				: undefined;
			const output = await this.executor({
				prompt: buildPromptPayload(request.task),
				role_profile: request.role_profile,
				requested_actions: [...(request.requested_actions ?? [])],
				resolved_context: safeContext,
				loop_budget: controls,
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
				model_identity: createModelIdentity(this.requested_model),
				requested_context: output.requested_context ? [...output.requested_context] : undefined,
				work_receipt:
					output.work_receipt ??
					createWorkReceipt(output.changed_files ?? [], output.artifacts ?? [], output.evidence ?? []),
			};
			const resultValidation = validateResultContract(result);
			return resultValidation.valid
				? result
				: failureResult(
						request,
						this.worker_id,
						"worker returned malformed result",
						resultValidation.errors,
						this.requested_model,
					);
		} catch (error) {
			if (error instanceof LoopBudgetExhaustedError || error instanceof LoopBudgetMissingError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return failureResult(request, this.worker_id, "worker execution failed", [message], this.requested_model);
		}
	}
}
