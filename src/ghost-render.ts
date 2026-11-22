export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";

export interface GhostRenderDeps {
	truncateToWidth: (text: string, maxWidth: number, ellipsis?: string) => string;
	visibleWidth: (text: string) => number;
	styleDim: (text: string) => string;
}

/**
 * Inject single-line dim ghost text right after pi-tui's fake cursor marker on an empty editor line.
 * Preserves CURSOR_MARKER, FAKE_CURSOR markers (hardware & software cursor), left prompt prefixes
 * (e.g. pi-cc-tools `❯ `), right padding, and the exact rendered visible line width.
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

	// The portion after FAKE_CURSOR_END on an empty editor line must be trailing spaces.
	if (!/^ +$/.test(after)) return line;

	const safeRightPad = Math.max(0, Math.min(rightPaddingCols, after.length - 1));
	const availableWidth = after.length - safeRightPad;
	if (availableWidth <= 0) return line;

	const truncated = deps.truncateToWidth(singleLine, availableWidth, "…");
	if (!truncated) return line;

	const styled = deps.styleDim(truncated);
	const usedWidth = deps.visibleWidth(styled);
	const remainingSpaces = Math.max(0, after.length - usedWidth);
	return `${before}${styled}${" ".repeat(remainingSpaces)}`;
}
