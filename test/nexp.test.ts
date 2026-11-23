import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, loadConfig, parseModelSpec, saveConfigPatch } from "../src/config.ts";
import {
	buildConversationTranscript,
	cleanPredictionOutput,
	MAX_PREDICTION_CHARS,
	shouldSkipAutoPredict,
	type MessageLike,
} from "../src/context.ts";
import { FAKE_CURSOR_END, injectGhostTextIntoLine } from "../src/ghost-render.ts";
import { predictNextPrompt, resolvePredictionModel, resolveReasoningOption } from "../src/predictor.ts";

describe("config", () => {
	it("loads defaults and merges project config over global config", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-nexp-cfg-"));
		try {
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, "project.json");

			assert.deepEqual(loadConfig(dir, { globalPath, projectPath }), DEFAULT_CONFIG);

			saveConfigPatch("global", dir, { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" }, { globalPath, projectPath });
			let cfg = loadConfig(dir, { globalPath, projectPath });
			assert.equal(cfg.model, "anthropic/claude-haiku-4-5");
			assert.equal(cfg.thinkingLevel, "low");
			assert.equal(cfg.enabled, true);

			// Project overrides global model back to follow-main via null and disables auto-predict.
			saveConfigPatch("project", dir, { model: null, enabled: false, maxContextChars: 4000 }, { globalPath, projectPath });
			cfg = loadConfig(dir, { globalPath, projectPath });
			assert.equal(cfg.model, undefined);
			assert.equal(cfg.enabled, false);
			assert.equal(cfg.thinkingLevel, "low");
			assert.equal(cfg.maxContextChars, 4000);

			// Malformed JSON is ignored safely.
			writeFileSync(projectPath, "{ invalid json", "utf8");
			cfg = loadConfig(dir, { globalPath, projectPath });
			assert.equal(cfg.model, "anthropic/claude-haiku-4-5");
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
	it("skips auto-predict on aborted, error, or empty conversations", () => {
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
			const line = transcript.split("\n").find((line) => line.includes(start));
			assert.ok(line, `Expected ${start} in the transcript`);
			assert.equal(line.slice(line.indexOf(start)).length, 1200);
			assert.match(line, /\[truncated\]/);
		}
	});

	it("truncates long tool results, skips thinking blocks, and keeps the newest request and reply within budget", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "Old request" },
			{ role: "assistant", content: [{ type: "text", text: "Old reply" }] },
			{ role: "user", content: "Fix the failing parser test" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", text: "private reasoning" },
					{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
				],
			},
			{
				role: "toolResult",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "x".repeat(1000) }],
			},
			{ role: "assistant", content: [{ type: "text", text: "Fixed the parser bug in src/parser.ts." }] },
		];

		const transcript = buildConversationTranscript(messages, 2000);
		assert.doesNotMatch(transcript, /private reasoning/);
		assert.match(transcript, /ToolCall bash\(/);
		assert.match(transcript, /ToolResult bash \(error\): .*\[truncated\]/);

		const budget = 160;
		const shortened = buildConversationTranscript(messages, budget);
		assert.ok(shortened.length <= budget);
		assert.match(shortened, /^User: Fix the failing parser test/);
		assert.match(shortened, /Fixed the parser bug in src\/parser\.ts\.$/);
		assert.doesNotMatch(shortened, /Old request|Old reply/);
	});

	it("prioritizes the latest request and reply over a trailing branch summary", () => {
		for (const conversation of [
			[
				{ role: "user", content: `LATEST_REQUEST ${"u".repeat(600)}` },
				{ role: "assistant", content: `Completed ${"a".repeat(600)} TESTS_PASSED_42` },
			],
			[{ role: "assistant", content: `Completed ${"a".repeat(600)} TESTS_PASSED_42` }],
		]) {
			const transcript = buildConversationTranscript([
				...conversation,
				{ role: "branchSummary", summary: "b".repeat(1200) },
			], 1000);
			assert.ok(transcript.length <= 1000);
			assert.match(transcript, /TESTS_PASSED_42$/);
			if (conversation[0].role === "user") assert.match(transcript, /^User: LATEST_REQUEST/);
		}
	});

	it("cleans quotes, code fences, prefixes, and trailing commentary", () => {
		assert.equal(cleanPredictionOutput('  "Run npm test to verify"  '), "Run npm test to verify");
		assert.equal(cleanPredictionOutput("```text\nNext prompt: 提交当前修改\n```"), "提交当前修改");
		assert.equal(cleanPredictionOutput("运行测试验证修复\n\n因为刚才改了核心逻辑"), "运行测试验证修复");
		assert.equal(cleanPredictionOutput("   "), "");
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
	it("resolves model, degrades thinking for non-reasoning models, and sends isolated cache/session options", async () => {
		const nonReasoningModel = { provider: "anthropic", id: "claude-haiku-3", reasoning: false };
		const reasoningModel = { provider: "openai", id: "gpt-5-mini", reasoning: true };

		assert.equal(resolveReasoningOption(nonReasoningModel, "high"), undefined);
		assert.equal(resolveReasoningOption(reasoningModel, "off"), undefined);
		assert.equal(resolveReasoningOption(reasoningModel, "medium"), "medium");

		const capturedCalls: Array<{ model: unknown; context: unknown; options: Record<string, unknown> }> = [];
		const registry = {
			find(provider: string, modelId: string) {
				if (provider === "openai" && modelId === "gpt-5-mini") return reasoningModel;
				if (provider === "anthropic" && modelId === "claude-haiku-3") return nonReasoningModel;
				return undefined;
			},
			hasConfiguredAuth() {
				return true;
			},
			streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>) {
				capturedCalls.push({ model, context, options: options ?? {} });
				return {
					async result() {
						return {
							stopReason: "stop",
							content: [{ type: "text", text: '"跑一下单元测试"' }],
						};
					},
				};
			},
		};

		const messages: MessageLike[] = [
			{ role: "user", content: "实现配置模块" },
			{ role: "assistant", content: [{ type: "text", text: "已完成 config.ts" }] },
		];

		// Case 1: thinking enabled on reasoning model -> passes reasoning, omits maxTokens cap.
		const res1 = await predictNextPrompt({
			config: { enabled: true, model: "openai/gpt-5-mini", thinkingLevel: "low", maxContextChars: 8000 },
			messages,
			cwd: "/tmp/demo",
			registry,
			activeModel: nonReasoningModel,
			signal: new AbortController().signal,
			createSessionId: () => "fixed-sid-1",
		});
		assert.deepEqual(res1, { ok: true, prediction: "跑一下单元测试", modelLabel: "openai/gpt-5-mini" });
		assert.equal(capturedCalls[0].options.cacheRetention, "none");
		assert.equal(capturedCalls[0].options.sessionId, "fixed-sid-1");
		assert.equal(capturedCalls[0].options.reasoning, "low");
		assert.equal(capturedCalls[0].options.maxTokens, undefined);

		// Case 2: follow main non-reasoning model with thinkingLevel=high -> degrades reasoning and sets maxTokens.
		const res2 = await predictNextPrompt({
			config: { enabled: true, thinkingLevel: "high", maxContextChars: 8000 },
			messages,
			cwd: "/tmp/demo",
			registry,
			activeModel: nonReasoningModel,
			signal: new AbortController().signal,
			createSessionId: () => "fixed-sid-2",
		});
		assert.equal(res2.ok, true);
		assert.equal(capturedCalls[1].options.reasoning, undefined);
		assert.equal(capturedCalls[1].options.maxTokens, 160);

		// Missing configured model surfaces an actionable error.
		const missing = resolvePredictionModel(
			{ enabled: true, model: "foo/bar", thinkingLevel: "off", maxContextChars: 8000 },
			registry,
			nonReasoningModel,
		);
		assert.equal(missing.ok, false);
	});
});

