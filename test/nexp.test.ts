import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	loadConfig,
	loadConfigWithDiagnostics,
	parseModelSpec,
	saveConfigPatch,
} from "../src/config.ts";
import {
	buildConversationTranscript,
	cleanPredictionOutput,
	MAX_OLDER_MESSAGE_CHARS,
	MAX_PREDICTION_CHARS,
	shouldSkipAutoPredict,
	truncateHeadAndTail,
	type MessageLike,
} from "../src/context.ts";
import { FAKE_CURSOR_END, injectGhostTextIntoLine } from "../src/ghost-render.ts";
import {
	predictNextPrompt,
	resolvePredictionContextMode,
	resolvePredictionModel,
	resolveReasoningOption,
	REUSE_SNAPSHOT_TTL_MS,
	type ReuseRequestSnapshot,
} from "../src/predictor.ts";
import { createSessionStatsTracker, formatStatusSummary } from "../src/stats.ts";

describe("config", () => {
	it("loads defaults and merges project config over global config with diagnostics", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-nexp-cfg-"));
		try {
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, "project.json");

			assert.deepEqual(loadConfig(dir, { globalPath, projectPath }), DEFAULT_CONFIG);

			saveConfigPatch(
				"global",
				dir,
				{
					model: "anthropic/claude-haiku-4-5",
					thinkingLevel: "low",
					contextMode: "compact",
					timeoutMs: 25000,
				},
				{ globalPath, projectPath },
			);
			let loaded = loadConfigWithDiagnostics(dir, { globalPath, projectPath });
			assert.equal(loaded.config.model, "anthropic/claude-haiku-4-5");
			assert.equal(loaded.config.thinkingLevel, "low");
			assert.equal(loaded.config.contextMode, "compact");
			assert.equal(loaded.config.timeoutMs, 25000);
			assert.equal(loaded.config.enabled, true);
			assert.equal(loaded.warnings.length, 0);
			assert.equal(loaded.projectOverrides.size, 0);

			// Project overrides global model back to follow-main via null and clamps numeric bounds.
			saveConfigPatch(
				"project",
				dir,
				{ model: null, enabled: false, maxContextChars: 4000, timeoutMs: 500, contextMode: "reuse" },
				{ globalPath, projectPath },
			);
			loaded = loadConfigWithDiagnostics(dir, { globalPath, projectPath });
			assert.equal(loaded.config.model, undefined);
			assert.equal(loaded.config.enabled, false);
			assert.equal(loaded.config.thinkingLevel, "low");
			assert.equal(loaded.config.contextMode, "reuse");
			assert.equal(loaded.config.maxContextChars, 4000);
			assert.equal(loaded.config.timeoutMs, 2000);
			assert.ok(loaded.projectOverrides.has("model"));
			assert.ok(loaded.projectOverrides.has("enabled"));
			assert.ok(loaded.projectOverrides.has("contextMode"));

			// Malformed JSON produces a diagnostic warning and falls back to global values without wiping on save.
			writeFileSync(projectPath, "{ invalid json", "utf8");
			loaded = loadConfigWithDiagnostics(dir, { globalPath, projectPath });
			assert.equal(loaded.config.model, "anthropic/claude-haiku-4-5");
			assert.equal(loaded.warnings.length, 1);
			assert.equal(loaded.warnings[0].scope, "project");
			assert.match(loaded.warnings[0].message, /Malformed JSON/);

			assert.throws(
				() => saveConfigPatch("project", dir, { enabled: true }, { globalPath, projectPath }),
				/Refusing to overwrite invalid config file/,
			);
			assert.equal(readFileSync(projectPath, "utf8"), "{ invalid json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports invalid field values in diagnostics", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-nexp-invalid-fields-"));
		try {
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, "project.json");
			writeFileSync(
				globalPath,
				JSON.stringify({ contextMode: "bogus", thinkingLevel: "ultra", timeoutMs: "fast" }),
				"utf8",
			);
			const loaded = loadConfigWithDiagnostics(dir, { globalPath, projectPath });
			assert.equal(loaded.config.contextMode, "auto");
			assert.equal(loaded.config.thinkingLevel, "follow");
			assert.equal(loaded.config.timeoutMs, 15000);
			assert.equal(loaded.warnings.length, 3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates provider/modelId format", () => {
		assert.deepEqual(parseModelSpec("openai/gpt-5-mini"), { provider: "openai", modelId: "gpt-5-mini" });
		assert.deepEqual(parseModelSpec("openrouter/anthropic/claude-3.5-haiku"), {
			provider: "openrouter",
			modelId: "anthropic/claude-3.5-haiku",
		});
		assert.equal(parseModelSpec("invalid-no-slash"), null);
		assert.equal(parseModelSpec("/missing-provider"), null);
		assert.equal(parseModelSpec("missing-model/"), null);
	});

	it("removes model key cleanly when clearing global model", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-nexp-clear-"));
		try {
			const globalPath = join(dir, "global.json");
			saveConfigPatch("global", dir, { model: "google/gemini-2.5-flash" }, { globalPath });
			saveConfigPatch("global", dir, { model: null }, { globalPath });
			const raw = JSON.parse(readFileSync(globalPath, "utf8")) as Record<string, unknown>;
			assert.equal("model" in raw, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("context derivation and output cleaning", () => {
	it("skips auto-predict on aborted, unresolved error, or empty conversations", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
		];
		assert.equal(shouldSkipAutoPredict([], false), true);
		assert.equal(shouldSkipAutoPredict([{ role: "branchSummary", summary: "  " }], false), true);
		assert.equal(shouldSkipAutoPredict(messages, true), true);
		assert.equal(shouldSkipAutoPredict(messages, false), false);
		assert.equal(
			shouldSkipAutoPredict([...messages, { role: "assistant", content: [], stopReason: "error" }], false),
			true,
		);
		// Superseded error followed by a newer branch summary or bash execution does not skip.
		assert.equal(
			shouldSkipAutoPredict(
				[
					...messages,
					{ role: "assistant", content: [], stopReason: "error" },
					{ role: "branchSummary", summary: "Returned to clean branch" },
				],
				false,
			),
			false,
		);
		assert.equal(
			shouldSkipAutoPredict([{ role: "bashExecution", command: "npm test", output: "ok", excludeFromContext: true }], false),
			true,
		);
		assert.equal(
			shouldSkipAutoPredict([{ role: "bashExecution", command: "npm test", output: "ok" }], false),
			false,
		);
	});

	it("keeps head and tail of long tool results and formats bashExecution entries", () => {
		const toolOutput = `HEAD_MARKER ${"x".repeat(800)} TAIL_FAIL_42`;
		const messages: MessageLike[] = [
			{ role: "user", content: "Run tests" },
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
			},
			{
				role: "toolResult",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: toolOutput }],
			},
			{
				role: "bashExecution",
				command: "git status -sb",
				output: "M src/index.ts",
				exitCode: 0,
			},
			{
				role: "bashExecution",
				command: "secret-cmd",
				output: "should be omitted",
				excludeFromContext: true,
			},
		];

		const transcript = buildConversationTranscript(messages, 4000);
		assert.match(transcript, /HEAD_MARKER/);
		assert.match(transcript, /TAIL_FAIL_42/);
		assert.match(transcript, /User bash: `git status -sb`/);
		assert.match(transcript, /M src\/index\.ts/);
		assert.doesNotMatch(transcript, /secret-cmd|should be omitted/);

		// Small maxChars edge cases strictly satisfy length <= maxChars.
		assert.ok(truncateHeadAndTail("abcdef", 5).length <= 5);
		assert.equal(truncateHeadAndTail("abcdef", 0), "");
	});

	it("caps older turn messages and retains summaries when an intermediate turn is huge", () => {
		const messages: MessageLike[] = [
			{ role: "compactionSummary", summary: "SUMMARY_CORE_GOAL" },
			{ role: "user", content: "Older request" },
			{ role: "assistant", content: `OLD_START ${"a".repeat(2500)} OLD_END` },
			{ role: "user", content: "Latest request" },
			{ role: "assistant", content: "Latest reply" },
		];

		const transcript = buildConversationTranscript(messages, 6000);
		assert.match(transcript, /SUMMARY_CORE_GOAL/);
		assert.match(transcript, /OLD_START/);
		assert.match(transcript, /OLD_END/);
		const olderAssistantLine = transcript.split("\n").find((l) => l.includes("OLD_START"));
		assert.ok(olderAssistantLine);
		assert.ok(olderAssistantLine.length <= MAX_OLDER_MESSAGE_CHARS + 20);

		// Tight budget where older turn (1500 chars) exceeds remaining space, but summary fits whole.
		const tight = buildConversationTranscript(messages, 300);
		assert.ok(tight.length <= 300);
		assert.match(tight, /SUMMARY_CORE_GOAL/);
		assert.match(tight, /Latest reply/);
	});

	it("keeps the newest six user turns alongside leading summaries, with a limit on each summary", () => {
		const turns = [0, 1, 2, 3, 4, 5, 6];
		const messages: MessageLike[] = [
			{ role: "compactionSummary", summary: `Compacted history ${"c".repeat(1300)}` },
			{ role: "branchSummary", summary: `Previous branch ${"b".repeat(1300)}` },
			...turns.flatMap((turn) => [
				{ role: "user", content: `Request ${turn}` },
				{ role: "assistant", content: [{ type: "text", text: `Reply ${turn}` }] },
			]),
		];

		const transcript = buildConversationTranscript(messages, 8000);
		assert.deepEqual(
			transcript.match(/^(User: Request|Assistant: Reply) \d$/gm),
			turns.slice(1).flatMap((turn) => [`User: Request ${turn}`, `Assistant: Reply ${turn}`]),
		);
		for (const start of ["Compacted history", "Previous branch"]) {
			const line = transcript.split("\n").find((l) => l.includes(start));
			assert.ok(line, `Expected ${start} in the transcript`);
			assert.equal(line.slice(line.indexOf(start)).length, 1200);
			assert.match(line, /\[truncated\]/);
		}
	});

	it("cleans quotes, hyphenated fences, prefixes, and rejects lists and abstention words", () => {
		assert.equal(cleanPredictionOutput('  "Run npm test to verify"  '), "Run npm test to verify");
		assert.equal(cleanPredictionOutput("```plain-text\nNext prompt: 提交当前修改\n```"), "提交当前修改");
		assert.equal(cleanPredictionOutput('"Next prompt: \'Run npm test\'"'), "Run npm test");
		assert.equal(cleanPredictionOutput("运行测试验证修复\n\n因为刚才改了核心逻辑"), "运行测试验证修复");
		assert.equal(cleanPredictionOutput("- Run tests\n- Commit changes"), "");
		assert.equal(cleanPredictionOutput("1. Inspect logs\n2. Fix bug"), "");
		assert.equal(cleanPredictionOutput("Line 1\nLine 2\nLine 3"), "");
		for (const emptyWord of ["None", "N/A", "无", "暂无。", "(no suggestion)", "   "]) {
			assert.equal(cleanPredictionOutput(emptyWord), "");
		}
	});

	it("accepts 100 Unicode code points after cleanup and rejects 101", () => {
		assert.equal(MAX_PREDICTION_CHARS, 100);
		for (const character of ["a", "测", "🚀"]) {
			const exact = character.repeat(100);
			assert.equal(cleanPredictionOutput(`Next prompt: “${exact}”\n\nIgnored commentary`), exact);
			assert.equal(cleanPredictionOutput(exact + character), "");
		}
	});
});

describe("predictor", () => {
	it("resolves contextMode and all reuse fallback reasons", () => {
		const snapshot: ReuseRequestSnapshot = {
			messages: [{ role: "user", content: "hi" }],
			modelKey: "anthropic/claude-sonnet-4-5",
			thinkingLevel: "medium",
			sessionId: "sid-1",
			leafId: "leaf-1",
			capturedAt: 1000,
		};

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "compact" },
				resolvedModelLabel: "anthropic/claude-sonnet-4-5",
				snapshot,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-1",
				now: 2000,
			}),
			{ effectiveMode: "compact" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "auto", model: "anthropic/claude-haiku-4-5" },
				resolvedModelLabel: "anthropic/claude-haiku-4-5",
				snapshot,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-1",
				now: 2000,
			}),
			{ effectiveMode: "compact", fallbackReason: "explicit-model" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "auto" },
				resolvedModelLabel: "anthropic/claude-sonnet-4-5",
				snapshot: undefined,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-1",
				now: 2000,
			}),
			{ effectiveMode: "compact", fallbackReason: "no-snapshot" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "reuse" },
				resolvedModelLabel: "anthropic/claude-sonnet-4-5",
				snapshot,
				currentSessionId: "sid-2",
				currentLeafId: "leaf-1",
				now: 2000,
			}),
			{ effectiveMode: "compact", fallbackReason: "session-changed" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "reuse" },
				resolvedModelLabel: "anthropic/claude-sonnet-4-5",
				snapshot,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-2",
				now: 2000,
			}),
			{ effectiveMode: "compact", fallbackReason: "context-changed" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "reuse" },
				resolvedModelLabel: "openai/gpt-5",
				snapshot,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-1",
				now: 2000,
			}),
			{ effectiveMode: "compact", fallbackReason: "model-changed" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "reuse" },
				resolvedModelLabel: "anthropic/claude-sonnet-4-5",
				snapshot,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-1",
				now: 1000 + REUSE_SNAPSHOT_TTL_MS + 1,
			}),
			{ effectiveMode: "compact", fallbackReason: "snapshot-expired" },
		);

		assert.deepEqual(
			resolvePredictionContextMode({
				config: { ...DEFAULT_CONFIG, contextMode: "auto" },
				resolvedModelLabel: "anthropic/claude-sonnet-4-5",
				snapshot,
				currentSessionId: "sid-1",
				currentLeafId: "leaf-1",
				now: 1000 + REUSE_SNAPSHOT_TTL_MS,
			}),
			{ effectiveMode: "reuse" },
		);
	});

	it("handles follow thinking, reuse options, timeout, and activeModel auth check", async () => {
		const nonReasoningModel = { provider: "anthropic", id: "claude-haiku-3", reasoning: false };
		const reasoningModel = { provider: "openai", id: "gpt-5-mini", reasoning: true };
		const unauthModel = { provider: "openai", id: "gpt-no-auth", reasoning: false };

		assert.equal(resolveReasoningOption(nonReasoningModel, "high", "reuse", "medium"), undefined);
		assert.equal(resolveReasoningOption(reasoningModel, "off", "reuse", "medium"), undefined);
		assert.equal(resolveReasoningOption(reasoningModel, "follow", "reuse", "high"), "high");
		assert.equal(resolveReasoningOption(reasoningModel, "follow", "compact", "high"), undefined);
		assert.equal(resolveReasoningOption(reasoningModel, "medium", "compact", "high"), "medium");

		const capturedCalls: Array<{ context: any; options: Record<string, unknown> }> = [];
		const registry = {
			find(provider: string, modelId: string) {
				if (provider === "openai" && modelId === "gpt-5-mini") return reasoningModel;
				if (provider === "anthropic" && modelId === "claude-haiku-3") return nonReasoningModel;
				return undefined;
			},
			hasConfiguredAuth(model: { id: string }) {
				return model.id !== "gpt-no-auth";
			},
			streamSimple(_model: unknown, context: any, options?: Record<string, unknown>) {
				capturedCalls.push({ context, options: options ?? {} });
				return {
					async result() {
						return {
							stopReason: "stop",
							content: [{ type: "text", text: '"跑一下单元测试"' }],
							usage: { input: 120, output: 10, cacheRead: 100, cacheWrite: 0, totalTokens: 130 },
						};
					},
				};
			},
		};

		const missingActiveAuth = resolvePredictionModel(DEFAULT_CONFIG, registry, unauthModel);
		assert.equal(missingActiveAuth.ok, false);
		if (!missingActiveAuth.ok) {
			assert.equal(missingActiveAuth.errorKind, "config");
			assert.match(missingActiveAuth.error, /No auth configured/);
		}

		// Case 1: auto + follow main model with fresh snapshot -> reuse mode with follow thinking and toolChoice=none.
		const snapshot: ReuseRequestSnapshot = {
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "实现配置模块" },
				{ role: "assistant", content: [{ type: "text", text: "已完成 config.ts" }] },
			],
			modelKey: "openai/gpt-5-mini",
			thinkingLevel: "medium",
			sessionId: "main-sid-1",
			leafId: "leaf-1",
			capturedAt: 1000,
		};

		const resReuse = await predictNextPrompt({
			config: { ...DEFAULT_CONFIG, contextMode: "auto", thinkingLevel: "follow" },
			messages: snapshot.messages,
			cwd: "/tmp/demo",
			registry,
			activeModel: reasoningModel,
			activeThinkingLevel: "medium",
			reuseSnapshot: snapshot,
			currentSessionId: "main-sid-1",
			currentLeafId: "leaf-1",
			signal: new AbortController().signal,
			now: () => 2000,
			convertMessages: (msgs) => [...msgs],
		});
		assert.equal(resReuse.ok, true);
		if (resReuse.ok) {
			assert.equal(resReuse.effectiveMode, "reuse");
			assert.equal(resReuse.prediction, "跑一下单元测试");
			assert.equal(resReuse.usage?.cacheRead, 100);
		}
		assert.equal(capturedCalls[0].options.cacheRetention, undefined);
		assert.equal(capturedCalls[0].options.sessionId, "main-sid-1");
		assert.equal(capturedCalls[0].options.disableContinuation, true);
		assert.equal(capturedCalls[0].options.toolChoice, "none");
		assert.equal(capturedCalls[0].options.reasoning, "medium");
		assert.equal(capturedCalls[0].options.maxTokens, undefined);
		assert.equal(capturedCalls[0].context.messages.length, 4);

		// Case 2: compact mode with explicit non-reasoning model -> cacheRetention=none, fresh sessionId, maxTokens=160.
		const resCompact = await predictNextPrompt({
			config: { ...DEFAULT_CONFIG, model: "anthropic/claude-haiku-3", thinkingLevel: "high" },
			messages: [
				{ role: "user", content: "实现配置模块" },
				{ role: "assistant", content: [{ type: "text", text: "已完成 config.ts" }] },
			],
			cwd: "/tmp/demo",
			registry,
			activeModel: reasoningModel,
			signal: new AbortController().signal,
			createSessionId: () => "fixed-sid-2",
		});
		assert.equal(resCompact.ok, true);
		if (resCompact.ok) {
			assert.equal(resCompact.effectiveMode, "compact");
			assert.equal(resCompact.fallbackReason, "explicit-model");
		}
		assert.equal(capturedCalls[1].options.cacheRetention, "none");
		assert.equal(capturedCalls[1].options.sessionId, "fixed-sid-2");
		assert.equal(capturedCalls[1].options.reasoning, undefined);
		assert.equal(capturedCalls[1].options.maxTokens, 160);
	});

	it("aborts and reports timedOut when request exceeds timeoutMs", async () => {
		const model = { provider: "openai", id: "gpt-5-mini", reasoning: false };
		const slowRegistry = {
			find: () => model,
			hasConfiguredAuth: () => true,
			streamSimple(_m: unknown, _c: any, options?: { signal?: AbortSignal }) {
				return {
					result: () =>
						new Promise<any>((resolve) => {
							options?.signal?.addEventListener("abort", () => resolve({ stopReason: "aborted" }), { once: true });
						}),
				};
			},
		};

		const res = await predictNextPrompt({
			config: { ...DEFAULT_CONFIG, timeoutMs: 25 },
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			],
			cwd: "/tmp/demo",
			registry: slowRegistry,
			activeModel: model,
			signal: new AbortController().signal,
		});
		assert.equal(res.ok, false);
		if (!res.ok) {
			assert.equal(res.timedOut, true);
			assert.equal(res.aborted, undefined);
			assert.match(res.error, /timed out/);
		}
	});
});

