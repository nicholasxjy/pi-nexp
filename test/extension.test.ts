import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, saveConfigPatch } from "../src/config.ts";
import { FAKE_CURSOR_END } from "../src/ghost-render.ts";
import registerExtension from "../src/index.ts";
import type { AssistantMessageLike, ModelRegistryLike } from "../src/predictor.ts";

const escape = "\x1b";
const backspace = "\x7f";
const tab = "\t";
const right = "\x1b[C";
const suggestion = "Run the focused tests";
const model = { provider: "fixture", id: "prediction-model", reasoning: true };

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type ExtensionEvent = { type: string } & Record<string, unknown>;
type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type RegisteredCmd = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (rawArgs: string, ctx: ExtensionContext) => Promise<void>;
};

function setup(
	t: TestContext,
	opts?: {
		initialConfig?: Omit<Partial<typeof DEFAULT_CONFIG>, "model"> & { model?: string | null };
		skipConfigWrite?: boolean;
	},
) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-nexp-extension-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	if (!opts?.skipConfigWrite) {
		saveConfigPatch("project", cwd, {
			...DEFAULT_CONFIG,
			model: `${model.provider}/${model.id}`,
			...opts?.initialConfig,
		});
	}

	const session = SessionManager.inMemory(cwd);
	const user = (content: string) => session.appendMessage({ role: "user", content, timestamp: 0 });
	const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") =>
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 0,
		});
	const firstUser = user("Earlier request to be compacted");

	let text = "";
	let autocomplete = false;
	let status: string | undefined;
	let idle = true;
	let pendingMessages = false;
	let themeTag = "t1";
	let paddingX = 0;
	let headerLines = ["top"];
	let rightBorder = "";
	const notifications: Array<{ message: string; level?: string }> = [];
	const submitted: string[] = [];
	const forwarded: string[] = [];
	let selectResponder: ((title: string, options: string[]) => string | undefined) | undefined;
	let inputResponder: ((title: string, prefill?: string) => string | undefined) | undefined;

	const submit = (value: string) => {
		submitted.push(value);
	};
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
		getPaddingX: () => paddingX,
		isShowingAutocomplete: () => autocomplete,
		onSubmit: submit,
		handleInput(data: string) {
			forwarded.push(data);
			if (matchesKey(data, "escape")) autocomplete = false;
			else if (matchesKey(data, "backspace")) text = text.slice(0, -1);
			else if (matchesKey(data, "enter")) this.onSubmit(text);
			else if (data === "x") text += data;
		},
		render: (width: number) => {
			const body = text ? text.padEnd(width) : `${FAKE_CURSOR_END}${" ".repeat(width)}${rightBorder}`;
			return [...headerLines, body, "bottom"];
		},
		invalidate() {},
	};

	let factory: EditorFactory = () => editor;
	const requests: Array<{
		prompt: string;
		messages: any[];
		options: Record<string, unknown>;
		signal: AbortSignal;
		respond: (text: string) => void;
	}> = [];
	const modelRegistry: ModelRegistryLike & { getAvailable: () => Array<typeof model> } = {
		getAvailable: () => [model],
		find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
		hasConfiguredAuth: () => true,
		streamSimple(_model, context, options) {
			assert.ok(options?.signal);
			const { promise, resolve } = Promise.withResolvers<AssistantMessageLike>();
			const firstText = context.messages[0]?.content?.[0]?.text ?? "";
			requests.push({
				prompt: typeof firstText === "string" ? firstText : "",
				messages: context.messages,
				options: (options ?? {}) as Record<string, unknown>,
				signal: options.signal,
				// Simulate a provider that still returns a result after cancellation.
				respond: (replyText) =>
					resolve({
						stopReason: "stop",
						content: [{ type: "text", text: replyText }],
						usage: { input: 100, output: 8, cacheRead: 80, cacheWrite: 0, totalTokens: 108 },
					}),
			});
			return { result: () => promise };
		},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		modelRegistry,
		sessionManager: session,
		model,
		thinkingLevel: "medium",
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
		ui: {
			theme: { fg: (_color: string, value: string) => `[${themeTag}]${value}` },
			setStatus: (_key: string, value: string | undefined) => {
				status = value;
			},
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			async select(title: string, options: string[]) {
				return selectResponder ? selectResponder(title, options) : undefined;
			},
			async input(title: string, prefill?: string) {
				return inputResponder ? inputResponder(title, prefill) : undefined;
			},
			getEditorText: editor.getText,
			getEditorComponent: () => factory,
			setEditorComponent(next: EditorFactory) {
				factory = next;
				const args = [{ requestRender() {} }, {}, {}] as unknown as Parameters<EditorFactory>;
				factory(...args);
			},
		},
	} as unknown as ExtensionContext;

	const events = new Map<string, EventHandler>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
	const commands = new Map<string, RegisteredCmd>();
	registerExtension({
		on: (event: string, handler: EventHandler) => events.set(event, handler),
		registerShortcut: (key: string, shortcut: { handler: (ctx: ExtensionContext) => Promise<void> }) =>
			shortcuts.set(key, shortcut.handler),
		registerCommand: (name: string, cmd: RegisteredCmd) => commands.set(name, cmd),
		sendUserMessage: submit,
	} as unknown as ExtensionAPI);

	const emit = (event: ExtensionEvent) => events.get(event.type)?.(event, ctx);
	const render = () => {
		const lines = editor.render(120);
		return lines[headerLines.length];
	};
	const predict = () => {
		const shortcut = shortcuts.get("alt+n");
		assert.ok(shortcut, "Prediction shortcut should be registered");
		const requestIndex = requests.length;
		const done = shortcut(ctx);
		const request = requests[requestIndex];
		assert.ok(request, "Prediction should request a model response");
		return { ...request, done };
	};
	const runCmd = (rawArgs: string) => {
		const cmd = commands.get("nexp");
		assert.ok(cmd, "Command /nexp should be registered");
		return cmd.handler(rawArgs, ctx);
	};

	return {
		cwd,
		session,
		user,
		assistant,
		firstUser,
		emit,
		predict,
		runCmd,
		commands,
		requests,
		editor,
		forwarded,
		submitted,
		notifications,
		render,
		ctx,
		setIdle: (v: boolean) => {
			idle = v;
		},
		setPendingMessages: (v: boolean) => {
			pendingMessages = v;
		},
		setThemeTag: (v: string) => {
			themeTag = v;
		},
		setPaddingX: (v: number) => {
			paddingX = v;
		},
		setHeaderLines: (v: string[]) => {
			headerLines = v;
		},
		setRightBorder: (v: string) => {
			rightBorder = v;
		},
		setSelectResponder: (fn: (title: string, options: string[]) => string | undefined) => {
			selectResponder = fn;
		},
		setInputResponder: (fn: (title: string, prefill?: string) => string | undefined) => {
			inputResponder = fn;
		},
		input: (key: string) => editor.handleInput(key),
		showAutocomplete: () => {
			autocomplete = true;
		},
		status: () => status,
		async show() {
			const pending = predict();
			pending.respond(suggestion);
			await pending.done;
			assert.ok(render().includes(suggestion));
		},
	};
}