describe("ghost text line injection", () => {
	const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
	const deps = {
		truncateToWidth: (text: string, maxWidth: number, ellipsis = "…") => {
			if (text.length <= maxWidth) return text;
			if (maxWidth <= ellipsis.length) return ellipsis.slice(0, maxWidth);
			return `${text.slice(0, maxWidth - ellipsis.length)}${ellipsis}`;
		},
		visibleWidth: (text: string) => stripAnsi(text).length,
		styleDim: (text: string) => `\x1b[2m${text}\x1b[22m`,
	};

	it("preserves hardware cursor marker, pi-cc-tools prefix, right padding, and exact line width", () => {
		const prefix = `\x1b[36m❯ \x1b[0m\x1b_pi:c\x07\x1b_pi:fc\x07 ${FAKE_CURSOR_END}`;
		const trailing = " ".repeat(20);
		const line = `${prefix}${trailing}`;

		const rendered = injectGhostTextIntoLine(line, "Run npm test now and inspect failures", 1, deps);
		assert.ok(rendered.startsWith(prefix));
		assert.match(rendered, /\x1b\[2mRun npm test now a…\x1b\[22m $/);
		assert.equal(deps.visibleWidth(rendered), deps.visibleWidth(line));
	});

	it("returns line unchanged if fake cursor marker is absent or non-space follows cursor", () => {
		const plain = "❯ already typed text   ";
		assert.equal(injectGhostTextIntoLine(plain, "suggestion", 0, deps), plain);

		const midLine = `\x1b_pi:fc\x07a${FAKE_CURSOR_END}bc   `;
		assert.equal(injectGhostTextIntoLine(midLine, "suggestion", 0, deps), midLine);
	});
});
