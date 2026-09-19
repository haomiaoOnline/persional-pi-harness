import { createHash, randomUUID } from "node:crypto";
import type {
	ArchitectureCommercialAssessment,
	DecisionRecord,
	DependencyComplexity,
	DispatchDecision,
	Parallelism,
	ParallelPlanHint,
	PlanApproval,
	PlanQualityChecklist,
	PlanQualityGateResult,
	Preclassification,
	PreclassifierIncident,
	ReasoningDepth,
	RequirementContract,
	RiskLevel,
	RiskPath,
	RoleProfile,
	TaskAssessment,
	TaskContract,
	Uncertainty,
	WorkerTier,
	WorkerType,
	Workload,
} from "./types.ts";

const HIGH_RISK_RULES = [
	{ signal: "database_migration", pattern: /\b(migration|migrate|schema change|数据库迁移|数据库变更|表结构)\b/i },
	{ signal: "permission_model", pattern: /\b(permission|authorization|authz|权限|授权|身份模型)\b/i },
	{ signal: "external_api", pattern: /\b(public api|external api|api|webhook|对外接口|公开接口|外部接口)\b/i },
	{
		signal: "production_deploy",
		pattern: /\b(production deploy|deploy to prod|deploy to production|发布生产|生产部署|上线)\b/i,
	},
	{ signal: "payment", pattern: /\b(payment|billing|charge|支付|收费|账单)\b/i },
	{ signal: "security", pattern: /\b(security|secret|credential|密钥|凭证|安全)\b/i },
];

const CAPABILITY_RULES = [
	{ tag: "browsing", pattern: /\b(browser|web|ui|网页|浏览器|页面)\b/i },
	{ tag: "math", pattern: /\b(math|calculation|analytics|data|统计|计算|数据)\b/i },
	{ tag: "tool_use", pattern: /\b(shell|cli|tool|command|脚本|工具|命令)\b/i },
	{ tag: "coding", pattern: /\.(ts|tsx|js|jsx|py|go|rs|java|css|html)\b|\b(code|coding|实现|代码)\b/i },
];

function normalizedInput(description: string, files: readonly string[]): string {
	return `${description}\n${files.join("\n")}`;
}

export function extractRiskSignals(description: string, files: readonly string[] = []): string[] {
	const input = normalizedInput(description, files);
	return HIGH_RISK_RULES.filter((rule) => rule.pattern.test(input)).map((rule) => rule.signal);
}

export function extractCapabilityTags(description: string, files: readonly string[] = []): string[] {
	const input = normalizedInput(description, files);
	const tags = CAPABILITY_RULES.filter((rule) => rule.pattern.test(input)).map((rule) => rule.tag);
	if (files.length > 10 || description.length > 2_000) tags.push("long_context");
	return [...new Set(tags)];
}

export interface PreclassifierInput {
	description: string;
	files?: string[];
	history_success_rate?: number;
	ambiguous?: boolean;
	forced_slow_signals?: readonly string[];
}

export function preclassifyTask(input: PreclassifierInput): Preclassification {
	const files = input.files ?? [];
	const signals = extractRiskSignals(input.description, files);
	const forcedSignals = new Set(input.forced_slow_signals ?? []);
	const forced = signals.find((signal) => forcedSignals.has(signal));
	const reasons: string[] = [];
	if (signals.length > 0) reasons.push(`high-risk signals: ${signals.join(", ")}`);
	if (forced) reasons.push(`forced SLOW after repeated false negative: ${forced}`);
	if (input.ambiguous) reasons.push("task description is ambiguous");
	if (files.length > 10) reasons.push("large file scope");
	if (input.history_success_rate !== undefined && input.history_success_rate < 0.8) {
		reasons.push("historical success rate is below 0.8");
	}
	const path: RiskPath = reasons.length > 0 ? "SLOW" : "FAST";
	return {
		path,
		reasons: reasons.length > 0 ? reasons : ["small, bounded task with no high-risk signal"],
		matched_signals: signals,
		confidence: path === "SLOW" ? 0.99 : 0.95,
	};
}