it("uses Pi's effective conversation for automatic and manual prediction and rejects overlong responses", async (t) => {
	const app = setup(t);
	const firstKept = app.user("Keep the latest pre-compaction request");
	app.assistant("Keep its pre-compaction reply as well");
	const compacted = app.session.appendCompaction("Earlier conversation summary", firstKept, 1000);
	app.user("Discarded branch request");
	app.session.branchWithSummary(compacted, "Abandoned branch summary");
	const edited = app.user("Original request before editing");
	app.assistant("Successful reply to the edited request");
	const removed = app.assistant("Deleted error reply", "error");
	app.session.appendContextEdit(edited, { content: "Replacement request after editing" });
	app.session.appendContextEdit(removed, null);

	app.emit({ type: "agent_settled", aborted: false });
	assert.equal(app.requests.length, 1);
	const auto = app.requests[0];
	assert.match(
		auto.prompt,
		/Earlier conversation summary[\s\S]*Keep the latest pre-compaction request[\s\S]*Keep its pre-compaction reply as well/,
	);
	assert.match(
		auto.prompt,
		/Abandoned branch summary[\s\S]*Replacement request after editing[\s\S]*Successful reply to the edited request/,
	);
	assert.doesNotMatch(
		auto.prompt,
		/Earlier request to be compacted|Discarded branch request|Original request before editing|Deleted error reply/,
	);
	auto.respond(suggestion);
	await setImmediate();
	assert.ok(app.render().includes(suggestion));

	const manual = app.predict();
	assert.equal(manual.prompt, auto.prompt);
	manual.respond("🚀".repeat(101));
	await manual.done;
	assert.equal(app.render().replace(FAKE_CURSOR_END, "").replace(/\[t1\]/g, "").trim(), "");
	assert.equal(app.editor.getText(), "");
});

