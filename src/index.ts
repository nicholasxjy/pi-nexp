import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isThinkingLevel,
	loadConfig,
	parseModelSpec,
	saveConfigPatch,
	THINKING_LEVELS,
	type NexpConfig,
} from "./config.ts";
import { shouldSkipAutoPredict } from "./context.ts";
import { createGhostEditorController } from "./ghost-editor.ts";
import { predictNextPrompt } from "./predictor.ts";

const STATUS_KEY = "pi-nexp";

function formatConfigSummary(config: NexpConfig, activeModelLabel?: string): string {
	const modelLabel = config.model ?? `follow (${activeModelLabel ?? "none"})`;
	return [
		`auto=${config.enabled ? "on" : "off"}`,
		`model=${modelLabel}`,
		`thinking=${config.thinkingLevel}`,
		`maxContextChars=${config.maxContextChars}`,
	].join(" | ");
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

export default function (pi: ExtensionAPI) {
	let inFlight: AbortController | undefined;
	let requestSeq = 0;
	let latestCtx: ExtensionContext | undefined;

	const abortInFlight = (ctx?: ExtensionContext) => {
		if (inFlight) {
			inFlight.abort();
			inFlight = undefined;
		}
		const target = ctx ?? latestCtx;
		if (target?.mode === "tui") {
			target.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	const ghostEditor = createGhostEditorController(() => {
		abortInFlight();
	});

	const clearAll = (ctx?: ExtensionContext) => {
		abortInFlight(ctx);
		ghostEditor.clearGhostText();
	};

	const runPrediction = async (ctx: ExtensionContext, manual: boolean) => {
		latestCtx = ctx;
		if (ctx.mode !== "tui") {
			if (manual && ctx.hasUI) {
				ctx.ui.notify("pi-nexp ghost text is only available in TUI mode", "warning");
			}
			return;
		}

		const config = loadConfig(ctx.cwd);
		if (!manual && !config.enabled) return;

		if (ctx.ui.getEditorText().length > 0) {
			if (manual) {
				ctx.ui.notify("pi-nexp: clear the input editor to display a predicted prompt", "info");
			}
			return;
		}

		// Re-verify wrapper before showing ghost text in case another extension replaced the editor after session_start.
		ghostEditor.ensureInstalled(ctx);

		abortInFlight(ctx);
		if (manual) {
			ghostEditor.clearGhostText();
		}

		const seq = ++requestSeq;
		const controller = new AbortController();
		inFlight = controller;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "nexp…"));

		const result = await predictNextPrompt({
			config,
			branch: ctx.sessionManager.getBranch(),
			cwd: ctx.cwd,
			registry: ctx.modelRegistry as any,
			activeModel: ctx.model,
			signal: controller.signal,
			createSessionId: uuidv7,
		});

		if (seq !== requestSeq) return;
		if (inFlight === controller) {
			inFlight = undefined;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);

		if (!result.ok) {
			if (manual && !result.aborted) {
				ctx.ui.notify(`pi-nexp: ${result.error}`, "warning");
			}
			return;
		}

		if (ctx.ui.getEditorText().length > 0) return;

		if (!result.prediction) {
			if (manual) {
				ctx.ui.notify("pi-nexp: no next prompt predicted", "info");
			}
			return;
		}

		ghostEditor.setGhostText(result.prediction);
	};

	pi.on("session_start", (_event, ctx) => {
		clearAll(ctx);
		ghostEditor.ensureInstalled(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		clearAll(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		abortInFlight(ctx);
		ghostEditor.reset();
	});

	pi.on("agent_start", (_event, ctx) => {
		clearAll(ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;
		if (ctx.ui.getEditorText().length > 0) return;
		if (shouldSkipAutoPredict(ctx.sessionManager.getBranch(), event.aborted)) return;

		void runPrediction(ctx, false);
	});

	pi.registerShortcut("alt+n", {
		description: "Predict next prompt (pi-nexp)",
		handler: async (ctx) => {
			await runPrediction(ctx, true);
		},
	});

	const openInteractiveMenu = async (ctx: ExtensionContext, scope: "global" | "project") => {
		const config = loadConfig(ctx.cwd);
		const activeLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const scopeLabel = scope === "project" ? "project (.pi/pi-nexp.json)" : "global (~/.pi/agent/pi-nexp.json)";

		const toggleLabel = `Auto-predict: ${config.enabled ? "ON → turn OFF" : "OFF → turn ON"}`;
		const modelLabel = `Model: ${config.model ?? `follow main (${activeLabel ?? "none"})`}`;
		const thinkingLabel = `Thinking level: ${config.thinkingLevel}`;
		const runLabel = "Predict now";

		const choice = await ctx.ui.select(`pi-nexp (${scopeLabel})`, [
			toggleLabel,
			modelLabel,
			thinkingLabel,
			runLabel,
		]);
		if (!choice) return;

		if (choice === toggleLabel) {
			const nextEnabled = !config.enabled;
			const savedPath = saveConfigPatch(scope, ctx.cwd, { enabled: nextEnabled });
			if (!nextEnabled) clearAll(ctx);
			ctx.ui.notify(`pi-nexp auto-predict ${nextEnabled ? "enabled" : "disabled"} (${savedPath})`, "info");
			return;
		}

		if (choice === modelLabel) {
			const available = ctx.modelRegistry.getAvailable();
			const followItem = `Follow main session model${activeLabel ? ` (${activeLabel})` : ""}`;
			const modelItems = available.map((m) => `${m.provider}/${m.id}${m.reasoning ? "" : " [no reasoning]"}`);
			const picked = await ctx.ui.select("Select prediction model", [followItem, ...modelItems]);
			if (!picked) return;

			if (picked === followItem) {
				const savedPath = saveConfigPatch(scope, ctx.cwd, { model: null });
				ctx.ui.notify(`pi-nexp model set to follow main session (${savedPath})`, "info");
				return;
			}

			const spec = picked.replace(/\s+\[no reasoning\]$/, "");
			const savedPath = saveConfigPatch(scope, ctx.cwd, { model: spec });
			ctx.ui.notify(`pi-nexp model set to ${spec} (${savedPath})`, "info");
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
			const savedPath = saveConfigPatch(scope, ctx.cwd, { thinkingLevel: level });
			ctx.ui.notify(`pi-nexp thinking level set to ${level} (${savedPath})`, "info");
			return;
		}

		if (choice === runLabel) {
			await runPrediction(ctx, true);
		}
	};

	pi.registerCommand("nexp", {
		description: "Configure or run next-prompt prediction (/nexp [on|off|run|model|thinking|status] [--project])",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["on", "off", "run", "model", "thinking", "status", "--project"];
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				const matches = subcommands.filter((cmd) => cmd.startsWith(trimmed));
				return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
			}
			const [first, ...rest] = trimmed.split(/\s+/);
			const argPrefix = rest.join(" ");
			if (first === "thinking") {
				const matches = THINKING_LEVELS.filter((lvl) => lvl.startsWith(argPrefix));
				return matches.length > 0 ? matches.map((lvl) => ({ value: `thinking ${lvl}`, label: lvl })) : null;
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			const { scope, tokens } = parseArgs(rawArgs);
			const [sub, ...rest] = tokens;

			if (!sub) {
				if (!ctx.hasUI) {
					const config = loadConfig(ctx.cwd);
					const activeLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					console.log(formatConfigSummary(config, activeLabel));
					return;
				}
				await openInteractiveMenu(ctx, scope);
				return;
			}

			if (sub === "status") {
				const config = loadConfig(ctx.cwd);
				const activeLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				ctx.ui.notify(`pi-nexp: ${formatConfigSummary(config, activeLabel)}`, "info");
				return;
			}

			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				const savedPath = saveConfigPatch(scope, ctx.cwd, { enabled });
				if (!enabled) clearAll(ctx);
				ctx.ui.notify(`pi-nexp auto-predict ${enabled ? "enabled" : "disabled"} (${savedPath})`, "info");
				return;
			}

			if (sub === "run" || sub === "predict") {
				await runPrediction(ctx, true);
				return;
			}

			if (sub === "model") {
				const value = rest[0];
				if (!value) {
					ctx.ui.notify("Usage: /nexp model <provider/modelId | follow> [--project]", "warning");
					return;
				}
				if (value === "follow" || value === "default" || value === "auto" || value === "none") {
					const savedPath = saveConfigPatch(scope, ctx.cwd, { model: null });
					ctx.ui.notify(`pi-nexp model set to follow main session (${savedPath})`, "info");
					return;
				}
				const spec = parseModelSpec(value);
				if (!spec) {
					ctx.ui.notify(`Invalid model "${value}". Expected "provider/modelId" or "follow".`, "warning");
					return;
				}
				const found = ctx.modelRegistry.find(spec.provider, spec.modelId);
				if (!found) {
					ctx.ui.notify(`Model "${value}" not found in model registry.`, "warning");
					return;
				}
				const savedPath = saveConfigPatch(scope, ctx.cwd, { model: `${found.provider}/${found.id}` });
				ctx.ui.notify(`pi-nexp model set to ${found.provider}/${found.id} (${savedPath})`, "info");
				return;
			}

			if (sub === "thinking") {
				const level = rest[0];
				if (!isThinkingLevel(level)) {
					ctx.ui.notify(`Usage: /nexp thinking <${THINKING_LEVELS.join("|")}> [--project]`, "warning");
					return;
				}
				const savedPath = saveConfigPatch(scope, ctx.cwd, { thinkingLevel: level });
				ctx.ui.notify(`pi-nexp thinking level set to ${level} (${savedPath})`, "info");
				return;
			}

			ctx.ui.notify("Usage: /nexp [on|off|run|model <provider/id|follow>|thinking <level>|status] [--project]", "warning");
		},
	});
}
