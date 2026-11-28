import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_MODES,
	isContextMode,
	isThinkingLevel,
	loadConfigWithDiagnostics,
	parseModelSpec,
	saveConfigPatch,
	THINKING_LEVELS,
	type ConfigDiagnostic,
	type NexpConfig,
	type NexpConfigPatch,
} from "./config.ts";
import { shouldSkipAutoPredict, type MessageLike } from "./context.ts";
import { createGhostEditorController } from "./ghost-editor.ts";
import { predictNextPrompt, type ReuseRequestSnapshot } from "./predictor.ts";
import { createSessionStatsTracker, formatStatusSummary } from "./stats.ts";

const STATUS_KEY = "pi-nexp";

interface PendingRequestSnapshot {
	messages: MessageLike[];
	modelKey?: string;
	thinkingLevel?: string;
	sessionId?: string;
	capturedAt: number;
}

function notifyOrLog(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
		ctx.ui.notify(message, level);
		return;
	}
	if (level === "error") console.error(message);
	else if (level === "warning") console.warn(message);
	else console.log(message);
}

function getModelLabel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function parseTimeoutInput(raw: string): number | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	if (/^\d+(?:\.\d+)?ms$/.test(trimmed)) {
		const ms = Number(trimmed.slice(0, -2));
		return Number.isFinite(ms) ? Math.round(ms) : null;
	}
	if (/^\d+(?:\.\d+)?s$/.test(trimmed)) {
		const sec = Number(trimmed.slice(0, -1));
		return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
	}
	const num = Number(trimmed);
	return Number.isFinite(num) ? Math.round(num) : null;
}

function parseArgs(rawArgs: string): { scope: "global" | "project"; tokens: string[] } {
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	let scope: "global" | "project" = "global";
	const filtered: string[] = [];
	for (const token of tokens) {
		if (token === "--project" || token === "-p") {
			scope = "project";
		} else {
			filtered.push(token);
		}
	}
	return { scope, tokens: filtered };
}