it("automatically predicts from a summary-only Pi projection", async (t) => {
	for (const role of ["compactionSummary", "branchSummary"]) {
		await t.test(role, async (t) => {
			const app = setup(t);
			const summary = "Completed the first phase of the work";
			if (role === "compactionSummary") app.session.appendCompaction(summary, null, 1000);
			else app.session.branchWithSummary(null, summary);
			assert.deepEqual(
				app.session.buildSessionProjection().messages.map((message) => message.role),
				[role],
			);

			app.emit({ type: "agent_settled", aborted: false });
			assert.equal(app.requests.length, 1);
			assert.ok(app.requests[0].prompt.includes(summary));
			app.requests[0].respond(suggestion);
			await setImmediate();
			assert.ok(app.render().includes(suggestion));
		});
	}
});

it("shows the same suggestion after deleting a draft and permanently dismisses it with Escape", async (t) => {
	const app = setup(t);
	await app.show();
	app.input("x");
	assert.equal(app.render().trim(), "x");
	app.input(backspace);
	assert.ok(app.render().includes(suggestion));
	assert.equal(app.requests.length, 1);
	app.input(escape);
	assert.ok(!app.render().includes(suggestion));

	await app.show();
	app.input("x");
	app.input(escape);
	app.input(backspace);
	assert.ok(!app.render().includes(suggestion));
});

it("allows autocomplete to handle Tab, Right and Escape, and accepts an ordinary suggestion without submitting", async (t) => {
	const app = setup(t);
	await app.show();
	app.showAutocomplete();
	assert.ok(!app.render().includes(suggestion));
	for (const key of [tab, right, escape]) app.input(key);
	assert.deepEqual(app.forwarded, [tab, right, escape]);
	assert.equal(app.editor.getText(), "");
	assert.ok(!app.render().includes(suggestion));

	for (const key of [tab, right]) {
		await app.show();
		app.input(key);
		assert.equal(app.editor.getText(), suggestion);
		app.editor.setText("");
		assert.ok(!app.render().includes(suggestion));
	}
	assert.deepEqual(app.forwarded, [tab, right, escape]);
	assert.deepEqual(app.submitted, []);
});

it("cancels with Escape or draft input, and discards a late response without clearing a newer request's status", async (t) => {
	const app = setup(t);
	for (const cancel of [escape, "x"]) {
		const pending = app.predict();
		app.input(cancel);
		assert.equal(pending.signal.aborted, true);
		assert.equal(app.status(), undefined);
		if (cancel === "x") app.input(backspace);
		pending.respond("Outdated suggestion");
		await pending.done;
		assert.ok(!app.render().includes("Outdated suggestion"));
	}

	const previous = app.predict();
	const replacement = app.predict();
	assert.equal(previous.signal.aborted, true);
	previous.respond("Old suggestion");
	await previous.done;
	assert.ok(app.status(), "The newer request is still pending");
	assert.ok(!app.render().includes("Old suggestion"));

	replacement.respond(suggestion);
	await replacement.done;
	assert.equal(app.status(), undefined);
	assert.ok(app.render().includes(suggestion));
});

