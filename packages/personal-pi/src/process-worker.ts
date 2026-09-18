import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSanitizedEnvironment } from "./adapters/cli-runtime.ts";
import { createModelIdentity } from "./result.ts";
import type {
	JsonValue,
	ResolvedContext,
	WorkerExecutionControls,
	WorkerExecutionInput,
	WorkerExecutionOutput,
	WorkerProtocolRequest,
} from "./types.ts";
import { PiWorker } from "./worker.ts";

export interface WorkerProcessSnapshot {
	adapter_id: string;
	pid: number | null;
	session_id: string;
	session_id_sha256: string;
	workspace_path: string;
	alive: boolean;
}

export interface WorkerProcessLifecycle {
	readonly worker_instance_id: string;
	readonly adapter_id: string;
	readonly workspace_path: string;
	readonly session_id: string;
	start(): Promise<WorkerProcessSnapshot>;
	stop(): Promise<void>;
	crash(): Promise<void>;
	isAlive(): boolean;
	snapshot(): WorkerProcessSnapshot;
}

export interface ProcessWorkerAdapterOptions {
	worker_id: string;
	worker_instance_id?: string;
	adapter_id: string;
	workspace_path: string;
	script_path?: string;
	command?: string;
	timeout_ms?: number;
	session_id?: string;
}

interface ProcessReadyMessage {
	type: "ready";
	pid: number;
	session_id_sha256: string;
}

interface ProcessResultMessage {
	type: "result";
	request_id: string;
	output: WorkerExecutionOutput;
}

type ProcessMessage = ProcessReadyMessage | ProcessResultMessage;

class ProcessWorkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProcessWorkerError";
	}
}

