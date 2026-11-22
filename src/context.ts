export interface ContentBlockLike {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface MessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
}

export interface SessionEntryLike {
	type: string;
	summary?: string;
	message?: MessageLike;
}

export const MAX_RECENT_TURNS = 6;
const MAX_TOOL_ARGS_CHARS = 140;
const MAX_TOOL_RESULT_CHARS = 400;
const MAX_COMPACTION_SUMMARY_CHARS = 1200;

export const PREDICTION_SYSTEM_PROMPT = [
	"You predict the user's single most likely next prompt in a coding-agent conversation.",
	"Rules:",
	"- Output ONLY the raw predicted user prompt text.",
	"- No explanations, no preamble, no surrounding quotes, no markdown fences, no bullet list.",
	"- Write in the same language as the user's most recent message.",
	"- Keep it concise, concrete, and actionable (usually one short sentence).",
	"- Predict what the user will actually type next (for example: run tests, fix an issue, inspect a file, proceed to the next step, commit), NOT an assistant reply.",
	"- If there is no clear next prompt to suggest, output an empty string.",
].join("\n");

function truncateMiddleOrEnd(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const suffix = " … [truncated]";
	const keep = Math.max(0, maxChars - suffix.length);
	return `${trimmed.slice(0, keep).trimEnd()}${suffix}`;
}

function extractText(content: unknown): { text: string; imageCount: number } {
	if (typeof content === "string") {
		return { text: content.trim(), imageCount: 0 };
	}
	if (!Array.isArray(content)) {
		return { text: "", imageCount: 0 };
	}

	const parts: string[] = [];
	let imageCount = 0;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as ContentBlockLike;
		if (block.type === "text" && typeof block.text === "string") {
			const cleaned = block.text.trim();
			if (cleaned) parts.push(cleaned);
		} else if (block.type === "image") {
			imageCount += 1;
		}
	}
	return { text: parts.join("\n"), imageCount };
}

function summarizeToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as ContentBlockLike;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		let serialized = "";
		try {
			serialized = JSON.stringify(block.arguments ?? {});
		} catch {
			serialized = "{}";
		}
		lines.push(`ToolCall ${block.name}(${truncateMiddleOrEnd(serialized, MAX_TOOL_ARGS_CHARS)})`);
	}
	return lines;
}

function formatMessageEntry(message: MessageLike): string | null {
	const role = message.role;
	if (role === "user") {
		const { text, imageCount } = extractText(message.content);
		const suffix = imageCount > 0 ? (text ? `\n[${imageCount} image(s)]` : `[${imageCount} image(s)]`) : "";
		const combined = `${text}${suffix}`.trim();
		return combined ? `User: ${combined}` : null;
	}

	if (role === "assistant") {
		const { text } = extractText(message.content);
		const toolCalls = summarizeToolCalls(message.content);
		const lines: string[] = [];
		if (text) lines.push(`Assistant: ${text}`);
		if (toolCalls.length > 0) lines.push(...toolCalls);
		return lines.length > 0 ? lines.join("\n") : null;
	}

	if (role === "toolResult") {
		const { text, imageCount } = extractText(message.content);
		const body = text
			? truncateMiddleOrEnd(text.replace(/\r\n/g, "\n"), MAX_TOOL_RESULT_CHARS)
			: imageCount > 0
				? `[${imageCount} image(s)]`
				: "";
		if (!body) return null;
		const name = message.toolName || "tool";
		const status = message.isError ? " (error)" : "";
		return `ToolResult ${name}${status}: ${body}`;
	}

	return null;
}

/**
 * Determine whether automatic prediction after agent_settled should be skipped.
 * Skips aborted runs, error endings, and branches with no conversation messages.
 */
export function shouldSkipAutoPredict(branch: readonly SessionEntryLike[], aborted: boolean): boolean {
	if (aborted) return true;

	let hasConversationMessage = false;
	let lastAssistant: MessageLike | undefined;

	for (const entry of branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role === "user" || role === "assistant") {
			hasConversationMessage = true;
		}
		if (role === "assistant") {
			lastAssistant = entry.message;
		}
	}

	if (!hasConversationMessage) return true;
	if (lastAssistant && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")) {
		return true;
	}
	return false;
}