it("clears hidden suggestions when the session branches, the agent starts or history compacts", async (t) => {
	const app = setup(t);
	const oldLeafId = app.user("Second request");
	app.session.branch(app.firstUser);
	const compactionId = app.session.appendCompaction("Session summary", app.firstUser, 1000);
	const events = [
		{ type: "session_tree", oldLeafId, newLeafId: app.firstUser },
		{ type: "agent_start" },
		{
			type: "session_compact",
			compactionEntry: app.session.getEntry(compactionId),
			reason: "manual",
			fromExtension: false,
			willRetry: false,
		},
	];
	for (const event of events) {
		await app.show();
		app.input("x");
		app.emit(event);
		app.input(backspace);
		assert.ok(!app.render().includes(suggestion), `Suggestion survived ${event.type}`);
	}
});

it("supports decorated editors (non-lines[1], right border, getPaddingX) and refreshes theme on session_start", async (t) => {
	const app = setup(t);
	app.setHeaderLines(["banner-1", "banner-2", "top-border"]);
	app.setRightBorder("│");
	app.setPaddingX(2);

	await app.show();
	const renderedLine = app.render();
	assert.ok(renderedLine.includes(`[t1]${suggestion}`));
	assert.ok(renderedLine.endsWith("│"));

	app.setThemeTag("t2");
	app.emit({ type: "session_start", reason: "reload" });
	await app.show();
	assert.ok(app.render().includes(`[t2]${suggestion}`));
});

it("runs reuse mode on auto after context_with_system -> agent_end and falls back after invalidation", async (t) => {
	// Follow active model (pass null so project config overrides any global ~/.pi/agent/pi-nexp.json model).
	const app = setup(t, { initialConfig: { model: null, contextMode: "auto", thinkingLevel: "follow" } });
	const u1 = app.user("Add unit tests");
	const a1 = { role: "assistant", content: [{ type: "text", text: "Added tests in test/nexp.test.ts" }], stopReason: "stop" };
	app.assistant("Added tests in test/nexp.test.ts");

	app.emit({
		type: "context_with_system",
		messages: [{ role: "system", content: "Main system prompt" }, { role: "user", content: "Add unit tests" }],
	});
	app.emit({ type: "agent_end", messages: [a1] });
	app.emit({ type: "agent_settled", aborted: false });

	assert.equal(app.requests.length, 1);
	const reuseReq = app.requests[0];
	assert.equal(reuseReq.options.toolChoice, "none");
	assert.equal(reuseReq.options.disableContinuation, true);
	assert.equal(reuseReq.options.cacheRetention, undefined);
	assert.equal(reuseReq.options.reasoning, "medium");
	assert.equal(reuseReq.options.sessionId, app.session.getSessionId());
	assert.equal(reuseReq.messages[0].role, "system");
	reuseReq.respond("Commit the new tests");
	await setImmediate();
	assert.ok(app.render().includes("Commit the new tests"));

	// Excluded !! bash does NOT invalidate reuse snapshot, whereas regular ! bash DOES.
	app.emit({ type: "user_bash", command: "ls", excludeFromContext: true, cwd: app.cwd });
	const stillReuse = app.predict();
	assert.equal(stillReuse.options.cacheRetention, undefined);
	stillReuse.respond(suggestion);
	await stillReuse.done;

	app.emit({ type: "user_bash", command: "git status", excludeFromContext: false, cwd: app.cwd });
	const fallbackReq = app.predict();
	assert.equal(fallbackReq.options.cacheRetention, "none");
	fallbackReq.respond(suggestion);
	await fallbackReq.done;

	// Verify model_select and session_compact also invalidate reuse.
	app.emit({ type: "context_with_system", messages: [{ role: "user", content: "Add unit tests" }] });
	app.emit({ type: "agent_end", messages: [a1] });
	app.emit({ type: "model_select", model, previousModel: model, source: "set" });
	const afterModelSwitch = app.predict();
	assert.equal(afterModelSwitch.options.cacheRetention, "none");
	afterModelSwitch.respond(suggestion);
	await afterModelSwitch.done;

	app.emit({ type: "session_tree", oldLeafId: u1, newLeafId: u1 });
	await app.runCmd("status");
	const statusNote = app.notifications.at(-1)?.message ?? "";
	assert.match(statusNote, /reuse=2, compact=2/);
});