function sessionDigest(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function terminateProcess(child: ChildProcessWithoutNullStreams): void {
	if (child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// A process group may be unavailable for a test double or an already exited child.
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// The child may already have exited.
	}
}

function _asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function failureOutput(message: string): WorkerExecutionOutput {
	return {
		status: "failure",
		summary: "process Worker execution failed",
		changed_files: [],
		artifacts: [],
		evidence: [],
		errors: [message],
		work_receipt: {
			work_attempted: true,
			effects_count: 0,
			artifacts_created: [],
			state_changed: false,
			no_op: false,
			evidence_refs: [],
		},
	};
}

/**
 * A real Level-B Worker instance: one adapter owns one long-lived OS process,
 * one opaque session handle, and one workspace. The child speaks only the
 * business execution payload; lease and run metadata stay in the parent.
 */
export class ProcessWorkerAdapter implements WorkerProcessLifecycle {
	readonly worker_id: string;
	readonly requested_model = "unknown";
	readonly worker_instance_id: string;
	readonly adapter_id: string;
	readonly workspace_path: string;
	readonly session_id: string;
	private readonly scriptPath: string;
	private readonly command: string;
	private readonly timeoutMs: number;
	private child?: ChildProcessWithoutNullStreams;
	private processPid: number | null = null;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readyPromise?: Promise<WorkerProcessSnapshot>;
	private readyResolve?: (snapshot: WorkerProcessSnapshot) => void;
	private readyReject?: (error: Error) => void;
	private exitPromise?: Promise<void>;
	private exitResolve?: () => void;
	private pending?: {
		requestId: string;
		resolve: (output: WorkerExecutionOutput) => void;
		timer: NodeJS.Timeout;
	};

	constructor(options: ProcessWorkerAdapterOptions) {
		if (!options.worker_id) throw new ProcessWorkerError("worker_id must not be empty");
		if (!options.adapter_id) throw new ProcessWorkerError("adapter_id must not be empty");
		if (!options.workspace_path) throw new ProcessWorkerError("workspace_path must not be empty");
		if (options.timeout_ms !== undefined && options.timeout_ms < 1)
			throw new ProcessWorkerError("timeout_ms must be positive");
		this.worker_id = options.worker_id;
		this.worker_instance_id = options.worker_instance_id ?? options.worker_id;
		this.adapter_id = options.adapter_id;
		this.workspace_path = options.workspace_path;
		this.session_id = options.session_id ?? randomUUID();
		this.scriptPath =
			options.script_path ?? fileURLToPath(new URL("../scripts/level-b-worker-process.mjs", import.meta.url));
		this.command = options.command ?? process.execPath;
		this.timeoutMs = options.timeout_ms ?? 30_000;
		mkdirSync(this.workspace_path, { recursive: true });
	}

	async start(): Promise<WorkerProcessSnapshot> {
		if (this.isAlive() && this.readyPromise) return this.readyPromise;
		if (this.child) throw new ProcessWorkerError(`${this.worker_id} is stopping`);

		const environment = createSanitizedEnvironment();
		environment.PPH_WORKER_ADAPTER_ID = this.adapter_id;
		environment.PPH_WORKER_INSTANCE_ID = this.worker_instance_id;
		environment.PPH_WORKER_SESSION_ID = this.session_id;
		environment.PPH_WORKER_WORKSPACE = this.workspace_path;
		const child = spawn(this.command, [this.scriptPath], {
			cwd: this.workspace_path,
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessWithoutNullStreams;
		this.child = child;
		this.processPid = child.pid ?? null;
		this.stdoutBuffer = "";
		this.stderrBuffer = "";
		this.exitPromise = new Promise<void>((resolve) => {
			this.exitResolve = resolve;
		});
		this.readyPromise = new Promise<WorkerProcessSnapshot>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		child.stdout.on("data", (chunk: Buffer | string) =>
			this.handleStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
		);
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderrBuffer = `${this.stderrBuffer}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.slice(
				-4_096,
			);
		});
		child.once("error", (error) => this.failProcess(new ProcessWorkerError(errorMessage(error))));
		child.once("close", (code, signal) => {
			const detail = this.stderrBuffer.trim();
			const reason = detail || `child exited code=${code ?? "null"} signal=${signal ?? "none"}`;
			if (this.readyReject) this.readyReject(new ProcessWorkerError(`${this.worker_id} failed to start: ${reason}`));
			this.readyResolve = undefined;
			this.readyReject = undefined;
			if (this.pending) {
				clearTimeout(this.pending.timer);
				this.pending.resolve(failureOutput(`${this.worker_id} process exited: ${reason}`));
				this.pending = undefined;
			}
			this.child = undefined;
			this.processPid = null;
			this.readyPromise = undefined;
			this.exitResolve?.();
			this.exitResolve = undefined;
		});
		return this.readyPromise;
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		try {
			if (child.exitCode === null && child.stdin.writable)
				child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
		} catch {
			// The child may already be closing; the exit wait below remains authoritative.
		}
		await this.waitForExit(1_000);
	}

	async crash(): Promise<void> {
		const child = this.child;
		if (!child) return;
		terminateProcess(child);
		await this.waitForExit(1_000);
	}

	isAlive(): boolean {
		return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
	}

	snapshot(): WorkerProcessSnapshot {
		const digest = sessionDigest(this.session_id);
		return {
			adapter_id: this.adapter_id,
			pid: this.isAlive() ? this.processPid : null,
			session_id: `local-session:${digest}`,
			session_id_sha256: digest,
			workspace_path: this.workspace_path,
			alive: this.isAlive(),
		};
	}

	getModelIdentity() {
		return createModelIdentity(this.requested_model);
	}

	async execute(request: WorkerProtocolRequest, controls?: WorkerExecutionControls) {
		const delegate = new PiWorker(
			this.worker_id,
			(input) => this.executeInProcess(request, input),
			this.requested_model,
		);
		return delegate.execute(request, controls);
	}

	private async executeInProcess(
		_request: WorkerProtocolRequest,
		input: WorkerExecutionInput,
	): Promise<WorkerExecutionOutput> {
		try {
			await this.start();
			const output = await this.send({
				type: "execute",
				request_id: randomUUID(),
				prompt: input.prompt,
				resolved_context: input.resolved_context,
				workspace_path: this.workspace_path,
			});
			return {
				...output,
				evidence: [
					...(output.evidence ?? []),
					`${this.adapter_id}:process_pid=${this.processPid ?? "unknown"}`,
					`${this.adapter_id}:session_id_sha256=${sessionDigest(this.session_id)}`,
					`${this.adapter_id}:workspace=${this.workspace_path}`,
				],
			};
		} catch (error) {
			return failureOutput(errorMessage(error));
		}
	}

	private send(message: {
		type: "execute";
		request_id: string;
		prompt: WorkerExecutionInput["prompt"];
		resolved_context?: ResolvedContext;
		workspace_path: string;
	}): Promise<WorkerExecutionOutput> {
		if (!this.child || !this.isAlive() || !this.child.stdin.writable)
			return Promise.reject(new ProcessWorkerError(`${this.worker_id} process is not alive`));
		if (this.pending)
			return Promise.reject(new ProcessWorkerError(`${this.worker_id} does not support concurrent requests`));
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending = undefined;
				if (this.child) terminateProcess(this.child);
				resolve({
					...failureOutput(`process Worker timed out after ${this.timeoutMs}ms`),
					status: "timeout",
				});
			}, this.timeoutMs);
			this.pending = { requestId: message.request_id, resolve, timer };
			try {
				this.child?.stdin.write(`${JSON.stringify(message)}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending = undefined;
				resolve(failureOutput(errorMessage(error)));
			}
		});
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		while (true) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				this.handleMessage(JSON.parse(line) as ProcessMessage);
			} catch (error) {
				this.failProcess(new ProcessWorkerError(`invalid process message: ${errorMessage(error)}`));
			}
		}
	}

	private handleMessage(message: ProcessMessage): void {
		if (message.type === "ready") {
			this.processPid = message.pid;
			const expected = sessionDigest(this.session_id);
			if (message.session_id_sha256 !== expected) {
				this.failProcess(new ProcessWorkerError(`${this.worker_id} session handshake mismatch`));
				return;
			}
			this.readyResolve?.(this.snapshot());
			this.readyResolve = undefined;
			this.readyReject = undefined;
			return;
		}
		if (!this.pending || message.request_id !== this.pending.requestId) return;
		clearTimeout(this.pending.timer);
		this.pending.resolve(message.output);
		this.pending = undefined;
	}

	private failProcess(error: Error): void {
		this.readyReject?.(error);
		this.readyResolve = undefined;
		this.readyReject = undefined;
		if (this.pending) {
			clearTimeout(this.pending.timer);
			this.pending.resolve(failureOutput(error.message));
			this.pending = undefined;
		}
		if (this.child) terminateProcess(this.child);
	}

	private async waitForExit(timeoutMs: number): Promise<void> {
		if (!this.child || !this.exitPromise) return;
		const exit = this.exitPromise;
		await Promise.race([
			exit,
			new Promise<void>((resolve) => {
				setTimeout(() => {
					if (this.child) terminateProcess(this.child);
					resolve();
				}, timeoutMs);
			}),
		]);
	}
}
