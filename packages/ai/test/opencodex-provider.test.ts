import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { opencodexProvider } from "../src/providers/opencodex.ts";

let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve, reject) => {
		server?.close((error) => (error ? reject(error) : resolve()));
	});
	server = undefined;
});

async function serveModels(body: unknown): Promise<string> {
	server = createServer((_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
	return `http://127.0.0.1:${address.port}/v1`;
}

describe("OpenCodex provider", () => {
	it("refreshes models from the local OpenCodex model endpoint", async () => {
		const baseUrl = await serveModels({
			data: [
				{
					id: "gpt-6-astra",
					owned_by: "openai",
					supports_reasoning_effort: true,
					reasoning_efforts: [{ value: "low" }, { value: "high" }, { value: "max" }, { value: "ultra" }],
					capabilities: {
						context_length: 872000,
						input_modalities: ["text", "image"],
						supports_reasoning: true,
					},
				},
			],
		});
		const provider = opencodexProvider({ baseUrl });

		await provider.refreshModels?.({
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});

		expect(provider.getModels()).toEqual([
			expect.objectContaining({
				id: "gpt-6-astra",
				name: "gpt-6-astra (openai)",
				provider: "opencodex",
				api: "openai-completions",
				baseUrl,
				input: ["text", "image"],
				reasoning: true,
				contextWindow: 872000,
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
			}),
		]);
	});
});