function fitToCharBudget(turns: string[], maxChars: number): string {
	const selected: string[] = [];
	let total = 0;

	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		const sep = selected.length > 0 ? 2 : 0;
		if (total + sep + turn.length <= maxChars) {
			selected.unshift(turn);
			total += sep + turn.length;
			continue;
		}

		if (selected.length === 0) {
			// Newest turn alone exceeds budget: keep both the user request head and latest assistant tail.
			const marker = "\n… [truncated] …\n";
			const available = Math.max(0, maxChars - marker.length);
			const headLen = Math.floor(available * 0.35);
			const tailLen = Math.max(0, available - headLen);
			selected.unshift(`${turn.slice(0, headLen).trimEnd()}${marker}${turn.slice(turn.length - tailLen).trimStart()}`);
		}
		break;
	}

	return selected.join("\n\n");
}

export function buildConversationTranscript(
	branch: readonly SessionEntryLike[],
	maxContextChars: number,
	maxTurns = MAX_RECENT_TURNS,
): string {
	// Start from the latest compaction entry if present so pre-compaction noise is excluded.
	let startIndex = 0;
	let compactionSummary: string | undefined;
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		if (branch[i]?.type === "compaction") {
			startIndex = i + 1;
			if (typeof branch[i].summary === "string" && branch[i].summary.trim()) {
				compactionSummary = truncateMiddleOrEnd(branch[i].summary, MAX_COMPACTION_SUMMARY_CHARS);
			}
			break;
		}
	}

	const turns: string[][] = [];
	let currentTurn: string[] = [];

	for (let i = startIndex; i < branch.length; i += 1) {
		const entry = branch[i];
		if (!entry || entry.type !== "message" || !entry.message) continue;
		const formatted = formatMessageEntry(entry.message);
		if (!formatted) continue;

		if (entry.message.role === "user" && currentTurn.length > 0) {
			turns.push(currentTurn);
			currentTurn = [formatted];
		} else {
			currentTurn.push(formatted);
		}
	}

	if (currentTurn.length > 0) {
		turns.push(currentTurn);
	}

	const recentTurns = turns.slice(-maxTurns).map((parts) => parts.join("\n"));
	if (compactionSummary && recentTurns.length < maxTurns) {
		recentTurns.unshift(`Summary (earlier conversation): ${compactionSummary}`);
	}

	if (recentTurns.length === 0) return "";
	return fitToCharBudget(recentTurns, maxContextChars);
}

export function buildPredictionUserPrompt(transcript: string, cwd: string): string {
	return [
		`Working directory: ${cwd}`,
		"",
		"<conversation>",
		transcript,
		"</conversation>",
		"",
		"Predict the user's next prompt:",
	].join("\n");
}

export function cleanPredictionOutput(rawText: string): string {
	let text = rawText.trim();
	if (!text) return "";

	// Strip accidental fenced code block wrapper.
	const fenceMatch = text.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/);
	if (fenceMatch) {
		text = fenceMatch[1].trim();
	}

	// If the model ignored single-prompt instructions and added commentary after a blank line, keep the first block.
	const firstBlock = text.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
	text = firstBlock;

	// Collapse multi-line output into one clean line for inline ghost text.
	text = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");

	// Strip accidental label prefixes.
	text = text.replace(/^(?:next\s*prompt|predicted\s*prompt|user|预测(?:的)?下一句(?:prompt)?|下一句(?:prompt)?)\s*[:：]\s*/i, "");

	// Strip matching wrapping quotes or backticks.
	if (
		text.length >= 2 &&
		((text.startsWith('"') && text.endsWith('"')) ||
			(text.startsWith("'") && text.endsWith("'")) ||
			(text.startsWith("`") && text.endsWith("`")) ||
			(text.startsWith("“") && text.endsWith("”")))
	) {
		text = text.slice(1, -1).trim();
	}

	return text;
}
