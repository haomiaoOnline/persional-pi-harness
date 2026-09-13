import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "./artifacts.ts";
import type { TaskGraphStore } from "./graph.ts";
import { evaluateDefinitionOfReady } from "./readiness.ts";
import { validateTaskContract } from "./schema.ts";
import type {
	ArtifactHandoffContract,
	GraphEdge,
	ReadinessEvaluation,
	TaskContract,
	TaskGraph,
	TaskRecord,
	TaskStatus,
} from "./types.ts";

export class DecompositionContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecompositionContractError";
	}
}

export interface DecompositionResult {
	parent_task_id: string;
	child_task_ids: string[];
	graph_revision: number;
	depth: number;
}

export interface DecompositionBudget {
	max_depth: number;
	max_children_per_task: number;
	max_total_open_tasks: number;
	max_replan_count: number;
}

export interface CoordinationBudget {
	max_active_workers: number;
	max_handoffs_per_task: number;
	max_concurrent_roles: number;
}

export interface BudgetUsage {
	open_tasks: number;
	replan_count: number;
	active_workers: number;
	handoffs_by_task: Record<string, number>;
	concurrent_roles: number;
}

export interface BudgetApproval {
	approved_by: string;
	reason: string;
	at?: string;
}

export interface BudgetDecision {
	id: string;
	dimension: string;
	action: "ALLOW" | "DENY" | "INCREASE";
	reason: string;
	approved_by?: string;
	at: string;
}

export class BudgetExceededError extends Error {
	readonly dimension: string;

	constructor(dimension: string, message: string) {
		super(`${dimension}: ${message}`);
		this.name = "BudgetExceededError";
		this.dimension = dimension;
	}
}

function now(): string {
	return new Date().toISOString();
}

function cloneUsage(usage: BudgetUsage): BudgetUsage {
	return { ...usage, handoffs_by_task: { ...usage.handoffs_by_task } };
}

export class BudgetController {
	private decomposition: DecompositionBudget;
	private coordination: CoordinationBudget;
	private usage: BudgetUsage;
	private readonly decisions: BudgetDecision[] = [];

	constructor(
		decomposition: DecompositionBudget,
		coordination: CoordinationBudget = {
			max_active_workers: 1,
			max_handoffs_per_task: 1,
			max_concurrent_roles: 1,
		},
		usage: Partial<BudgetUsage> = {},
	) {
		this.decomposition = { ...decomposition };
		this.coordination = { ...coordination };
		this.usage = {
			open_tasks: usage.open_tasks ?? 0,
			replan_count: usage.replan_count ?? 0,
			active_workers: usage.active_workers ?? 0,
			handoffs_by_task: { ...(usage.handoffs_by_task ?? {}) },
			concurrent_roles: usage.concurrent_roles ?? 0,
		};
	}

	checkDecomposition(depth: number, children: number, openTasks: number): void {
		if (depth >= this.decomposition.max_depth)
			this.deny("max_depth", `decomposition depth ${depth} reached max_depth`);
		if (children > this.decomposition.max_children_per_task)
			this.deny("max_children_per_task", "decomposition child count exceeds budget");
		if (openTasks > this.decomposition.max_total_open_tasks)
			this.deny("max_total_open_tasks", "open task count exceeds budget");
		if (this.usage.replan_count >= this.decomposition.max_replan_count)
			this.deny("max_replan_count", "replan count exceeds budget");
		this.decisions.push({
			id: randomUUID(),
			dimension: "decomposition",
			action: "ALLOW",
			reason: `depth=${depth}, children=${children}, open_tasks=${openTasks}`,
			at: now(),
		});
	}

	recordReplan(): void {
		if (this.usage.replan_count >= this.decomposition.max_replan_count)
			this.deny("max_replan_count", "replan count exceeds budget");
		this.usage.replan_count += 1;
	}

	reserveDispatch(taskId: string, activeWorkers: number, handoffs: number, concurrentRoles: number): void {
		if (activeWorkers > this.coordination.max_active_workers)
			this.deny("max_active_workers", "active worker count exceeds coordination budget");
		if (handoffs > this.coordination.max_handoffs_per_task)
			this.deny("max_handoffs_per_task", `handoff count exceeds budget for ${taskId}`);
		if (concurrentRoles > this.coordination.max_concurrent_roles)
			this.deny("max_concurrent_roles", "concurrent role count exceeds coordination budget");
		this.usage.active_workers = activeWorkers;
		this.usage.handoffs_by_task[taskId] = handoffs;
		this.usage.concurrent_roles = concurrentRoles;
		this.decisions.push({
			id: randomUUID(),
			dimension: "coordination",
			action: "ALLOW",
			reason: `task=${taskId}, workers=${activeWorkers}, handoffs=${handoffs}, roles=${concurrentRoles}`,
			at: now(),
		});
	}

	increase(
		decomposition: Partial<DecompositionBudget>,
		coordination: Partial<CoordinationBudget>,
		approval: BudgetApproval,
	): BudgetDecision {
		if (approval.approved_by.length === 0 || approval.reason.length === 0)
			this.deny("human_approval", "budget increase requires approver and reason");
		this.decomposition = { ...this.decomposition, ...decomposition };
		this.coordination = { ...this.coordination, ...coordination };
		const decision: BudgetDecision = {
			id: randomUUID(),
			dimension: "manual_budget_increase",
			action: "INCREASE",
			reason: approval.reason,
			approved_by: approval.approved_by,
			at: approval.at ?? now(),
		};
		this.decisions.push(decision);
		return { ...decision };
	}