export class PreclassifierIncidentTracker {
	private readonly incidents: PreclassifierIncident[] = [];
	private readonly counts = new Map<string, number>();
	private readonly forcedSlowSignals = new Set<string>();

	recordFalseNegative(
		taskId: string,
		missedSignal: string,
		correction = `force ${missedSignal} tasks onto SLOW`,
		at = new Date().toISOString(),
	): PreclassifierIncident {
		const incident: PreclassifierIncident = {
			task_id: taskId,
			predicted_path: "FAST",
			missed_signal: missedSignal,
			correction,
			at,
		};
		this.incidents.push(incident);
		const count = (this.counts.get(missedSignal) ?? 0) + 1;
		this.counts.set(missedSignal, count);
		if (count >= 2) this.forcedSlowSignals.add(missedSignal);
		return { ...incident };
	}

	list(): PreclassifierIncident[] {
		return this.incidents.map((incident) => ({ ...incident }));
	}

	forcedSignals(): string[] {
		return [...this.forcedSlowSignals].sort();
	}
}

export interface AssessmentSuggestion {
	workload?: Workload;
	risk?: RiskLevel;
	uncertainty?: Uncertainty;
	dependency?: DependencyComplexity;
	parallelism?: Parallelism;
	verification?: TaskAssessment["verification"];
	confidence?: number;
	parallel_plan_hint?: ParallelPlanHint;
}

function normalizedWorkUnitLabel(value: string): string {
	return value.replace(/^\s*(?:[-*•]|\d+[.)、]|[（(]\d+[）)])\s*/, "").trim();
}

function explicitFilePaths(value: string): string[] {
	return value.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g) ?? [];
}

function hasDeterministicWriteConflict(description: string, candidates: readonly string[]): boolean {
	const writeIntent = /\b(?:edit|write|modify|update|change)\b|(?:修改|编辑|写入|更新)/i;
	if (writeIntent.test(description) && /(?:同一|相同)(?:个)?文件/.test(description)) return true;
	const writePaths = candidates.flatMap((candidate) =>
		writeIntent.test(candidate) ? explicitFilePaths(candidate) : [],
	);
	return new Set(writePaths).size < writePaths.length;
}

export function deriveParallelPlanHint(description: string): ParallelPlanHint | undefined {
	if (!/(?:分别|逐个|每个|并行|独立|research|analy[sz]e|compare|调研|研究|比较)/i.test(description)) return undefined;
	const candidates = description
		.split(/\r?\n/)
		.map(normalizedWorkUnitLabel)
		.filter((line, index, lines) => {
			if (!line || line.length > 160) return false;
			const original = description.split(/\r?\n/)[index] ?? "";
			if (!/^\s*(?:[-*•]|\d+[.)、]|[（(]\d+[）)])\s*\S/.test(original)) return false;
			return lines.indexOf(line) === index;
		});
	if (candidates.length < 2) return undefined;
	if (hasDeterministicWriteConflict(description, candidates)) return undefined;
	return {
		independent_units: candidates.map((objective, index) => ({
			key: `unit-${index + 1}`,
			objective,
			source_scope: [],
		})),
		shared_context_refs: [],
		fan_in_required: true,
	};
}

function minimumRisk(signals: readonly string[]): RiskLevel {
	if (signals.includes("payment") || signals.includes("production_deploy") || signals.includes("security"))
		return "high";
	if (signals.length > 0) return "medium";
	return "low";
}

