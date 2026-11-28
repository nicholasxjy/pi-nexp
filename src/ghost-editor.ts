import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { FAKE_CURSOR_END, injectGhostTextIntoLine } from "./ghost-render.ts";

const GHOST_FACTORY_FLAG = Symbol.for("pi-nexp:ghost-editor-factory");
const GHOST_INSTANCE_FLAG = Symbol.for("pi-nexp:ghost-editor-instance");

export interface GhostEditorController {
	ensureInstalled(ctx: ExtensionContext): void;
	updateContext(ctx: ExtensionContext): void;
	setGhostText(text: string): void;
	clearGhostText(): void;
	getGhostText(): string;
	reset(): void;
}

export interface GhostEditorCallbacks {
	onCancelPrediction: () => boolean;
	onAcceptGhost?: () => void;
	onDismissGhost?: () => void;
}

interface WrappableEditor {
	[GHOST_INSTANCE_FLAG]?: boolean;
	paddingX?: number;
	getPaddingX?(): number;
	render(width: number): string[];
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	isShowingAutocomplete?(): boolean;
}

export function createGhostEditorController(
	callbacksOrCancel: GhostEditorCallbacks | (() => boolean),
): GhostEditorController {
	const callbacks: GhostEditorCallbacks =
		typeof callbacksOrCancel === "function" ? { onCancelPrediction: callbacksOrCancel } : callbacksOrCancel;

	let ghostText = "";
	let activeTui: TUI | undefined;
	let currentCtx: ExtensionContext | undefined;

	const requestRender = () => {
		activeTui?.requestRender();
	};

	const setGhostText = (text: string) => {
		const next = text.trim();
		if (ghostText === next) return;
		ghostText = next;
		requestRender();
	};

	const clearGhostText = () => {
		if (!ghostText) return;
		ghostText = "";
		requestRender();
	};

	const updateContext = (ctx: ExtensionContext) => {
		currentCtx = ctx;
	};

	const ensureInstalled = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui") return;
		const ui = ctx.ui;
		if (typeof ui.getEditorComponent !== "function" || typeof ui.setEditorComponent !== "function") {
			return;
		}

		const previous = ui.getEditorComponent() as
			| (((...args: any[]) => any) & { [GHOST_FACTORY_FLAG]?: boolean })
			| undefined;
		if (previous?.[GHOST_FACTORY_FLAG]) {
			return;
		}

		const factory = ((tui, theme, keybindings) => {
			activeTui = tui;
			const editor = (
				previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings)
			) as WrappableEditor;

			// Guard against double-patching when another wrapping extension sits between us and the base editor.
			if (!editor || editor[GHOST_INSTANCE_FLAG] || typeof editor.render !== "function" || typeof editor.handleInput !== "function") {
				return editor as any;
			}
			editor[GHOST_INSTANCE_FLAG] = true;

			const originalRender = editor.render.bind(editor);
			editor.render = (width: number) => {
				const lines = originalRender(width);
				if (
					!ghostText ||
					!Array.isArray(lines) ||
					lines.length === 0 ||
					editor.getText().length > 0 ||
					editor.isShowingAutocomplete?.()
				) {
					return lines;
				}

				const lineIndex = lines.findIndex((line) => line.includes(FAKE_CURSOR_END));
				if (lineIndex === -1) {
					return lines;
				}

				const paddingX = typeof editor.getPaddingX === "function" ? editor.getPaddingX() : (editor.paddingX ?? 0);
				const nextLines = [...lines];
				nextLines[lineIndex] = injectGhostTextIntoLine(nextLines[lineIndex], ghostText, paddingX, {
					truncateToWidth,
					visibleWidth,
					styleDim: (text) => (currentCtx ?? ctx).ui.theme.fg("dim", text),
				});
				return nextLines;
			};

			const originalHandleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const beforeText = editor.getText();
				const isEmpty = beforeText.length === 0;
				const showingAutocomplete = Boolean(editor.isShowingAutocomplete?.());

				if (ghostText && isEmpty && !showingAutocomplete && (matchesKey(data, "tab") || matchesKey(data, "right"))) {
					const accepted = ghostText;
					ghostText = "";
					editor.setText(accepted);
					callbacks.onAcceptGhost?.();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "escape")) {
					const hadVisibleGhost = ghostText.length > 0 && isEmpty && !showingAutocomplete;
					const hadGhost = ghostText.length > 0;
					const canceledPending = Boolean(callbacks.onCancelPrediction());
					ghostText = "";
					if (hadGhost) {
						callbacks.onDismissGhost?.();
					}

					if (!showingAutocomplete && (hadVisibleGhost || canceledPending)) {
						if (hadGhost) tui.requestRender();
						return;
					}

					originalHandleInput(data);
					if (hadGhost) tui.requestRender();
					return;
				}

				originalHandleInput(data);

				const afterText = editor.getText();
				const afterEmpty = afterText.length === 0;
				const afterAutocomplete = Boolean(editor.isShowingAutocomplete?.());
				if (afterText !== beforeText) {
					callbacks.onCancelPrediction();
				}
				if (ghostText && (isEmpty !== afterEmpty || showingAutocomplete !== afterAutocomplete)) {
					tui.requestRender();
				}
			};

			return editor as any;
		}) as Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0] & { [GHOST_FACTORY_FLAG]?: boolean };

		factory[GHOST_FACTORY_FLAG] = true;
		try {
			ui.setEditorComponent(factory);
		} catch {
			// Ignore in non-interactive modes.
		}
	};

	return {
		ensureInstalled,
		updateContext,
		setGhostText,
		clearGhostText,
		getGhostText: () => ghostText,
		reset: () => {
			ghostText = "";
			activeTui = undefined;
			currentCtx = undefined;
		},
	};
}
