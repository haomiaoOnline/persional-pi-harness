import type { ArtifactStore } from "./artifacts.ts";
import { validateTaskContract } from "./schema.ts";
import type { GraphEdge, ReadinessEvaluation, TaskContract } from "./types.ts";

export interface DefinitionOfReadyInput {
	dependencies_ready: boolean;
	artifact_edges: readonly GraphEdge[];
	artifact_store?: ArtifactStore;
}

export function evaluateDefinitionOfReady(
	task: TaskContract,
	dependenciesReady: boolean,
	artifactEdges: readonly GraphEdge[] = [],
	artifactStore?: ArtifactStore,
): ReadinessEvaluation {
	const validation = validateTaskContract(task);
	if (!validation.valid) {
		return { ready: false, state: "NOT_READY", reasons: validation.errors };
	}
	if (task.acceptance_criteria.length === 0) {
		return {
			ready: false,
			state: "NOT_READY",
			reasons: ["/acceptance_criteria: must contain at least one criterion"],
		};
	}
	if (!dependenciesReady) return { ready: false, state: "BLOCKED", reasons: ["dependencies are not satisfied"] };
	if (task.artifact_dependencies.length > 0 && artifactEdges.length === 0) {
		return {
			ready: false,
			state: "BLOCKED",
			reasons: ["artifact readiness inputs are required for declared artifact dependencies"],
		};
	}
	if (artifactEdges.length > 0 && !artifactStore) {
		return { ready: false, state: "BLOCKED", reasons: ["artifact store is required for handoff validation"] };
	}
	for (const edge of artifactEdges) {
		if (!edge.handoff || !artifactStore) continue;
		const handoff = artifactStore.checkHandoff(edge, edge.handoff);
		if (!handoff.ready) return handoff;
	}
	return { ready: true, state: "READY", reasons: [] };
}
