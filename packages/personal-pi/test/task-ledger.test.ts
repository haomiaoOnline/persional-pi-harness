import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { captureWorkspaceSnapshot, PersistentStateStore, type TaskContract, TaskStateMachine } from "../src/index.ts";
import { TaskLedger } from "../src/task-ledger.ts";

const temporaryDirectories: string[] = [];

// Frozen from /Users/chenglong/ai-proxy HEAD:ARCHITECTURE.md on 2026-09-18.
// These are the 44 real external project task identities required by T2.7-B.
const AI_PROXY_TASKS = [
	["T1.01", "初始化 Go 项目", "P0"],
	["T1.02", "配置结构定义与 YAML 加载", "P0"],
	["T1.03", "配置校验", "P0"],
	["T1.04", "模型名通配符匹配", "P0"],
	["T1.05", "KeyPool 实现", "P0"],
	["T1.06", "错误分类策略", "P0"],
	["T1.07", "Runtime 快照构造", "P0"],
	["T1.08", "HTTP Server + 中间件 + 鉴权", "P0"],
	["T1.09", "Dispatcher 调度器", "P0"],
	["T1.10", "GET /v1/models 实现", "P0"],
	["T1.11", "Proxy 转发: 构造上游请求", "P0"],
	["T1.12", "Proxy 转发: SSE 流式透传", "P0"],
	["T1.13", "POST /v1/chat/completions Handler", "P0"],
	["T1.14", "POST /v1/messages Handler", "P0"],
	["T1.15", "降级链路集成测试", "P0"],
	["T1.16", "Makefile + 交叉编译", "P0"],
	["T1.17", "README + config.example.yaml", "P0"],
	["T2.01", "Token 使用量采集", "P1"],
	["T2.02", "使用量内存存储与查询", "P1"],
	["T2.03", "GET /api/status 实现", "P1"],
	["T2.04", "GET /api/usage 实现", "P1"],
	["T2.05", "配置热重载", "P1"],
	["T2.06", "模型别名", "P1"],
	["T2.07", "Combo 组合路由", "P1"],
	["T2.08", "Web 管理台: 后端 API", "P1"],
	["T2.09", "Web 管理台: 前端", "P1"],
	["T3.01", "CLI 子命令框架", "P1"],
	["T3.02", "OAuth 基础框架", "P1"],
	["T3.03", "ChatGPT OAuth 登录", "P1"],
	["T3.04", "Claude OAuth 登录", "P1"],
	["T3.05", "Grok OAuth 登录", "P1"],
	["T3.06", "Gemini OAuth 登录", "P1"],
	["T3.07", "跨协议转换: Anthropic → OpenAI 请求", "P1"],
	["T3.08", "跨协议转换: OpenAI → Anthropic 请求", "P1"],
	["T3.09", "跨协议转换: 流式响应转换", "P1"],
	["T3.10", "跨协议降级集成测试", "P1"],
	["T4.01", "POST /v1/responses 端点", "P2"],
	["T4.02", "请求日志", "P2"],
	["T4.03", "额度 / 余额查询", "P2"],
	["T4.04", "Session Affinity", "P2"],
	["T4.05", "Docker 支持", "P2"],
	["T4.06", "macOS 菜单栏脚本", "P2"],
	["T4.07", "敏感数据过滤", "P2"],
	["T4.08", "SQLite 统计持久化", "P2"],
] as const;

function temporaryStatePath(): string {
	const root = mkdtempSync(join(tmpdir(), "personal-pi-task-ledger-"));
	temporaryDirectories.push(root);
	return join(root, "state.json");
}

function task(id: string, title = `Task ${id}`): TaskContract {
	return {
		id,
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title,
		objective: "Provide a verified result",
		requirements: [],
		constraints: [],
		scope: { files: [`src/${id}.ts`] },
		role_profile_ref: "backend-engineer",
		inputs: {},
		data_sources: [],
		data_references: [],
		permissions: {
			filesystem: { read: ["."], write: [] },
			shell: { allowed: [] },
			network: "deny",
			credentials: "deny",
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "medium",
			capability_tags: [],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: [],
		acceptance_criteria: ["verification passes"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["worker_result"],
			evidence_required: [],
			strength: "strong",
			recipe_ref: "api-service",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2_000 } },
		risk: "low",
		priority: "P0",
		timeout: 30_000,
		retry_policy: { max_attempts: 1, backoff: 0 },
		approval: { required: false },
	};
}

