import { randomUUID } from "node:crypto";
import type { NexpConfig, NexpThinkingLevel } from "./config.ts";
import { parseModelSpec } from "./config.ts";
import {
	buildConversationTranscript,
	buildPredictionUserPrompt,
	cleanPredictionOutput,
	PREDICTION_SYSTEM_PROMPT,
	type SessionEntryLike,
} from "./context.ts";

export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
}

export interface AssistantMessageLike {
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: string }>;
}

export interface ModelRegistryLike {
	find(provider: string, modelId: string): ModelLike | undefined;
	hasConfiguredAuth(model: ModelLike): boolean;
	streamSimple(
		model: ModelLike,
		context: {
			systemPrompt?: string;
			messages: Array<{
				role: "user";
				content: Array<{ type: "text"; text: string }>;
				timestamp: number;
			}>;
		},
		options?: {
			signal?: AbortSignal;
			cacheRetention?: "none" | "short" | "long";
			sessionId?: string;
			maxTokens?: number;
			reasoning?: Exclude<NexpThinkingLevel, "off">;
		},
	): { result(): Promise<AssistantMessageLike> };
}

export type ResolvedPredictionModel =
	| { ok: true; model: ModelLike; label: string; isFallback: boolean }
	| { ok: false; error: string };

export function resolvePredictionModel(
	config: NexpConfig,
	registry: Pick<ModelRegistryLike, "find" | "hasConfiguredAuth">,
	activeModel: ModelLike | undefined,
): ResolvedPredictionModel {
	if (config.model) {
		const spec = parseModelSpec(config.model);
		if (!spec) {
			return { ok: false, error: `Invalid configured model "${config.model}"` };
		}
		const found = registry.find(spec.provider, spec.modelId);
		if (!found) {
			return { ok: false, error: `Model "${config.model}" not found` };
		}
		if (!registry.hasConfiguredAuth(found)) {
			return { ok: false, error: `No auth configured for "${config.model}"` };
		}
		return { ok: true, model: found, label: `${found.provider}/${found.id}`, isFallback: false };
	}

	if (!activeModel) {
		return { ok: false, error: "No active session model" };
	}

	return {
		ok: true,
		model: activeModel,
		label: `${activeModel.provider}/${activeModel.id}`,
		isFallback: true,
	};
}

export function resolveReasoningOption(
	model: ModelLike,
	thinkingLevel: NexpThinkingLevel,
): Exclude<NexpThinkingLevel, "off"> | undefined {
	if (thinkingLevel === "off" || !model.reasoning) {
		return undefined;
	}
	return thinkingLevel;
}

export interface PredictOptions {
	config: NexpConfig;
	branch: readonly SessionEntryLike[];
	cwd: string;
	registry: ModelRegistryLike;
	activeModel: ModelLike | undefined;
	signal: AbortSignal;
	createSessionId?: () => string;
}

export type PredictResult =
	| { ok: true; prediction: string; modelLabel: string }
	| { ok: false; aborted?: boolean; error: string };

export async function predictNextPrompt(opts: PredictOptions): Promise<PredictResult> {
	const transcript = buildConversationTranscript(opts.branch, opts.config.maxContextChars);
	if (!transcript) {
		return { ok: false, error: "No conversation history to predict from" };
	}

	const resolved = resolvePredictionModel(opts.config, opts.registry, opts.activeModel);
	if (!resolved.ok) {
		return { ok: false, error: resolved.error };
	}

	const reasoning = resolveReasoningOption(resolved.model, opts.config.thinkingLevel);
	const userPrompt = buildPredictionUserPrompt(transcript, opts.cwd);
	const sessionId = (opts.createSessionId ?? randomUUID)();

	const streamOptions: {
		signal: AbortSignal;
		cacheRetention: "none";
		sessionId: string;
		maxTokens?: number;
		reasoning?: Exclude<NexpThinkingLevel, "off">;
	} = {
		signal: opts.signal,
		cacheRetention: "none",
		sessionId,
	};

	if (reasoning) {
		// Leave maxTokens unset when reasoning is enabled so provider thinking budgets are not starved.
		streamOptions.reasoning = reasoning;
	} else {
		streamOptions.maxTokens = 160;
	}

	try {
		const stream = opts.registry.streamSimple(
			resolved.model,
			{
				systemPrompt: PREDICTION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			streamOptions,
		);

		const response = await stream.result();
		if (opts.signal.aborted || response.stopReason === "aborted") {
			return { ok: false, aborted: true, error: "Prediction aborted" };
		}
		if (response.stopReason === "error") {
			return { ok: false, error: response.errorMessage || "Prediction request failed" };
		}

		const rawText = (response.content ?? [])
			.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");

		return {
			ok: true,
			prediction: cleanPredictionOutput(rawText),
			modelLabel: resolved.label,
		};
	} catch (error) {
		if (opts.signal.aborted) {
			return { ok: false, aborted: true, error: "Prediction aborted" };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}