function findNormalFinalAssistant(messages: readonly MessageLike[]): MessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant") {
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				return undefined;
			}
			return msg;
		}
		if (msg.role === "user") {
			return undefined;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let inFlight: AbortController | undefined;
	let requestSeq = 0;
	let latestCtx: ExtensionContext | undefined;
	let pendingRequest: PendingRequestSnapshot | undefined;
	let reuseSnapshot: ReuseRequestSnapshot | undefined;
	let activeUiPrompts = 0;
	let cachedModelSpecs: string[] = [];
	const shownConfigWarnings = new Set<string>();
	const stats = createSessionStatsTracker();

	const refreshModelSpecs = (ctx: ExtensionContext) => {
		try {
			if (typeof ctx.modelRegistry?.getAvailable === "function") {
				cachedModelSpecs = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
			}
		} catch {
			// Ignore if registry is unavailable in minimal mocks.
		}
	};

	const surfaceConfigWarnings = (ctx: ExtensionContext, warnings: readonly ConfigDiagnostic[]) => {
		for (const warning of warnings) {
			const dedupeKey = `${warning.path}:${warning.message}`;
			if (shownConfigWarnings.has(dedupeKey)) continue;
			shownConfigWarnings.add(dedupeKey);
			notifyOrLog(ctx, `pi-nexp config warning (${warning.scope}): ${warning.message}`, "warning");
		}
	};

	const abortInFlight = (ctx?: ExtensionContext): boolean => {
		const hadInFlight = inFlight !== undefined;
		if (inFlight) {
			inFlight.abort();
			inFlight = undefined;
		}
		requestSeq += 1;
		if (hadInFlight || ctx) {
			const target = ctx ?? latestCtx;
			if (target?.mode === "tui") {
				target.ui.setStatus(STATUS_KEY, undefined);
			}
		}
		return hadInFlight;
	};

	const ghostEditor = createGhostEditorController({
		onCancelPrediction: () => abortInFlight(),
		onAcceptGhost: () => stats.recordAccept(),
		onDismissGhost: () => stats.recordDismiss(),
	});

	const clearAll = (ctx?: ExtensionContext) => {
		abortInFlight(ctx);
		ghostEditor.clearGhostText();
	};

	const invalidateSnapshots = () => {
		pendingRequest = undefined;
		reuseSnapshot = undefined;
	};

	const finalizeReuseSnapshot = (assistantMsg: MessageLike | undefined, ctx: ExtensionContext) => {
		const captured = pendingRequest;
		pendingRequest = undefined;
		if (!captured || !assistantMsg) return;
		if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") return;
		reuseSnapshot = {
			messages: [...captured.messages, assistantMsg],
			modelKey: captured.modelKey,
			thinkingLevel: captured.thinkingLevel,
			sessionId: captured.sessionId,
			leafId: ctx.sessionManager.getLeafId?.() ?? null,
			capturedAt: Date.now(),
		};
	};

	const runPrediction = async (
		ctx: ExtensionContext,
		manual: boolean,
		preloaded?: { config: NexpConfig; messages: readonly MessageLike[] },
	) => {
		latestCtx = ctx;
		ghostEditor.updateContext(ctx);
		if (ctx.mode !== "tui") {
			if (manual) {
				notifyOrLog(ctx, "pi-nexp ghost text is only available in TUI mode", "warning");
			}
			return;
		}

		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
			if (manual) {
				notifyOrLog(ctx, "pi-nexp: wait for the agent to become idle before predicting", "info");
			}
			return;
		}

		if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
			if (manual) {
				notifyOrLog(ctx, "pi-nexp: cannot predict while queued messages are pending", "info");
			}
			return;
		}

		if (!manual && activeUiPrompts > 0) {
			return;
		}

		let config: NexpConfig;
		if (preloaded) {
			config = preloaded.config;
		} else {
			const loaded = loadConfigWithDiagnostics(ctx.cwd);
			surfaceConfigWarnings(ctx, loaded.warnings);
			config = loaded.config;
		}
		if (!manual && !config.enabled) return;

		if (ctx.ui.getEditorText().length > 0) {
			if (manual) {
				notifyOrLog(ctx, "pi-nexp: clear the input editor to display a predicted prompt", "info");
			}
			return;
		}

		// Defer editor replacement until prediction so startup overlays can restore focus to the original editor.
		ghostEditor.ensureInstalled(ctx);

		abortInFlight(ctx);
		ghostEditor.clearGhostText();

		const leafIdAtStart = ctx.sessionManager.getLeafId?.() ?? null;
		const sessionIdAtStart = ctx.sessionManager.getSessionId?.();
		const messages = preloaded?.messages ?? ctx.sessionManager.buildSessionProjection().messages;

		const seq = ++requestSeq;
		const controller = new AbortController();
		inFlight = controller;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "nexp…"));

		const result = await predictNextPrompt({
			config,
			messages,
			cwd: ctx.cwd,
			registry: ctx.modelRegistry,
			activeModel: ctx.model,
			activeThinkingLevel: ctx.thinkingLevel,
			reuseSnapshot,
			currentSessionId: sessionIdAtStart,
			currentLeafId: leafIdAtStart,
			signal: controller.signal,
			createSessionId: uuidv7,
		});

		if (seq !== requestSeq || controller.signal.aborted) {
			if (result.ok === false && result.timedOut) {
				stats.recordPrediction({
					timestamp: Date.now(),
					manual,
					configuredMode: config.contextMode,
					effectiveMode: result.effectiveMode,
					fallbackReason: result.fallbackReason,
					modelLabel: result.modelLabel,
					thinkingLevel: result.thinkingLevel,
					outcome: "timeout",
					latencyMs: result.latencyMs,
					error: result.error,
				});
			} else {
				stats.recordPrediction({
					timestamp: Date.now(),
					manual,
					configuredMode: config.contextMode,
					effectiveMode: result.effectiveMode,
					fallbackReason: result.fallbackReason,
					modelLabel: result.modelLabel,
					thinkingLevel: result.thinkingLevel,
					outcome: "aborted",
					latencyMs: result.latencyMs,
				});
			}
			return;
		}

		if (inFlight === controller) {
			inFlight = undefined;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);

		if (!result.ok) {
			const outcome = result.timedOut ? "timeout" : result.aborted ? "aborted" : "error";
			stats.recordPrediction({
				timestamp: Date.now(),
				manual,
				configuredMode: config.contextMode,
				effectiveMode: result.effectiveMode,
				fallbackReason: result.fallbackReason,
				modelLabel: result.modelLabel,
				thinkingLevel: result.thinkingLevel,
				outcome,
				latencyMs: result.latencyMs,
				error: result.aborted ? undefined : result.error,
			});

			if (manual && !result.aborted) {
				notifyOrLog(ctx, `pi-nexp: ${result.error}`, "warning");
			} else if (!manual && result.errorKind === "config") {
				const dedupeKey = `config-err:${result.error}`;
				if (!shownConfigWarnings.has(dedupeKey)) {
					shownConfigWarnings.add(dedupeKey);
					notifyOrLog(ctx, `pi-nexp: ${result.error}`, "warning");
				}
			}
			return;
		}

		stats.recordPrediction({
			timestamp: Date.now(),
			manual,
			configuredMode: config.contextMode,
			effectiveMode: result.effectiveMode,
			fallbackReason: result.fallbackReason,
			modelLabel: result.modelLabel,
			thinkingLevel: result.thinkingLevel,
			outcome: result.prediction ? "predicted" : "empty",
			latencyMs: result.latencyMs,
			usage: result.usage,
		});

		const currentLeafId = ctx.sessionManager.getLeafId?.() ?? null;
		const stillIdle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
		const hasPending = typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
		if (!stillIdle || hasPending || currentLeafId !== leafIdAtStart || ctx.ui.getEditorText().length > 0) {
			return;
		}

		if (!result.prediction) {
			if (manual) {
				notifyOrLog(ctx, "pi-nexp: no next prompt predicted", "info");
			}
			return;
		}

		ghostEditor.setGhostText(result.prediction);
	};

	const saveConfigWithFeedback = (
		ctx: ExtensionContext,
		scope: "global" | "project",
		patch: NexpConfigPatch,
		successMessage: (savedPath: string) => string,
	): boolean => {
		const before = loadConfigWithDiagnostics(ctx.cwd);
		try {
			const savedPath = saveConfigPatch(scope, ctx.cwd, patch);
			shownConfigWarnings.clear();
			let message = successMessage(savedPath);
			if (scope === "global") {
				const overriddenKeys = (Object.keys(patch) as Array<keyof NexpConfig>).filter((key) =>
					before.projectOverrides.has(key),
				);
				if (overriddenKeys.length > 0) {
					message += ` (note: overridden in this project by .pi/pi-nexp.json: ${overriddenKeys.join(", ")})`;
				}
			}
			notifyOrLog(ctx, message, "info");
			return true;
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			notifyOrLog(ctx, `pi-nexp: failed to save config — ${errMsg}`, "error");
			return false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		ghostEditor.updateContext(ctx);
		refreshModelSpecs(ctx);
		invalidateSnapshots();
		stats.reset();
		clearAll(ctx);
		const loaded = loadConfigWithDiagnostics(ctx.cwd);
		surfaceConfigWarnings(ctx, loaded.warnings);
	});

	pi.on("session_tree", (_event, ctx) => {
		latestCtx = ctx;
		invalidateSnapshots();
		clearAll(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		latestCtx = ctx;
		invalidateSnapshots();
		clearAll(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		invalidateSnapshots();
		abortInFlight(ctx);
		ghostEditor.reset();
	});

	pi.on("model_select", (_event, ctx) => {
		latestCtx = ctx;
		refreshModelSpecs(ctx);
		reuseSnapshot = undefined;
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		latestCtx = ctx;
	});

	pi.on("user_bash", (event, ctx) => {
		latestCtx = ctx;
		if (!event.excludeFromContext) {
			reuseSnapshot = undefined;
		}
	});

	pi.on("ui_prompt_start", () => {
		activeUiPrompts += 1;
	});

	pi.on("ui_prompt_end", () => {
		activeUiPrompts = Math.max(0, activeUiPrompts - 1);
	});

	pi.on("agent_start", (_event, ctx) => {
		latestCtx = ctx;
		invalidateSnapshots();
		clearAll(ctx);
	});

	pi.on("context_with_system", (event, ctx) => {
		latestCtx = ctx;
		pendingRequest = {
			messages: [...(event.messages as unknown as MessageLike[])],
			modelKey: getModelLabel(ctx),
			thinkingLevel: ctx.thinkingLevel,
			sessionId: ctx.sessionManager.getSessionId?.(),
			capturedAt: Date.now(),
		};
	});

	pi.on("agent_end", (event, ctx) => {
		latestCtx = ctx;
		const assistant = findNormalFinalAssistant(event.messages as unknown as MessageLike[]);
		finalizeReuseSnapshot(assistant, ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		latestCtx = ctx;
		ghostEditor.updateContext(ctx);
		if (ctx.mode !== "tui") return;
		if (activeUiPrompts > 0) return;
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
		if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;

		const loaded = loadConfigWithDiagnostics(ctx.cwd);
		surfaceConfigWarnings(ctx, loaded.warnings);
		const config = loaded.config;
		if (!config.enabled) return;
		if (ctx.ui.getEditorText().length > 0) return;

		const projectedMessages = ctx.sessionManager.buildSessionProjection().messages as unknown as MessageLike[];
		if (pendingRequest && !event.aborted) {
			finalizeReuseSnapshot(findNormalFinalAssistant(projectedMessages), ctx);
		}
		if (shouldSkipAutoPredict(projectedMessages, event.aborted)) return;

		void runPrediction(ctx, false, { config, messages: projectedMessages });
	});

	pi.registerShortcut("alt+n", {
		description: "Predict next prompt (pi-nexp)",
		handler: async (ctx) => {
			await runPrediction(ctx, true);
		},
	});

	const showStatus = (ctx: ExtensionContext) => {
		const loaded = loadConfigWithDiagnostics(ctx.cwd);
		const summary = formatStatusSummary({
			config: loaded.config,
			activeModelLabel: getModelLabel(ctx),
			activeThinkingLevel: ctx.thinkingLevel,
			projectOverrides: loaded.projectOverrides,
			configWarnings: loaded.warnings,
			stats: stats.getSnapshot(),
		});
		notifyOrLog(ctx, summary, "info");
	};

	const openInteractiveMenu = async (ctx: ExtensionContext, scope: "global" | "project") => {
		const loaded = loadConfigWithDiagnostics(ctx.cwd);
		surfaceConfigWarnings(ctx, loaded.warnings);
		const config = loaded.config;
		const activeLabel = getModelLabel(ctx);
		const scopeLabel = scope === "project" ? "project (.pi/pi-nexp.json)" : "global (~/.pi/agent/pi-nexp.json)";

		const toggleLabel = `Auto-predict: ${config.enabled ? "ON → turn OFF" : "OFF → turn ON"}`;
		const modeLabel = `Context mode: ${config.contextMode}`;
		const modelLabel = `Model: ${config.model ?? `follow main (${activeLabel ?? "none"})`}`;
		const thinkingLabel = `Thinking level: ${config.thinkingLevel}`;
		const budgetLabel = `Context budget: ${config.maxContextChars} chars`;
		const timeoutLabel = `Timeout: ${config.timeoutMs} ms`;
		const statusLabel = "Show status & session stats";
		const runLabel = "Predict now";

		const choice = await ctx.ui.select(`pi-nexp (${scopeLabel})`, [
			toggleLabel,
			modeLabel,
			modelLabel,
			thinkingLabel,
			budgetLabel,
			timeoutLabel,
			statusLabel,
			runLabel,
		]);
		if (!choice) return;

		if (choice === toggleLabel) {
			const nextEnabled = !config.enabled;
			if (saveConfigWithFeedback(ctx, scope, { enabled: nextEnabled }, (p) => `pi-nexp auto-predict ${nextEnabled ? "enabled" : "disabled"} (${p})`)) {
				if (!nextEnabled) clearAll(ctx);
			}
			return;
		}

		if (choice === modeLabel) {
			const picked = await ctx.ui.select(
				"Select context mode",
				CONTEXT_MODES.map((m) => (m === config.contextMode ? `${m} (current)` : m)),
			);
			if (!picked) return;
			const mode = picked.replace(/\s+\(current\)$/, "");
			if (!isContextMode(mode)) return;
			saveConfigWithFeedback(ctx, scope, { contextMode: mode }, (p) => `pi-nexp context mode set to ${mode} (${p})`);
			return;
		}

		if (choice === modelLabel) {
			const available = ctx.modelRegistry.getAvailable();
			cachedModelSpecs = available.map((m) => `${m.provider}/${m.id}`);
			const followBase = `Follow main session model${activeLabel ? ` (${activeLabel})` : ""}`;
			const followItem = config.model ? followBase : `${followBase} (current)`;
			const modelItems = available.map((m) => {
				const spec = `${m.provider}/${m.id}`;
				const isCurrent = config.model === spec;
				const tags = [m.reasoning ? "" : "[no reasoning]", isCurrent ? "(current)" : ""].filter(Boolean).join(" ");
				return {
					isCurrent,
					label: tags ? `${spec} ${tags}` : spec,
				};
			});
			modelItems.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));

			const picked = await ctx.ui.select("Select prediction model", [
				followItem,
				...modelItems.map((item) => item.label),
			]);
			if (!picked) return;

			if (picked === followItem) {
				saveConfigWithFeedback(ctx, scope, { model: null }, (p) => `pi-nexp model set to follow main session (${p})`);
				return;
			}

			const spec = picked.replace(/\s+\(current\)$/, "").replace(/\s+\[no reasoning\]$/, "");
			saveConfigWithFeedback(ctx, scope, { model: spec }, (p) => `pi-nexp model set to ${spec} (${p})`);
			return;
		}

		if (choice === thinkingLabel) {
			const picked = await ctx.ui.select(
				"Select prediction thinking level",
				THINKING_LEVELS.map((level) => (level === config.thinkingLevel ? `${level} (current)` : level)),
			);
			if (!picked) return;
			const level = picked.replace(/\s+\(current\)$/, "");
			if (!isThinkingLevel(level)) return;
			saveConfigWithFeedback(ctx, scope, { thinkingLevel: level }, (p) => `pi-nexp thinking level set to ${level} (${p})`);
			return;
		}

		if (choice === budgetLabel) {
			const raw = await ctx.ui.input("Context budget in chars (1000-64000)", String(config.maxContextChars));
			if (raw === undefined) return;
			const parsed = Number(raw.trim());
			if (!Number.isFinite(parsed) || parsed <= 0) {
				notifyOrLog(ctx, "Invalid context budget. Enter a positive number between 1000 and 64000.", "warning");
				return;
			}
			saveConfigWithFeedback(ctx, scope, { maxContextChars: parsed }, (p) => {
				const updated = loadConfigWithDiagnostics(ctx.cwd).config;
				return `pi-nexp context budget set to ${updated.maxContextChars} chars (${p})`;
			});
			return;
		}

		if (choice === timeoutLabel) {
			const raw = await ctx.ui.input("Prediction timeout in ms (2000-120000, or e.g. 15s)", String(config.timeoutMs));
			if (raw === undefined) return;
			const parsed = parseTimeoutInput(raw);
			if (parsed === null || parsed <= 0) {
				notifyOrLog(ctx, "Invalid timeout. Enter milliseconds (2000-120000) or seconds like 15s.", "warning");
				return;
			}
			saveConfigWithFeedback(ctx, scope, { timeoutMs: parsed }, (p) => {
				const updated = loadConfigWithDiagnostics(ctx.cwd).config;
				return `pi-nexp timeout set to ${updated.timeoutMs}ms (${p})`;
			});
			return;
		}

		if (choice === statusLabel) {
			showStatus(ctx);
			return;
		}

		if (choice === runLabel) {
			await runPrediction(ctx, true);
		}
	};

	pi.registerCommand("nexp", {
		description:
			"Configure or run next-prompt prediction (/nexp [on|off|run|mode|model|thinking|budget|timeout|status] [--project])",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["on", "off", "run", "mode", "model", "thinking", "budget", "timeout", "status", "--project"];
			const trimmedStart = prefix.trimStart();
			const hasTrailingSpace = /\s$/.test(prefix);
			const rawTokens = trimmedStart.split(/\s+/).filter(Boolean);

			let scopePrefix = "";
			const tokens: string[] = [];
			for (const tok of rawTokens) {
				if ((tok === "--project" || tok === "-p") && tokens.length === 0) {
					scopePrefix = `${tok} `;
				} else {
					tokens.push(tok);
				}
			}

			if (tokens.length === 0 || (tokens.length === 1 && !hasTrailingSpace)) {
				const argPrefix = tokens[0] ?? "";
				const candidates = scopePrefix ? subcommands.filter((s) => s !== "--project") : subcommands;
				const matches = candidates.filter((cmd) => cmd.startsWith(argPrefix));
				return matches.length > 0
					? matches.map((value) => ({ value: `${scopePrefix}${value}`, label: value }))
					: null;
			}

			const first = tokens[0];
			const secondPrefix = tokens.length >= 2 && !hasTrailingSpace ? tokens[1] : "";
			const hasSecond = tokens.length >= 2 && (hasTrailingSpace || tokens.length > 2);

			if (hasSecond) {
				if (!scopePrefix && "--project".startsWith(tokens[tokens.length - 1]) && !hasTrailingSpace) {
					const before = tokens.slice(0, -1).join(" ");
					return [{ value: `${before} --project`, label: "--project" }];
				}
				return null;
			}

			if (first === "mode") {
				const matches = CONTEXT_MODES.filter((mode) => mode.startsWith(secondPrefix));
				return matches.length > 0
					? matches.map((mode) => ({ value: `${scopePrefix}mode ${mode}`, label: mode }))
					: null;
			}

			if (first === "thinking") {
				const matches = THINKING_LEVELS.filter((lvl) => lvl.startsWith(secondPrefix));
				return matches.length > 0
					? matches.map((lvl) => ({ value: `${scopePrefix}thinking ${lvl}`, label: lvl }))
					: null;
			}

			if (first === "model") {
				const modelCandidates = ["follow", ...cachedModelSpecs];
				const matches = modelCandidates.filter((item) => item.startsWith(secondPrefix));
				return matches.length > 0
					? matches.map((item) => ({ value: `${scopePrefix}model ${item}`, label: item }))
					: null;
			}

			if (!scopePrefix && "--project".startsWith(secondPrefix)) {
				return [{ value: `${first} --project`, label: "--project" }];
			}

			return null;
		},
		handler: async (rawArgs, ctx) => {
			latestCtx = ctx;
			refreshModelSpecs(ctx);
			const { scope, tokens } = parseArgs(rawArgs);
			const [sub, ...rest] = tokens;

			if (!sub) {
				if (!ctx.hasUI) {
					showStatus(ctx);
					return;
				}
				await openInteractiveMenu(ctx, scope);
				return;
			}

			if (sub === "status") {
				showStatus(ctx);
				return;
			}

			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				if (saveConfigWithFeedback(ctx, scope, { enabled }, (p) => `pi-nexp auto-predict ${enabled ? "enabled" : "disabled"} (${p})`)) {
					if (!enabled) clearAll(ctx);
				}
				return;
			}

			if (sub === "run" || sub === "predict") {
				await runPrediction(ctx, true);
				return;
			}

			if (sub === "mode") {
				const mode = rest[0];
				if (!isContextMode(mode)) {
					notifyOrLog(ctx, `Usage: /nexp mode <${CONTEXT_MODES.join("|")}> [--project]`, "warning");
					return;
				}
				saveConfigWithFeedback(ctx, scope, { contextMode: mode }, (p) => `pi-nexp context mode set to ${mode} (${p})`);
				return;
			}

			if (sub === "model") {
				const value = rest[0];
				if (!value) {
					notifyOrLog(ctx, "Usage: /nexp model <provider/modelId | follow> [--project]", "warning");
					return;
				}
				if (value === "follow" || value === "default" || value === "auto" || value === "none") {
					saveConfigWithFeedback(ctx, scope, { model: null }, (p) => `pi-nexp model set to follow main session (${p})`);
					return;
				}
				const spec = parseModelSpec(value);
				if (!spec) {
					notifyOrLog(ctx, `Invalid model "${value}". Expected "provider/modelId" or "follow".`, "warning");
					return;
				}
				const found = ctx.modelRegistry.find(spec.provider, spec.modelId);
				if (!found) {
					notifyOrLog(ctx, `Model "${value}" not found in model registry.`, "warning");
					return;
				}
				saveConfigWithFeedback(
					ctx,
					scope,
					{ model: `${found.provider}/${found.id}` },
					(p) => `pi-nexp model set to ${found.provider}/${found.id} (${p})`,
				);
				return;
			}

			if (sub === "thinking") {
				const level = rest[0];
				if (!isThinkingLevel(level)) {
					notifyOrLog(ctx, `Usage: /nexp thinking <${THINKING_LEVELS.join("|")}> [--project]`, "warning");
					return;
				}
				saveConfigWithFeedback(ctx, scope, { thinkingLevel: level }, (p) => `pi-nexp thinking level set to ${level} (${p})`);
				return;
			}

			if (sub === "budget" || sub === "max-context") {
				const raw = rest[0];
				const parsed = raw ? Number(raw) : NaN;
				if (!Number.isFinite(parsed) || parsed <= 0) {
					notifyOrLog(ctx, "Usage: /nexp budget <1000-64000> [--project]", "warning");
					return;
				}
				saveConfigWithFeedback(ctx, scope, { maxContextChars: parsed }, (p) => {
					const updated = loadConfigWithDiagnostics(ctx.cwd).config;
					return `pi-nexp context budget set to ${updated.maxContextChars} chars (${p})`;
				});
				return;
			}

			if (sub === "timeout") {
				const raw = rest[0];
				const parsed = raw ? parseTimeoutInput(raw) : null;
				if (parsed === null || parsed <= 0) {
					notifyOrLog(ctx, "Usage: /nexp timeout <ms | Ns> [--project]", "warning");
					return;
				}
				saveConfigWithFeedback(ctx, scope, { timeoutMs: parsed }, (p) => {
					const updated = loadConfigWithDiagnostics(ctx.cwd).config;
					return `pi-nexp timeout set to ${updated.timeoutMs}ms (${p})`;
				});
				return;
			}

			notifyOrLog(
				ctx,
				"Usage: /nexp [on|off|run|mode <auto|compact|reuse>|model <provider/id|follow>|thinking <level>|budget <chars>|timeout <ms|Ns>|status] [--project]",
				"warning",
			);
		},
	});
}
