export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";

export interface GhostRenderDeps {
	truncateToWidth: (text: string, maxWidth: number, ellipsis?: string) => string;
	visibleWidth: (text: string) => number;
	styleDim: (text: string) => string;
}

const TRAILING_ANSI_ONLY = /^(?:\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07)*$/;
const TRAILING_BORDER_OR_RESET = /^(?:\x1b\[[0-9;]*m)*[│┃║▕\]](?:\x1b\[[0-9;]*m)* *$/;

/**
 * Inject single-line dim ghost text right after pi-tui's fake cursor marker on an empty editor line.
 * Preserves CURSOR_MARKER, FAKE_CURSOR markers (hardware & software cursor), left prompt prefixes
 * (e.g. pi-cc-tools `❯ `), trailing ANSI resets or right borders, right padding, and the exact
 * rendered visible line width.
 */
export function injectGhostTextIntoLine(
	line: string,
	ghostText: string,
	rightPaddingCols: number,
	deps: GhostRenderDeps,
): string {
	const singleLine = ghostText.replace(/\s+/g, " ").trim();
	if (!singleLine) return line;

	const cursorEndIndex = line.indexOf(FAKE_CURSOR_END);
	if (cursorEndIndex === -1) return line;

	const splitAt = cursorEndIndex + FAKE_CURSOR_END.length;
	const before = line.slice(0, splitAt);
	const after = line.slice(splitAt);

	const spaceMatch = after.match(/^( +)([\s\S]*)$/);
	if (!spaceMatch) return line;

	const leadingSpaces = spaceMatch[1];
	const trailing = spaceMatch[2];
	if (trailing && !TRAILING_ANSI_ONLY.test(trailing) && !TRAILING_BORDER_OR_RESET.test(trailing)) {
		return line;
	}

	const safeRightPad = Math.max(0, Math.min(rightPaddingCols, leadingSpaces.length - 1));
	const availableWidth = leadingSpaces.length - safeRightPad;
	if (availableWidth <= 0) return line;

	const truncated = deps.truncateToWidth(singleLine, availableWidth, "…");
	if (!truncated) return line;

	const styled = deps.styleDim(truncated);
	const usedWidth = deps.visibleWidth(styled);
	if (usedWidth > leadingSpaces.length) return line;
	const remainingSpaces = leadingSpaces.length - usedWidth;
	return `${before}${styled}${" ".repeat(remainingSpaces)}${trailing}`;
}