it("enforces idle, pendingMessages, and ui_prompt guards", async (t) => {
	const app = setup(t);
	app.user("Hi");
	app.assistant("Hello");

	app.setIdle(false);
	app.emit({ type: "agent_settled", aborted: false });
	assert.equal(app.requests.length, 0);
	await app.runCmd("run");
	assert.equal(app.requests.length, 0);
	assert.match(app.notifications.at(-1)?.message ?? "", /idle/);

	app.setIdle(true);
	app.setPendingMessages(true);
	app.emit({ type: "agent_settled", aborted: false });
	assert.equal(app.requests.length, 0);
	await app.runCmd("run");
	assert.equal(app.requests.length, 0);
	assert.match(app.notifications.at(-1)?.message ?? "", /queued messages/);

	app.setPendingMessages(false);
	app.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select" });
	app.emit({ type: "agent_settled", aborted: false });
	assert.equal(app.requests.length, 0);
	app.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select" });
	app.emit({ type: "agent_settled", aborted: false });
	assert.equal(app.requests.length, 1);
	app.requests[0].respond(suggestion);
	await setImmediate();
});

it("deduplicates config warnings, supports /nexp subcommands, completions, menu, and tracks accept/dismiss", async (t) => {
	const app = setup(t, { skipConfigWrite: true });
	const projectCfg = join(app.cwd, ".pi", "pi-nexp.json");
	saveConfigPatch("project", app.cwd, { ...DEFAULT_CONFIG, model: `${model.provider}/${model.id}` });
	writeFileSync(projectCfg, "{ bad json", "utf8");

	app.emit({ type: "session_start", reason: "startup" });
	app.emit({ type: "agent_settled", aborted: false });
	const warningCount = app.notifications.filter((n) => n.level === "warning" && n.message.includes("Malformed JSON")).length;
	assert.equal(warningCount, 1);

	// Restore valid project config with enabled=false to verify global override notice.
	writeFileSync(projectCfg, JSON.stringify({ enabled: false, model: `${model.provider}/${model.id}` }), "utf8");
	await app.runCmd("mode reuse --project");
	await app.runCmd("thinking follow --project");
	await app.runCmd("budget 12000 --project");
	await app.runCmd("timeout 20s --project");

	const cfg = loadConfig(app.cwd);
	assert.equal(cfg.contextMode, "reuse");
	assert.equal(cfg.thinkingLevel, "follow");
	assert.equal(cfg.maxContextChars, 12000);
	assert.equal(cfg.timeoutMs, 20000);

	// Check argument completions
	const cmd = app.commands.get("nexp");
	assert.ok(cmd?.getArgumentCompletions);
	const modeMatches = cmd.getArgumentCompletions("mode r");
	assert.deepEqual(modeMatches, [{ value: "mode reuse", label: "reuse" }]);
	const modelMatches = cmd.getArgumentCompletions("model fix");
	assert.deepEqual(modelMatches, [{ value: "model fixture/prediction-model", label: "fixture/prediction-model" }]);
	const projectPrefixMatches = cmd.getArgumentCompletions("--project thinking f");
	assert.deepEqual(projectPrefixMatches, [{ value: "--project thinking follow", label: "follow" }]);

	// Interactive menu timeout change
	app.setSelectResponder((_title, options) => options.find((o) => o.startsWith("Timeout:")));
	app.setInputResponder(() => "12s");
	await app.runCmd("--project");
	assert.equal(loadConfig(app.cwd).timeoutMs, 12000);

	// Accept & dismiss tracking in /nexp status
	app.user("Check stats");
	app.assistant("Ready");
	await app.show();
	app.input(tab);
	app.editor.setText("");
	await app.show();
	app.input(escape);
	await app.runCmd("status");
	const statusMsg = app.notifications.at(-1)?.message ?? "";
	assert.match(statusMsg, /accepted=1, dismissed=1/);
});
