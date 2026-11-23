import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, saveConfigPatch } from "../src/config.ts";
import { FAKE_CURSOR_END } from "../src/ghost-render.ts";
import registerExtension from "../src/index.ts";
import type { AssistantMessageLike, ModelRegistryLike } from "../src/predictor.ts";

const escape = "\x1b";
const backspace = "\x7f";
const tab = "\t";
const right = "\x1b[C";
const suggestion = "Run the focused tests";
const model = { provider: "fixture", id: "prediction-model", reasoning: false };

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
type ExtensionEvent = { type: string } & Record<string, unknown>;
type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

function setup(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-nexp-extension-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	saveConfigPatch("project", cwd, { ...DEFAULT_CONFIG, model: `${model.provider}/${model.id}` });

	const session = SessionManager.inMemory(cwd);
	const user = (content: string) => session.appendMessage({ role: "user", content, timestamp: 0 });
	const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") => session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	});
	const firstUser = user("Earlier request to be compacted");

	let text = "";
	let autocomplete = false;
	let status: string | undefined;
	const submitted: string[] = [];
	const forwarded: string[] = [];
	const submit = (value: string) => { submitted.push(value); };
	const editor = {
		getText: () => text,
		setText: (value: string) => { text = value; },
		isShowingAutocomplete: () => autocomplete,
		onSubmit: submit,
		handleInput(data: string) {
			forwarded.push(data);
			if (matchesKey(data, "escape")) autocomplete = false;
			else if (matchesKey(data, "backspace")) text = text.slice(0, -1);
			else if (matchesKey(data, "enter")) this.onSubmit(text);
			else if (data === "x") text += data;
		},
		render: (width: number) => ["top", text ? text.padEnd(width) : FAKE_CURSOR_END + " ".repeat(width), "bottom"],
		invalidate() {},
	};
	let factory: EditorFactory = () => editor;
	const requests: Array<{ prompt: string; signal: AbortSignal; respond: (text: string) => void }> = [];
	const modelRegistry: ModelRegistryLike = {
		find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
		hasConfiguredAuth: () => true,
		streamSimple(_model, context, options) {
			assert.ok(options?.signal);
			const { promise, resolve } = Promise.withResolvers<AssistantMessageLike>();
			requests.push({
				prompt: context.messages[0].content[0].text,
				signal: options.signal,
				// Simulate a provider that still returns a result after cancellation.
				respond: (text) => resolve({ stopReason: "stop", content: [{ type: "text", text }] }),
			});
			return { result: () => promise };
		},
	};
	const ctx = {
		mode: "tui", hasUI: true, cwd, modelRegistry, sessionManager: session,
		ui: {
			theme: { fg: (_color: string, value: string) => value },
			setStatus: (_key: string, value: string | undefined) => { status = value; },
			notify() {},
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
	registerExtension({
		on: (event: string, handler: EventHandler) => events.set(event, handler),
		registerShortcut: (key: string, shortcut: { handler: (ctx: ExtensionContext) => Promise<void> }) => shortcuts.set(key, shortcut.handler),
		registerCommand() {},
		sendUserMessage: submit,
	} as unknown as ExtensionAPI);

	const emit = (event: ExtensionEvent) => events.get(event.type)?.(event, ctx);
	const render = () => editor.render(120)[1];
	const predict = () => {
		const shortcut = shortcuts.get("alt+n");
		assert.ok(shortcut, "Prediction shortcut should be registered");
		const requestIndex = requests.length;
		const done = shortcut(ctx);
		const request = requests[requestIndex];
		assert.ok(request, "Prediction should request a model response");
		return { ...request, done };
	};
	return {
		session, user, assistant, firstUser, emit, predict, requests, editor, forwarded, submitted, render,
		input: (key: string) => editor.handleInput(key),
		showAutocomplete: () => { autocomplete = true; },
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
	assert.match(auto.prompt, /Earlier conversation summary[\s\S]*Keep the latest pre-compaction request[\s\S]*Keep its pre-compaction reply as well/);
	assert.match(auto.prompt, /Abandoned branch summary[\s\S]*Replacement request after editing[\s\S]*Successful reply to the edited request/);
	assert.doesNotMatch(auto.prompt, /Earlier request to be compacted|Discarded branch request|Original request before editing|Deleted error reply/);
	auto.respond(suggestion);
	await setImmediate();
	assert.ok(app.render().includes(suggestion));

	const manual = app.predict();
	assert.equal(manual.prompt, auto.prompt);
	manual.respond("🚀".repeat(101));
	await manual.done;
	assert.equal(app.render().replace(FAKE_CURSOR_END, "").trim(), "");
	assert.equal(app.editor.getText(), "");
});

it("automatically predicts from a summary-only Pi projection", async (t) => {
	for (const role of ["compactionSummary", "branchSummary"]) {
		await t.test(role, async (t) => {
			const app = setup(t);
			const summary = "Completed the first phase of the work";
			if (role === "compactionSummary") app.session.appendCompaction(summary, null, 1000);
			else app.session.branchWithSummary(null, summary);
			assert.deepEqual(app.session.buildSessionProjection().messages.map((message) => message.role), [role]);

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
		{ type: "session_compact", compactionEntry: app.session.getEntry(compactionId), reason: "manual", fromExtension: false, willRetry: false },
	];
	for (const event of events) {
		await app.show();
		app.input("x");
		app.emit(event);
		app.input(backspace);
		assert.ok(!app.render().includes(suggestion), `Suggestion survived ${event.type}`);
	}
});