export function assessTask(
	description: string,
	files: readonly string[] = [],
	suggestion: AssessmentSuggestion = {},
): TaskAssessment {
	const input = normalizedInput(description, files);
	const signals = extractRiskSignals(description, files);
	const derivedRisk = minimumRisk(signals);
	const risk: RiskLevel =
		derivedRisk === "high" || suggestion.risk === "high"
			? "high"
			: derivedRisk === "medium" || suggestion.risk === "medium"
				? "medium"
				: "low";
	const workload =
		suggestion.workload ??
		(files.length > 10 || description.length > 2_000 ? "large" : files.length > 3 ? "medium" : "small");
	const uncertainty =
		suggestion.uncertainty ?? (/\b(unknown|uncertain|tbd|待确认|不确定|未知)\b/i.test(input) ? "high" : "low");
	const dependency =
		suggestion.dependency ??
		(/\b(depends|dependency|integration|integrate|migration|依赖|集成|迁移)\b/i.test(input) ? "complex" : "simple");
	const parallelPlanHint = suggestion.parallel_plan_hint ?? deriveParallelPlanHint(description);
	const parallelism =
		suggestion.parallelism ??
		(dependency === "simple" && (files.length > 1 || (parallelPlanHint?.independent_units.length ?? 0) > 1)
			? "eligible"
			: "ineligible");
	const verification = suggestion.verification ?? (risk === "high" ? "strong" : "strong");
	const confidence = suggestion.confidence ?? (uncertainty === "high" ? 0.55 : 0.9);
	const contextBudget = Math.max(2_000, 2_000 + files.length * 500 + Math.ceil(description.length / 4));
	return {
		scope: [...files],
		workload,
		risk,
		uncertainty,
		dependency,
		parallelism,
		verification,
		context_budget: contextBudget,
		confidence,
		capability_tags: extractCapabilityTags(description, files),
		...(parallelPlanHint ? { parallel_plan_hint: structuredClone(parallelPlanHint) } : {}),
	};
}

export function crossCheckAssessment(
	assessment: TaskAssessment,
	description: string,
	files: readonly string[] = [],
): TaskAssessment {
	const floor = minimumRisk(extractRiskSignals(description, files));
	const risk: RiskLevel =
		floor === "high" || assessment.risk === "high"
			? "high"
			: floor === "medium" || assessment.risk === "medium"
				? "medium"
				: "low";
	return { ...assessment, risk, scope: [...files], capability_tags: extractCapabilityTags(description, files) };
}

export function deriveReasoningDepth(
	assessment: Pick<TaskAssessment, "risk" | "uncertainty" | "workload" | "dependency" | "confidence" | "verification">,
	planEvaluation = false,
): ReasoningDepth {
	if (planEvaluation) return "extended";
	if (assessment.risk === "high" || assessment.dependency === "complex" || assessment.confidence < 0.6) return "high";
	if (assessment.risk === "medium" || assessment.verification === "weak") return "medium";
	if (assessment.uncertainty === "low" && assessment.workload === "small") return "low";
	return "medium";
}

function workerTierForRisk(risk: RiskLevel): WorkerTier {
	if (risk === "high") return "frontier";
	if (risk === "medium") return "standard";
	return "cheap";
}

export function createDispatchDecision(
	task: Pick<TaskContract, "execution" | "role_profile_ref">,
	assessment: TaskAssessment,
	roleProfile?: RoleProfile,
): DispatchDecision {
	const mode =
		assessment.workload === "large" || assessment.dependency === "complex"
			? "DECOMPOSE"
			: assessment.parallelism === "eligible"
				? "PARALLEL"
				: task.execution.mode === "batch"
					? "BATCH"
					: "SINGLE_WORKER";
	const roleReason = roleProfile ? ` role=${roleProfile.id} boundary applied` : " no role boundary requested";
	const candidateWorkerTypes: WorkerType[] = task.role_profile_ref ? ["pi"] : ["pi"];
	return {
		mode,
		worker_tier: workerTierForRisk(assessment.risk),
		reasoning_depth: deriveReasoningDepth(assessment),
		candidate_worker_types: candidateWorkerTypes,
		capability_tags: [...assessment.capability_tags],
		reason: `assessment risk=${assessment.risk}, workload=${assessment.workload}, dependency=${assessment.dependency};${roleReason}`,
	};
}

export function createDecisionRecord(
	decisionType: string,
	decision: string,
	reason: string,
	inputs: readonly string[],
	at = new Date().toISOString(),
): DecisionRecord {
	return { id: randomUUID(), decision_type: decisionType, decision, reason, inputs: [...inputs], at };
}