	read(): { decomposition: DecompositionBudget; coordination: CoordinationBudget; usage: BudgetUsage } {
		return {
			decomposition: { ...this.decomposition },
			coordination: { ...this.coordination },
			usage: cloneUsage(this.usage),
		};
	}

	decisionsList(): BudgetDecision[] {
		return this.decisions.map((decision) => ({ ...decision }));
	}

	private deny(dimension: string, message: string): never {
		this.decisions.push({
			id: randomUUID(),
			dimension,
			action: "DENY",
			reason: message,
			at: now(),
		});
		throw new BudgetExceededError(dimension, message);
	}
}

export class DynamicDecomposer {
	private readonly graph: TaskGraphStore;
	private readonly budget?: BudgetController;
	private readonly tasks = new Map<string, TaskContract>();
	private readonly depths = new Map<string, number>();

	constructor(graph: TaskGraphStore, budget?: BudgetController, initialTasks: readonly TaskContract[] = []) {
		this.graph = graph;
		this.budget = budget;
		for (const task of initialTasks) {
			const validation = validateTaskContract(task);
			if (!validation.valid)
				throw new DecompositionContractError(`invalid initial task: ${validation.errors.join("; ")}`);
			this.tasks.set(task.id, structuredClone(task));
			this.depths.set(task.id, 0);
		}
	}

	decompose(parent: TaskContract, children: readonly TaskContract[]): DecompositionResult {
		const parentValidation = validateTaskContract(parent);
		if (!parentValidation.valid)
			throw new DecompositionContractError(`invalid parent contract: ${parentValidation.errors.join("; ")}`);
		if (!this.graph.read().nodes.some((node) => node.task_id === parent.id))
			throw new DecompositionContractError(`parent task is absent from graph: ${parent.id}`);
		if (children.length === 0) throw new DecompositionContractError("decomposition must produce at least one child");
		const childIds = new Set<string>();
		for (const child of children) {
			const validation = validateTaskContract(child);
			if (!validation.valid)
				throw new DecompositionContractError(`invalid child contract: ${validation.errors.join("; ")}`);
			if (child.acceptance_criteria.length === 0)
				throw new DecompositionContractError(
					`child is not ready for decomposition: ${child.id} has no acceptance criteria`,
				);
			if (child.id === parent.id || childIds.has(child.id) || this.tasks.has(child.id))
				throw new DecompositionContractError(`duplicate decomposition task: ${child.id}`);
			childIds.add(child.id);
		}
		const parentDepth = this.depths.get(parent.id) ?? 0;
		const openTasks = this.tasks.size + children.length + (this.tasks.has(parent.id) ? 0 : 1);
		if (this.budget) this.budget.checkDecomposition(parentDepth, children.length, openTasks);
		const nodes = children.map((child) => ({ id: `node:${child.id}`, task_id: child.id }));
		const edges: GraphEdge[] = children.map((child) => ({
			id: `decompose:${parent.id}:${child.id}`,
			from: this.graph.read().nodes.find((node) => node.task_id === parent.id)?.id ?? parent.id,
			to: `node:${child.id}`,
			type: "BLOCKS",
		}));
		const graph = this.graph.applyMutation({ nodes, edges });
		if (!this.tasks.has(parent.id)) {
			this.tasks.set(parent.id, structuredClone(parent));
			this.depths.set(parent.id, parentDepth);
		}
		for (const child of children) {
			this.tasks.set(child.id, structuredClone(child));
			this.depths.set(child.id, parentDepth + 1);
		}
		return {
			parent_task_id: parent.id,
			child_task_ids: [...childIds],
			graph_revision: graph.revision,
			depth: parentDepth + 1,
		};
	}

	getTask(taskId: string): TaskContract | undefined {
		const task = this.tasks.get(taskId);
		return task ? structuredClone(task) : undefined;
	}

	depth(taskId: string): number | undefined {
		return this.depths.get(taskId);
	}

	readGraph(): TaskGraph {
		return this.graph.read();
	}
}

export class DependencyResolver {
	private readonly tasks: Map<string, TaskRecord>;

	constructor(tasks: readonly TaskRecord[]) {
		this.tasks = new Map(tasks.map((task) => [task.id, structuredClone(task)]));
	}

	resolve(
		taskId: string,
		artifactEdges: readonly GraphEdge[] = [],
		artifactStore?: ArtifactStore,
	): ReadinessEvaluation {
		const task = this.tasks.get(taskId);
		if (!task) return { ready: false, state: "NOT_READY", reasons: [`unknown task: ${taskId}`] };
		const missing = task.dependencies.filter((dependency) => this.tasks.get(dependency)?.state !== "DONE");
		if (missing.length > 0)
			return { ready: false, state: "BLOCKED", reasons: [`dependencies are not satisfied: ${missing.join(", ")}`] };
		const { state: _state, audit_log: _auditLog, ...contract } = task;
		return evaluateDefinitionOfReady(contract, true, artifactEdges, artifactStore);
	}

	resolveAll(): Record<string, TaskStatus | "NOT_READY"> {
		const states: Record<string, TaskStatus | "NOT_READY"> = {};
		for (const [taskId, task] of this.tasks)
			states[taskId] = task.state === "DONE" ? "DONE" : this.resolve(taskId).state;
		return states;
	}
}

export function createArtifactDependencyEdge(
	id: string,
	producerNode: string,
	consumerNode: string,
	handoff: ArtifactHandoffContract,
): GraphEdge {
	return { id, from: producerNode, to: consumerNode, type: "PRODUCES_ARTIFACT", handoff: structuredClone(handoff) };
}

export function graphNodeForTask(taskId: string): { id: string; task_id: string } {
	return { id: `node:${taskId}`, task_id: taskId };
}