function addProject(store: PersistentStateStore, projectId = "project-a"): void {
	store.addProject({
		project_id: projectId,
		repo_path: `/tmp/${projectId}`,
		baseline_commit: "0123456789012345678901234567890123456789",
		architecture_doc_ref: "docs/architecture.md",
		task_ledger_ref: "docs/tasks.md",
	});
}

function bind(ledger: TaskLedger, projectTaskId: string, pphTaskId: string, phase = "P0") {
	return ledger.bind({
		project_id: "project-a",
		project_task_id: projectTaskId,
		pph_task_id: pphTaskId,
		phase,
		unknowns: [],
	});
}

afterEach(() => {
	while (temporaryDirectories.length > 0)
		rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("T2.7-B Task Ledger", () => {
	test("imports 44 project task mappings with stable bidirectional lookup and restart", () => {
		const statePath = temporaryStatePath();
		const store = new PersistentStateStore(statePath);
		addProject(store);
		const ledger = new TaskLedger(store);

		expect(AI_PROXY_TASKS).toHaveLength(44);
		for (const [projectTaskId, title, phase] of AI_PROXY_TASKS) {
			const pphTaskId = `ai-proxy-${projectTaskId.toLowerCase().replace(".", "-")}`;
			store.createTask(task(pphTaskId, title));
			bind(ledger, projectTaskId, pphTaskId, phase);
		}

		const entries = ledger.listProject("project-a");
		expect(entries).toHaveLength(44);
		expect(new Set(entries.map((entry) => entry.project_task_id)).size).toBe(44);
		expect(new Set(entries.map((entry) => entry.pph_task_id)).size).toBe(44);
		for (const [projectTaskId, title, phase] of AI_PROXY_TASKS) {
			const expectedPphId = `ai-proxy-${projectTaskId.toLowerCase().replace(".", "-")}`;
			const forward = ledger.resolveByProjectTask("project-a", projectTaskId);
			expect(forward.pph_task_id).toBe(expectedPphId);
			expect(forward.phase).toBe(phase);
			expect(store.getTask(expectedPphId)?.title).toBe(title);
			expect(ledger.resolveByPphTask(expectedPphId).project_task_id).toBe(projectTaskId);
		}

		const restarted = new TaskLedger(new PersistentStateStore(statePath));
		expect(restarted.listProject("project-a")).toHaveLength(44);
		expect(restarted.resolveByProjectTask("project-a", "T4.08").pph_task_id).toBe("ai-proxy-t4-08");
	});

	test("rejects duplicate forward/reverse mappings and dangling references", () => {
		const store = new PersistentStateStore();
		addProject(store);
		store.createTask(task("pph-a"));
		store.createTask(task("pph-b"));
		const ledger = new TaskLedger(store);
		bind(ledger, "T1.01", "pph-a");

		expect(() => bind(ledger, "T1.01", "pph-b")).toThrow("project task already bound");
		expect(() => bind(ledger, "T1.02", "pph-a")).toThrow("pph task already bound");
		expect(() => bind(ledger, "T1.03", "missing-task")).toThrow("unknown task");
		expect(() =>
			ledger.bind({
				project_id: "missing-project",
				project_task_id: "T1.04",
				pph_task_id: "pph-b",
				phase: "P0",
				unknowns: [],
			}),
		).toThrow("unknown project");
	});

	test("projects canonical task/evidence state instead of storing independent completion status", () => {
		const store = new PersistentStateStore();
		addProject(store);
		let record = store.createTask(task("pph-state"));
		const ledger = new TaskLedger(store);
		bind(ledger, "T2.01", record.id);
		const machine = new TaskStateMachine();
		record = store.updateTask(machine.transition(record, "READY"));

		store.saveEvidence({
			id: "evidence-1",
			task_id: record.id,
			run_id: "run-evidence",
			captured_at: "2026-09-18T00:00:00.000Z",
			diff: { files: [], digest: "diff" },
			commands: [],
			stdout: "",
			stderr: "",
			artifacts: [],
			evidence_types: [],
		});

		const view = ledger.resolveByProjectTask("project-a", "T2.01");
		expect(view.status).toBe("READY");
		expect(view.gate_status).toBe("PENDING");
		expect(view.task_revision).toBe(1);
		expect(view.owner).toBe("backend-engineer");
		expect(view.scope).toEqual(["src/pph-state.ts"]);
		expect(view.verification_recipe).toBe("api-service");
		expect(view.evidence_refs).toEqual(["evidence-1"]);
		expect(view).toHaveProperty("unknowns");
	});

	test("cannot persist Agent-claimed DONE without Acceptance and Verification PASS", () => {
		const store = new PersistentStateStore();
		addProject(store);
		let record = store.createTask(task("pph-no-self-done"));
		const ledger = new TaskLedger(store);
		bind(ledger, "T3.01", record.id);
		const machine = new TaskStateMachine();
		record = store.updateTask(machine.transition(record, "READY"));
		record = store.updateTask(machine.transition(record, "RUNNING"));
		record = store.updateTask(machine.transition(record, "VERIFYING"));
		const claimedDone = machine.transition(record, "DONE", "Agent says complete");

		expect(() => store.updateTask(claimedDone)).toThrow("DONE must be persisted through acceptTask");
		expect(() =>
			store.transact((state) => {
				const taskRecord = state.tasks.find((candidate) => candidate.id === record.id);
				if (taskRecord) taskRecord.state = "DONE";
			}),
		).toThrow("missing a current-revision AcceptanceRecord");
		expect(store.getTask(record.id)?.state).toBe("VERIFYING");
		expect(ledger.resolveByPphTask(record.id).gate_status).toBe("PENDING");
	});

	test("persists DONE only through matching persisted PASS, result and workspace snapshot", () => {
		const store = new PersistentStateStore();
		addProject(store);
		let record = store.createTask(task("pph-accepted"));
		const ledger = new TaskLedger(store);
		bind(ledger, "T4.01", record.id);
		const machine = new TaskStateMachine();
		record = store.updateTask(machine.transition(record, "READY"));
		record = store.updateTask(machine.transition(record, "RUNNING"));
		const run = store.createRun(record.id, "worker-1", 1, "2026-09-18T00:00:00.000Z");
		store.saveResult({
			task_id: record.id,
			run_id: run.id,
			worker_id: "worker-1",
			lease_epoch: 1,
			status: "success",
			summary: "verified no-op",
			changed_files: [],
			artifacts: [],
			evidence: [],
			errors: [],
			work_receipt: {
				work_attempted: true,
				effects_count: 0,
				artifacts_created: [],
				state_changed: false,
				no_op: true,
				no_op_reason: "nothing needed",
				evidence_refs: [],
			},
		});
		record = store.updateTask(machine.transition(record, "VERIFYING"));
		const snapshot = captureWorkspaceSnapshot("commit-1", [], []);
		store.saveVerification({
			id: "verification-pass",
			task_id: record.id,
			status: "PASS",
			verification_confidence: "strong",
			task_revision: record.task_revision,
			commit_hash: snapshot.commit_hash,
			diff_digest: snapshot.diff_digest,
			artifact_digest: snapshot.artifact_digest,
			checked_at: "2026-09-18T00:01:00.000Z",
			checks: ["worker_result"],
			reasons: [],
		});

		expect(() =>
			store.acceptTask(record.id, "verification-pass", run.id, captureWorkspaceSnapshot("commit-changed", [], [])),
		).toThrow("invalidated");
		expect(store.getTask(record.id)?.state).toBe("VERIFYING");

		const accepted = store.acceptTask(record.id, "verification-pass", run.id, snapshot);
		expect(accepted.task.state).toBe("DONE");
		expect(accepted.acceptance.task_revision).toBe(record.task_revision);
		expect(store.read().acceptances).toEqual([accepted.acceptance]);
		expect(ledger.resolveByPphTask(record.id).status).toBe("DONE");
		expect(ledger.resolveByPphTask(record.id).gate_status).toBe("PASS");
	});
});