export function validateRequirementContract(value: unknown): value is RequirementContract {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	const requiredStrings = ["user", "delivery"];
	if (requiredStrings.some((field) => typeof candidate[field] !== "string" || candidate[field] === "")) return false;
	const requiredArrays = [
		"data_sources",
		"permission_location",
		"acceptance",
		"constraints",
		"unknowns",
		"sustainability",
		"non_functional",
		"commercialization",
	];
	return requiredArrays.every((field) => Array.isArray(candidate[field]));
}

export interface PlaybookEntry {
	id: string;
	task_types: string[];
	clauses: string[];
}

export class ReferenceArchitecturePlaybook {
	private readonly entries: PlaybookEntry[] = [];

	constructor(entries: readonly PlaybookEntry[] = []) {
		this.entries = entries.map((entry) => ({
			...entry,
			task_types: [...entry.task_types],
			clauses: [...entry.clauses],
		}));
	}

	add(entry: PlaybookEntry): void {
		this.entries.push({ ...entry, task_types: [...entry.task_types], clauses: [...entry.clauses] });
	}

	find(taskType: string): PlaybookEntry[] {
		return this.entries
			.filter((entry) => entry.task_types.includes(taskType))
			.map((entry) => ({ ...entry, task_types: [...entry.task_types], clauses: [...entry.clauses] }));
	}
}

export function assessArchitectureCommercial(
	requirement: RequirementContract,
	taskType: string,
	playbook: ReferenceArchitecturePlaybook,
): ArchitectureCommercialAssessment {
	const matches = playbook.find(taskType);
	const openRisks = [...requirement.unknowns];
	if (matches.length === 0) openRisks.push("无参考架构");
	return {
		scalability: requirement.non_functional.length > 0 ? "按非功能需求评估容量" : "容量需求尚未明确",
		security: requirement.permission_location.length > 0 ? "权限边界已声明，需按最小权限实现" : "权限定位不足",
		cost: requirement.commercialization.length > 0 ? "成本与商业路径已列入评估" : "成本假设待补充",
		extensibility: matches.length > 0 ? "复用 Playbook 条款并保留扩展边界" : "无现成扩展基线",
		testability: requirement.acceptance.length > 0 ? "按验收条款可自动化拆分验证" : "缺少可验证验收条款",
		business_viability: requirement.commercialization.length > 0 ? "存在待验证商业化假设" : "商业化路径未明确",
		confidence: matches.length > 0 && openRisks.length === 0 ? 0.85 : 0.65,
		open_risks: openRisks,
		playbook_refs: matches.map((entry) => entry.id),
	};
}

export function calculatePlanDigest(assessment: ArchitectureCommercialAssessment): string {
	return createHash("sha256").update(JSON.stringify(assessment)).digest("hex");
}

export function evaluatePlanQualityGate(
	assessment: ArchitectureCommercialAssessment,
	checklist: PlanQualityChecklist,
	approval?: PlanApproval,
	now = Date.now(),
): PlanQualityGateResult {
	const reasons: string[] = [];
	if (!checklist.technical_feasibility) reasons.push("technical feasibility checklist failed");
	if (!checklist.scalability) reasons.push("scalability checklist failed");
	if (!checklist.commercial_reasonableness) reasons.push("commercial reasonableness checklist failed");
	if (!checklist.testability) reasons.push("testability checklist failed");
	if (!approval) reasons.push("human approval is required before Task Graph creation");
	if (approval && approval.action_digest !== calculatePlanDigest(assessment))
		reasons.push("approval action_digest does not match assessment");
	if (approval && approval.bound_revision < 1) reasons.push("approval bound_revision must be positive");
	if (approval && Date.parse(approval.expires_at) <= now) reasons.push("approval has expired");
	return {
		passed: reasons.length === 0,
		checklist: { ...checklist },
		approval: approval ? { ...approval } : undefined,
		reasons,
	};
}
