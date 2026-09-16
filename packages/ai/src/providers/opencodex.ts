import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, ModelThinkingLevel } from "../types.ts";

const DEFAULT_OPENCODEX_BASE_URL = "http://127.0.0.1:10100/v1";
const DEFAULT_OPENCODEX_API_KEY = "opencodex-loopback";
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface OpenCodexProviderOptions {
	baseUrl?: string;
}

interface OpenCodexModelsResponse {
	data: OpenCodexModelEntry[];
}

interface OpenCodexModelEntry {
	id: string;
	owned_by?: string;
	supports_reasoning_effort?: boolean;
	reasoning_efforts?: { value?: string }[];
	capabilities?: {
		context_length?: number;
		input_modalities?: string[];
		supports_reasoning?: boolean;
	};
}

function opencodexApiKeyAuth(): ApiKeyAuth {
	return {
		name: "OpenCodex local API key",
		check: async ({ signal }) => {
			signal.throwIfAborted();
			return { type: "api_key", source: "local OpenCodex" };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			const ambient = await ctx.env("OPENCODEX_API_KEY");
			signal.throwIfAborted();
			return {
				auth: { apiKey: credential?.key ?? ambient ?? DEFAULT_OPENCODEX_API_KEY },
				source: credential?.key ? "stored credential" : ambient ? "OPENCODEX_API_KEY" : "local OpenCodex",
			};
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function parseModelEntry(value: unknown): OpenCodexModelEntry | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
	const efforts = Array.isArray(value.reasoning_efforts)
		? value.reasoning_efforts
				.filter(isRecord)
				.map((effort) => ({ value: typeof effort.value === "string" ? effort.value : undefined }))
		: undefined;
	return {
		id: value.id,
		owned_by: typeof value.owned_by === "string" ? value.owned_by : undefined,
		supports_reasoning_effort:
			typeof value.supports_reasoning_effort === "boolean" ? value.supports_reasoning_effort : undefined,
		reasoning_efforts: efforts,
		capabilities: capabilities
			? {
					context_length:
						typeof capabilities.context_length === "number" ? capabilities.context_length : undefined,
					input_modalities: parseStringArray(capabilities.input_modalities),
					supports_reasoning:
						typeof capabilities.supports_reasoning === "boolean" ? capabilities.supports_reasoning : undefined,
				}
			: undefined,
	};
}

function parseModelsResponse(value: unknown): OpenCodexModelsResponse {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Invalid OpenCodex models response");
	return { data: value.data.map(parseModelEntry).filter((entry): entry is OpenCodexModelEntry => !!entry) };
}

function thinkingLevelMap(entry: OpenCodexModelEntry): Partial<Record<ModelThinkingLevel, string | null>> | undefined {
	const values = new Set(
		entry.reasoning_efforts?.map((effort) => effort.value).filter((value): value is string => !!value),
	);
	if (values.size === 0) return undefined;
	const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
	for (const level of PI_THINKING_LEVELS) map[level] = values.has(level) ? level : null;
	return map;
}

function displayName(entry: OpenCodexModelEntry): string {
	return entry.owned_by ? `${entry.id} (${entry.owned_by})` : entry.id;
}

function toModel(entry: OpenCodexModelEntry, baseUrl: string): Model<"openai-completions"> {
	const input = entry.capabilities?.input_modalities?.includes("image")
		? (["text", "image"] as const)
		: (["text"] as const);
	const reasoning = entry.supports_reasoning_effort === true || entry.capabilities?.supports_reasoning === true;
	return {
		id: entry.id,
		name: displayName(entry),
		api: "openai-completions",
		provider: "opencodex",
		baseUrl,
		input: [...input],
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(entry) } : {}),
		contextWindow: entry.capabilities?.context_length ?? 128000,
		maxTokens: 32000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			sendSessionAffinityHeaders: true,
		},
	};
}

export function opencodexProvider(options: OpenCodexProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = options.baseUrl ?? DEFAULT_OPENCODEX_BASE_URL;
	return createProvider({
		id: "opencodex",
		name: "OpenCodex",
		baseUrl,
		auth: { apiKey: opencodexApiKeyAuth() },
		models: [],
		fetchModels: async ({ credential, signal }) => {
			const response = await fetch(new URL("models", `${baseUrl.replace(/\/$/u, "")}/`), {
				headers:
					credential?.type === "api_key" && credential.key
						? { authorization: `Bearer ${credential.key}` }
						: undefined,
				signal,
			});
			if (!response.ok) throw new Error(`OpenCodex models request failed: ${response.status}`);
			return parseModelsResponse(await response.json()).data.map((entry) => toModel(entry, baseUrl));
		},
		api: openAICompletionsApi(),
	});
}
