import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RAW_RESULT_MAX_BYTES = 16 * 1024 * 1024;

export interface RawResultBackingDetails {
	fullOutputPath: string;
	fullOutputBytes: number;
}

export class RawResultLimitError extends Error {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Raw tool result exceeds the ${maxBytes}-byte safety cap; narrow the requested path, offset, or limit`);
		this.name = "RawResultLimitError";
		this.maxBytes = maxBytes;
	}
}

/** Bounded temp-file writer for the complete tool result before model-facing truncation. */
export class BoundedRawResultWriter {
	readonly path: string;
	private readonly maxBytes: number;
	private readonly chunks: Buffer[] = [];
	private bytes = 0;
	private finished = false;

	constructor(prefix: string, maxBytes = DEFAULT_RAW_RESULT_MAX_BYTES) {
		this.maxBytes = maxBytes;
		this.path = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
	}

	append(value: string | Buffer): void {
		if (this.finished) throw new Error("Raw result backing is already closed");
		const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
		if (this.bytes + buffer.length > this.maxBytes) {
			this.discard();
			throw new RawResultLimitError(this.maxBytes);
		}
		if (buffer.length > 0) this.chunks.push(Buffer.from(buffer));
		this.bytes += buffer.length;
	}

	get byteLength(): number {
		return this.bytes;
	}

	finish(): RawResultBackingDetails {
		if (this.finished) throw new Error("Raw result backing is already closed");
		this.finished = true;
		writeFileSync(this.path, Buffer.concat(this.chunks, this.bytes), { flag: "wx", mode: 0o600 });
		this.chunks.length = 0;
		return { fullOutputPath: this.path, fullOutputBytes: this.bytes };
	}

	discard(): void {
		this.finished = true;
		this.chunks.length = 0;
		rmSync(this.path, { force: true });
	}
}

export function persistBoundedRawResult(content: string, prefix: string): RawResultBackingDetails {
	const writer = new BoundedRawResultWriter(prefix);
	try {
		writer.append(content);
		return writer.finish();
	} catch (error) {
		if (!(error instanceof RawResultLimitError)) writer.discard();
		throw error;
	}
}
