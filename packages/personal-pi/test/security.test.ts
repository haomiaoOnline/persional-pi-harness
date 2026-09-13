import { describe, expect, test } from "vitest";
import {
	authorizeWorkerExecution,
	DEFAULT_ROLE_PROFILES,
	evaluateTaskPermissions,
	filterSensitiveContext,
	PermissionDeniedError,
	PiWorker,
	type ResolvedContext,
	type TaskContract,
} from "../src/index.ts";

function makeTask(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		id: "security-task",
		schema_version: 2,
		task_revision: 1,
		graph_revision: 0,
		type: "cli",
		title: "Security task",
		objective: "Run within declared permissions",
		requirements: ["avoid privilege escalation"],
		constraints: [],
		scope: { files: ["src/service.ts"] },
		inputs: {},
		data_sources: ["repository"],
		data_references: [],
		permissions: {
			filesystem: { read: ["src"], write: ["src/output.ts"] },
			shell: { allowed: ["npm test"] },
			network: "deny",
			credentials: "deny",
			git: { allowed: ["status"] },
		},
		execution: {
			worker_type: "pi",
			worker_tier: "standard",
			reasoning_depth: "medium",
			capability_tags: ["coding"],
			mode: "single",
			working_directory: ".",
			allowed_tools: [],
		},
		dependencies: [],
		artifact_dependencies: [],
		expected_outputs: ["result"],
		acceptance_criteria: ["verification passes"],
		verification: {
			strategy: "automated",
			commands: [],
			checks: ["result"],
			evidence_required: ["stdout"],
			strength: "strong",
		},
		context: { required: [], optional: [], excluded: [], budget: { max_input_tokens: 2000 } },
		risk: "low",
		priority: "P1",
		timeout: 30000,
		retry_policy: { max_attempts: 2, backoff: 0 },
		approval: { required: false },
		...overrides,
	};
}

describe("T10.1–T10.2 permission contract and least privilege", () => {
	test("allows only the intersection of declared filesystem, shell, and git scopes", () => {
		const task = makeTask();
		const allowed = evaluateTaskPermissions(task, {
			filesystem: { read: ["src/service.ts"], write: ["src/output.ts"] },
			shell: ["npm test --run"],
			git: ["status --short"],
		});
		const denied = evaluateTaskPermissions(task, {
			filesystem: { read: ["private/key.txt"], write: ["src/other.ts"] },
			shell: ["npm publish"],
			network: true,
			git: ["push origin main"],
		});

		expect(allowed.allowed).toBe(true);
		expect(denied.allowed).toBe(false);
		expect(denied.reasons).toEqual(
			expect.arrayContaining([
				"filesystem read outside scope: private/key.txt",
				"filesystem write outside scope: src/other.ts",
				"shell command outside scope: npm publish",
				"network access is denied by Task Contract",
				"git action outside scope: push origin main",
			]),
		);
		expect(() => authorizeWorkerExecution(task, { network: true })).toThrow(PermissionDeniedError);
	});
});

describe("T10.3 sensitive context boundary", () => {
	test("redacts secret-shaped context by default and preserves it only on explicit authorization", () => {
		const context: ResolvedContext = {
			items: [
				{ digest: "fact", content: "safe fact", token_estimate: 3 },
				{ digest: "secret", content: "api_key=not-a-real-secret", token_estimate: 8 },
			],
			text: "safe fact\n\napi_key=not-a-real-secret",
			total_tokens: 11,
			cache_hit: false,
			omitted_optional: [],
			manifest_digest: "manifest",
		};
		const filtered = filterSensitiveContext(context);
		const authorized = filterSensitiveContext(context, true);

		expect(filtered.redacted_digests).toEqual(["secret"]);
		expect(filtered.context.text).not.toContain("not-a-real-secret");
		expect(filtered.security_event).toContain("redacted");
		expect(authorized.redacted_digests).toEqual([]);
		expect(authorized.context.text).toContain("not-a-real-secret");
	});

	test("does not let a Worker use a filesystem path outside the Task Contract", async () => {
		let executed = false;
		const worker = new PiWorker("pi-security", () => {
			executed = true;
			return { status: "success", summary: "should not execute" };
		});
		const result = await worker.execute({
			task: makeTask(),
			protocol: {
				task_id: "security-task",
				schema_version: 2,
				task_revision: 1,
				graph_revision: 0,
				lease_epoch: 1,
			},
			permission_request: { filesystem: { write: ["private/key.txt"] } },
		});

		expect(result.status).toBe("failure");
		expect(result.summary).toContain("DENIED");
		expect(executed).toBe(false);
	});
});

describe("T10.3 Role Profile upper bound", () => {
	test("rejects a payment Task against a role that forbids payment", () => {
		const role = DEFAULT_ROLE_PROFILES.find((candidate) => candidate.id === "backend-engineer");
		if (!role) throw new Error("default backend role missing");
		const task = makeTask({ role_profile_ref: role.id, type: "payment" });

		const decision = evaluateTaskPermissions(task, {}, role);

		expect(decision.allowed).toBe(false);
		expect(decision.reasons.join(" ")).toContain("payment");
	});

	test("rejects credential use when the role has no allowed service or scope", () => {
		const role = DEFAULT_ROLE_PROFILES.find((candidate) => candidate.id === "backend-engineer");
		if (!role) throw new Error("default backend role missing");
		const task = makeTask({
			role_profile_ref: role.id,
			permissions: { ...makeTask().permissions, credentials: "allow" },
		});

		const decision = evaluateTaskPermissions(
			task,
			{ credentials: true, credential_service: "payments", credential_scopes: ["write"] },
			role,
		);

		expect(decision.allowed).toBe(false);
		expect(decision.reasons.join(" ")).toContain("credential");
	});
});
