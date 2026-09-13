import type { EdgeType, GraphEdge, GraphMutation, GraphNode, TaskGraph } from "./types.ts";

export class GraphCycleError extends Error {
	readonly cycle: string[];

	constructor(cycle: string[]) {
		super(`graph mutation would create a cycle: ${cycle.join(" -> ")}`);
		this.name = "GraphCycleError";
		this.cycle = cycle;
	}
}

export class GraphMutationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphMutationError";
	}
}

function cloneGraph(graph: TaskGraph): TaskGraph {
	return {
		revision: graph.revision,
		nodes: graph.nodes.map((node) => ({ ...node })),
		edges: graph.edges.map((edge) => ({
			...edge,
			handoff: edge.handoff ? structuredClone(edge.handoff) : undefined,
		})),
	};
}

function findCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[] | undefined {
	const nodeIds = new Set(nodes.map((node) => node.id));
	const adjacency = new Map<string, string[]>();
	for (const nodeId of nodeIds) adjacency.set(nodeId, []);
	for (const edge of edges) {
		const targets = adjacency.get(edge.from);
		if (targets) targets.push(edge.to);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const path: string[] = [];
	const visit = (nodeId: string): string[] | undefined => {
		if (visiting.has(nodeId)) {
			const cycleStart = path.indexOf(nodeId);
			return [...path.slice(cycleStart), nodeId];
		}
		if (visited.has(nodeId)) return undefined;
		visiting.add(nodeId);
		path.push(nodeId);
		for (const target of adjacency.get(nodeId) ?? []) {
			const cycle = visit(target);
			if (cycle) return cycle;
		}
		path.pop();
		visiting.delete(nodeId);
		visited.add(nodeId);
		return undefined;
	};

	for (const nodeId of nodeIds) {
		const cycle = visit(nodeId);
		if (cycle) return cycle;
	}
	return undefined;
}

function assertGraphValid(graph: TaskGraph): void {
	const nodeIds = new Set<string>();
	for (const node of graph.nodes) {
		if (nodeIds.has(node.id)) throw new GraphMutationError(`duplicate graph node: ${node.id}`);
		nodeIds.add(node.id);
	}
	const edgeIds = new Set<string>();
	for (const edge of graph.edges) {
		if (edgeIds.has(edge.id)) throw new GraphMutationError(`duplicate graph edge: ${edge.id}`);
		edgeIds.add(edge.id);
		if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
			throw new GraphMutationError(`edge ${edge.id} references an unknown node`);
		}
		if (edge.type === "PRODUCES_ARTIFACT" && !edge.handoff) {
			// v2.0 允许旧的普通产物边；绑定校验只在 handoff 存在时启用。
			continue;
		}
		if (edge.handoff && edge.type !== "PRODUCES_ARTIFACT") {
			throw new GraphMutationError("artifact handoff is only valid on PRODUCES_ARTIFACT edges");
		}
	}
	const cycle = findCycle(graph.nodes, graph.edges);
	if (cycle) throw new GraphCycleError(cycle);
}

export class TaskGraphStore {
	private graph: TaskGraph;

	constructor(initial?: TaskGraph) {
		this.graph = cloneGraph(initial ?? { revision: 0, nodes: [], edges: [] });
		assertGraphValid(this.graph);
	}

	read(): TaskGraph {
		return cloneGraph(this.graph);
	}

	applyMutation(mutation: GraphMutation, beforeCommit?: (candidate: TaskGraph) => void): TaskGraph {
		const candidate = cloneGraph(this.graph);
		candidate.nodes.push(...mutation.nodes.map((node) => ({ ...node })));
		candidate.edges.push(
			...mutation.edges.map((edge) => ({
				...edge,
				handoff: edge.handoff ? structuredClone(edge.handoff) : undefined,
			})),
		);
		candidate.revision += 1;
		assertGraphValid(candidate);
		// 钩子在真正替换当前图之前执行；抛错时当前图完全不变，模拟事务回滚。
		beforeCommit?.(cloneGraph(candidate));
		this.graph = candidate;
		return this.read();
	}

	addNode(node: GraphNode): TaskGraph {
		return this.applyMutation({ nodes: [node], edges: [] });
	}

	addEdge(edge: GraphEdge): TaskGraph {
		return this.applyMutation({ nodes: [], edges: [edge] });
	}

	topologicalOrder(): string[] {
		const graph = this.read();
		const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
		for (const edge of graph.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
		const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
		const ordered: string[] = [];
		while (ready.length > 0) {
			const current = ready.shift();
			if (!current) continue;
			ordered.push(current);
			for (const edge of graph.edges.filter((candidate) => candidate.from === current)) {
				const next = (indegree.get(edge.to) ?? 0) - 1;
				indegree.set(edge.to, next);
				if (next === 0) ready.push(edge.to);
			}
		}
		if (ordered.length !== graph.nodes.length) throw new GraphCycleError([...ordered]);
		return ordered;
	}
}

export function createGraphEdge(id: string, from: string, to: string, type: EdgeType): GraphEdge {
	return { id, from, to, type };
}
