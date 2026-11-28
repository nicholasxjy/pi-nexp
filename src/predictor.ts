import { randomUUID } from "node:crypto";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { NexpConfig, NexpThinkingLevel } from "./config.ts";
import { parseModelSpec } from "./config.ts";
import {
	buildConversationTranscript,
	buildPredictionUserPrompt,
	cleanPredictionOutput,
	PREDICTION_SYSTEM_PROMPT,
	REUSE_PREDICTION_INSTRUCTION,
	type MessageLike,
} from "./context.ts";
import type { EffectivePredictionMode, FallbackReason, PredictionUsage } from "./stats.ts";

export const REUSE_SNAPSHOT_TTL_MS = 4 * 60 * 1000;

export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
}

export interface AssistantMessageLike {
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: {
			total?: number;
		};
	};
}

export interface ModelRegistryLike<TModel extends ModelLike = ModelLike> {
	find(provider: string, modelId: string): TModel | undefined;
	hasConfiguredAuth(model: TModel): boolean;
	streamSimple(
		model: TModel,
		context: {
			systemPrompt?: string;
			messages: any[];
			tools?: any[];
		},
		options?: {
			signal?: AbortSignal;
			timeoutMs?: number;
			cacheRetention?: "none" | "short" | "long";
			sessionId?: string;
			maxTokens?: number;
			reasoning?: Exclude<NexpThinkingLevel, "follow" | "off">;
			disableContinuation?: boolean;
			toolChoice?: "auto" | "none";
		},
	): { result(): Promise<AssistantMessageLike> };
}

export interface ReuseRequestSnapshot {
	messages: readonly MessageLike[];
	modelKey?: string;
	thinkingLevel?: string;
	sessionId?: string;
	leafId: string | null;
	capturedAt: number;
}

export type ResolvedPredictionModel<TModel extends ModelLike = ModelLike> =
	| { ok: true; model: TModel; label: string; isFallback: boolean }
	| { ok: false; error: string; errorKind: "config" };

export function resolvePredictionModel<TModel extends ModelLike>(
	config: NexpConfig,
	registry: Pick<ModelRegistryLike<TModel>, "find" | "hasConfiguredAuth">,
	activeModel: TModel | undefined,
): ResolvedPredictionModel<TModel> {
	if (config.model) {
		const spec = parseModelSpec(config.model);
		if (!spec) {
			return { ok: false, error: `Invalid configured model "${config.model}"`, errorKind: "config" };
		}
		const found = registry.find(spec.provider, spec.modelId);
		if (!found) {
			return { ok: false, error: `Model "${config.model}" not found`, errorKind: "config" };
		}
		if (!registry.hasConfiguredAuth(found)) {
			return { ok: false, error: `No auth configured for "${config.model}"`, errorKind: "config" };
		}
		return { ok: true, model: found, label: `${found.provider}/${found.id}`, isFallback: false };
	}

	if (!activeModel) {
		return { ok: false, error: "No active session model", errorKind: "config" };
	}

	if (!registry.hasConfiguredAuth(activeModel)) {
		return {
			ok: false,
			error: `No auth configured for "${activeModel.provider}/${activeModel.id}"`,
			errorKind: "config",
		};
	}

	return {
		ok: true,
		model: activeModel,
		label: `${activeModel.provider}/${activeModel.id}`,
		isFallback: true,
	};
}