describe("ghost text line injection with real pi-tui widths", () => {
	const realDeps = {
		truncateToWidth,
		visibleWidth,
		styleDim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	};

	it("preserves CJK/emoji widths, hardware cursor, prefix, trailing ANSI reset, and right border", () => {
		const prefix = `\x1b[36m❯ \x1b[0m\x1b_pi:c\x07\x1b_pi:fc\x07 ${FAKE_CURSOR_END}`;
		const rightBorder = `\x1b[90m│\x1b[0m`;
		const line = `${prefix}${" ".repeat(22)}${rightBorder}`;

		const rendered = injectGhostTextIntoLine(line, "运行单元测试并修复 🚀 问题", 1, realDeps);
		assert.ok(rendered.startsWith(prefix));
		assert.ok(rendered.endsWith(rightBorder));
		assert.equal(visibleWidth(rendered), visibleWidth(line));
		assert.match(rendered, /\x1b\[2m.*….*\x1b\[22m/);

		// Trailing ANSI reset without border
		const resetLine = `${prefix}${" ".repeat(20)}\x1b[0m`;
		const renderedReset = injectGhostTextIntoLine(resetLine, "Run tests", 1, realDeps);
		assert.ok(renderedReset.endsWith("\x1b[0m"));
		assert.equal(visibleWidth(renderedReset), visibleWidth(resetLine));
	});

	it("handles narrow widths cleanly and rejects non-space text after cursor", () => {
		const narrow = `${FAKE_CURSOR_END}   `;
		const renderedNarrow = injectGhostTextIntoLine(narrow, "测试很长的提示词", 0, realDeps);
		assert.equal(visibleWidth(renderedNarrow), visibleWidth(narrow));

		const plain = "❯ already typed text   ";
		assert.equal(injectGhostTextIntoLine(plain, "suggestion", 0, realDeps), plain);

		const midLine = `\x1b_pi:fc\x07a${FAKE_CURSOR_END}bc   `;
		assert.equal(injectGhostTextIntoLine(midLine, "suggestion", 0, realDeps), midLine);
	});
});

describe("session stats", () => {
	it("tracks counts, fallback reasons, and formats status summary", () => {
		const tracker = createSessionStatsTracker();
		tracker.recordPrediction({
			timestamp: 1000,
			manual: false,
			configuredMode: "auto",
			effectiveMode: "compact",
			fallbackReason: "no-snapshot",
			modelLabel: "anthropic/claude-haiku-4-5",
			thinkingLevel: "off",
			outcome: "predicted",
			latencyMs: 320,
			usage: { input: 500, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 512 },
		});
		tracker.recordAccept();

		const summary = formatStatusSummary({
			config: DEFAULT_CONFIG,
			activeModelLabel: "anthropic/claude-sonnet-4-5",
			activeThinkingLevel: "medium",
			projectOverrides: new Set(["enabled"]),
			configWarnings: [],
			stats: tracker.getSnapshot(),
		});

		assert.match(summary, /mode=auto/);
		assert.match(summary, /thinking=follow \(medium\)/);
		assert.match(summary, /project overrides \(\.pi\/pi-nexp\.json\): enabled/);
		assert.match(summary, /runs=1 \(reuse=0, compact=1\), predicted=1, accepted=1/);
		assert.match(summary, /no main request snapshot yet/);
		assert.match(summary, /in:500\/out:12/);
	});
});