const CONCRETE_REASONING_LEVELS = new Set<Exclude<NexpThinkingLevel, "follow" | "off">>([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

export function resolveReasoningOption(
	model: ModelLike,
	thinkingLevel: NexpThinkingLevel,
	effectiveMode: EffectivePredictionMode = "compact",
	sessionThinkingLevel?: string,
): Exclude<NexpThinkingLevel, "follow" | "off"> | undefined {
	if (!model.reasoning || thinkingLevel === "off") {
		return undefined;
	}
	if (thinkingLevel === "follow") {
		if (
			effectiveMode === "reuse" &&
			sessionThinkingLevel &&
			CONCRETE_REASONING_LEVELS.has(sessionThinkingLevel as Exclude<NexpThinkingLevel, "follow" | "off">)
		) {
			return sessionThinkingLevel as Exclude<NexpThinkingLevel, "follow" | "off">;
		}
		return undefined;
	}
	return thinkingLevel;
}

export interface ContextModeResolution {
	effectiveMode: EffectivePredictionMode;
	fallbackReason?: FallbackReason;
}

export function resolvePredictionContextMode(opts: {
	config: NexpConfig;
	resolvedModelLabel: string;
	snapshot?: ReuseRequestSnapshot;
	currentSessionId?: string;
	currentLeafId?: string | null;
	now?: number;
}): ContextModeResolution {
	const { config, resolvedModelLabel, snapshot, currentSessionId, currentLeafId, now = Date.now() } = opts;

	if (config.contextMode === "compact") {
		return { effectiveMode: "compact" };
	}

	if (config.model) {
		if (config.contextMode === "auto" || snapshot?.modelKey !== config.model) {
			return { effectiveMode: "compact", fallbackReason: "explicit-model" };
		}
	}

	if (!snapshot || snapshot.messages.length === 0) {
		return { effectiveMode: "compact", fallbackReason: "no-snapshot" };
	}

	if (snapshot.sessionId && currentSessionId && snapshot.sessionId !== currentSessionId) {
		return { effectiveMode: "compact", fallbackReason: "session-changed" };
	}

	if (currentLeafId !== undefined && snapshot.leafId !== currentLeafId) {
		return { effectiveMode: "compact", fallbackReason: "context-changed" };
	}

	if (snapshot.modelKey && snapshot.modelKey !== resolvedModelLabel) {
		return { effectiveMode: "compact", fallbackReason: "model-changed" };
	}

	if (now - snapshot.capturedAt > REUSE_SNAPSHOT_TTL_MS) {
		return { effectiveMode: "compact", fallbackReason: "snapshot-expired" };
	}

	return { effectiveMode: "reuse" };
}

function extractUsage(raw: AssistantMessageLike["usage"]): PredictionUsage | undefined {
	if (!raw) return undefined;
	return {
		input: typeof raw.input === "number" ? raw.input : 0,
		output: typeof raw.output === "number" ? raw.output : 0,
		cacheRead: typeof raw.cacheRead === "number" ? raw.cacheRead : 0,
		cacheWrite: typeof raw.cacheWrite === "number" ? raw.cacheWrite : 0,
		totalTokens: typeof raw.totalTokens === "number" ? raw.totalTokens : 0,
		costTotal: typeof raw.cost?.total === "number" ? raw.cost.total : undefined,
	};
}

export interface PredictOptions<TModel extends ModelLike = ModelLike> {
	config: NexpConfig;
	messages: readonly MessageLike[];
	cwd: string;
	registry: ModelRegistryLike<TModel>;
	activeModel: TModel | undefined;
	activeThinkingLevel?: string;
	reuseSnapshot?: ReuseRequestSnapshot;
	currentSessionId?: string;
	currentLeafId?: string | null;
	signal: AbortSignal;
	now?: () => number;
	createSessionId?: () => string;
	convertMessages?: (messages: readonly MessageLike[]) => any[];
}

export type PredictResult =
	| {
			ok: true;
			prediction: string;
			modelLabel: string;
			effectiveMode: EffectivePredictionMode;
			fallbackReason?: FallbackReason;
			thinkingLevel: string;
			latencyMs: number;
			usage?: PredictionUsage;
	  }
	| {
			ok: false;
			aborted?: boolean;
			timedOut?: boolean;
			error: string;
			errorKind?: "config" | "request";
			modelLabel?: string;
			effectiveMode?: EffectivePredictionMode;
			fallbackReason?: FallbackReason;
			thinkingLevel?: string;
			latencyMs: number;
	  };

export async function predictNextPrompt<TModel extends ModelLike>(
	opts: PredictOptions<TModel>,
): Promise<PredictResult> {
	const nowFn = opts.now ?? Date.now;
	const startedAt = nowFn();

	const resolved = resolvePredictionModel(opts.config, opts.registry, opts.activeModel);
	if (!resolved.ok) {
		return {
			ok: false,
			error: resolved.error,
			errorKind: resolved.errorKind,
			latencyMs: Math.max(0, nowFn() - startedAt),
		};
	}

	const modeDecision = resolvePredictionContextMode({
		config: opts.config,
		resolvedModelLabel: resolved.label,
		snapshot: opts.reuseSnapshot,
		currentSessionId: opts.currentSessionId,
		currentLeafId: opts.currentLeafId,
		now: startedAt,
	});

	let effectiveMode: EffectivePredictionMode = modeDecision.effectiveMode;
	let fallbackReason: FallbackReason | undefined = modeDecision.fallbackReason;

	const convert = opts.convertMessages ?? ((msgs: readonly MessageLike[]) => convertToLlm(msgs as any));
	let requestContext: { systemPrompt?: string; messages: any[] };

	if (effectiveMode === "reuse" && opts.reuseSnapshot) {
		const converted = convert(opts.reuseSnapshot.messages);
		if (converted.length > 0) {
			requestContext = {
				messages: [
					...converted,
					{
						role: "user",
						content: [{ type: "text", text: REUSE_PREDICTION_INSTRUCTION }],
						timestamp: startedAt,
					},
				],
			};
		} else {
			effectiveMode = "compact";
			fallbackReason = "no-snapshot";
			const transcript = buildConversationTranscript(opts.messages, opts.config.maxContextChars);
			if (!transcript) {
				return {
					ok: false,
					error: "No conversation history to predict from",
					modelLabel: resolved.label,
					effectiveMode,
					fallbackReason,
					latencyMs: Math.max(0, nowFn() - startedAt),
				};
			}
			requestContext = {
				systemPrompt: PREDICTION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildPredictionUserPrompt(transcript, opts.cwd) }],
						timestamp: startedAt,
					},
				],
			};
		}
	} else {
		const transcript = buildConversationTranscript(opts.messages, opts.config.maxContextChars);
		if (!transcript) {
			return {
				ok: false,
				error: "No conversation history to predict from",
				modelLabel: resolved.label,
				effectiveMode,
				fallbackReason,
				latencyMs: Math.max(0, nowFn() - startedAt),
			};
		}
		requestContext = {
			systemPrompt: PREDICTION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildPredictionUserPrompt(transcript, opts.cwd) }],
					timestamp: startedAt,
				},
			],
		};
	}

	const reasoning = resolveReasoningOption(
		resolved.model,
		opts.config.thinkingLevel,
		effectiveMode,
		opts.activeThinkingLevel ?? opts.reuseSnapshot?.thinkingLevel,
	);
	const effectiveThinkingLabel = reasoning ?? "off";

	const timeoutController = new AbortController();
	let timedOut = false;
	const onCallerAbort = () => timeoutController.abort();
	if (opts.signal.aborted) {
		timeoutController.abort();
	} else {
		opts.signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, opts.config.timeoutMs);

	const sessionId =
		effectiveMode === "reuse"
			? opts.reuseSnapshot?.sessionId
			: (opts.createSessionId ?? randomUUID)();

	const streamOptions: {
		signal: AbortSignal;
		timeoutMs: number;
		cacheRetention?: "none";
		sessionId?: string;
		maxTokens?: number;
		reasoning?: Exclude<NexpThinkingLevel, "follow" | "off">;
		disableContinuation: true;
		toolChoice: "none";
	} = {
		signal: timeoutController.signal,
		timeoutMs: opts.config.timeoutMs,
		disableContinuation: true,
		toolChoice: "none",
	};

	if (sessionId) {
		streamOptions.sessionId = sessionId;
	}
	if (effectiveMode === "compact") {
		streamOptions.cacheRetention = "none";
	}
	if (reasoning) {
		// Leave maxTokens unset when reasoning is enabled so provider thinking budgets are not starved.
		streamOptions.reasoning = reasoning;
	} else {
		streamOptions.maxTokens = 160;
	}

	try {
		const stream = opts.registry.streamSimple(resolved.model, requestContext, streamOptions);
		const response = await stream.result();
		const latencyMs = Math.max(0, nowFn() - startedAt);

		if (timedOut) {
			return {
				ok: false,
				timedOut: true,
				error: `Prediction timed out after ${opts.config.timeoutMs}ms`,
				errorKind: "request",
				modelLabel: resolved.label,
				effectiveMode,
				fallbackReason,
				thinkingLevel: effectiveThinkingLabel,
				latencyMs,
			};
		}

		if (opts.signal.aborted || response.stopReason === "aborted") {
			return {
				ok: false,
				aborted: true,
				error: "Prediction aborted",
				modelLabel: resolved.label,
				effectiveMode,
				fallbackReason,
				thinkingLevel: effectiveThinkingLabel,
				latencyMs,
			};
		}

		if (response.stopReason === "error") {
			return {
				ok: false,
				error: response.errorMessage || "Prediction request failed",
				errorKind: "request",
				modelLabel: resolved.label,
				effectiveMode,
				fallbackReason,
				thinkingLevel: effectiveThinkingLabel,
				latencyMs,
			};
		}

		const rawText = (response.content ?? [])
			.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");

		return {
			ok: true,
			prediction: cleanPredictionOutput(rawText),
			modelLabel: resolved.label,
			effectiveMode,
			fallbackReason,
			thinkingLevel: effectiveThinkingLabel,
			latencyMs,
			usage: extractUsage(response.usage),
		};
	} catch (error) {
		const latencyMs = Math.max(0, nowFn() - startedAt);
		if (timedOut) {
			return {
				ok: false,
				timedOut: true,
				error: `Prediction timed out after ${opts.config.timeoutMs}ms`,
				errorKind: "request",
				modelLabel: resolved.label,
				effectiveMode,
				fallbackReason,
				thinkingLevel: effectiveThinkingLabel,
				latencyMs,
			};
		}
		if (opts.signal.aborted) {
			return {
				ok: false,
				aborted: true,
				error: "Prediction aborted",
				modelLabel: resolved.label,
				effectiveMode,
				fallbackReason,
				thinkingLevel: effectiveThinkingLabel,
				latencyMs,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: message,
			errorKind: "request",
			modelLabel: resolved.label,
			effectiveMode,
			fallbackReason,
			thinkingLevel: effectiveThinkingLabel,
			latencyMs,
		};
	} finally {
		clearTimeout(timer);
		opts.signal.removeEventListener("abort", onCallerAbort);
	}
}
