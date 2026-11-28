export interface ContentBlockLike {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface MessageLike {
	role?: string;
	content?: unknown;
	summary?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	excludeFromContext?: boolean;
}

export const MAX_RECENT_TURNS = 6;
export const MAX_PREDICTION_CHARS = 100;
const MAX_TOOL_ARGS_CHARS = 140;
export const MAX_TOOL_RESULT_CHARS = 500;
export const MAX_BASH_OUTPUT_CHARS = 500;
export const MAX_OLDER_MESSAGE_CHARS = 1500;
const MAX_SUMMARY_CHARS = 1200;
const MIN_TRUNCATE_BUDGET_FOR_SEGMENT = 200;

export const PREDICTION_SYSTEM_PROMPT = [
	"You predict the user's single most likely next prompt in a coding-agent conversation.",
	"Rules:",
	"- Output ONLY the raw predicted user prompt text.",
	"- No explanations, no preamble, no surrounding quotes, no markdown fences, no labels, no bullet list.",
	"- Match the language, tone, and brevity of the user's most recent messages.",
	`- Keep it concrete, single-line, and actionable (usually one short phrase or sentence, at most ${MAX_PREDICTION_CHARS} characters).`,
	"- Predict what the user will actually type next (for example: run tests, fix an error, inspect a file, proceed, commit) — NEVER write an assistant reply, offer, or question.",
	"- If there is no clear next prompt to suggest, output a completely empty string (never write None, N/A, or placeholders).",
].join("\n");

export const REUSE_PREDICTION_INSTRUCTION = [
	"[pi-nexp internal prediction request — do NOT reply as the assistant and do NOT call any tools.]",
	"Predict the user's single most likely next prompt based on the conversation above.",
	"Rules:",
	"- Output ONLY the raw predicted user prompt text.",
	"- No explanations, no preamble, no surrounding quotes, no markdown fences, no labels, no bullet list.",
	"- Match the language, tone, and brevity of the user's most recent messages.",
	`- Keep it concrete, single-line, and actionable (at most ${MAX_PREDICTION_CHARS} characters).`,
	"- Never write an assistant reply, offer, or question.",
	"- If there is no clear next prompt to suggest, output a completely empty string (never write None, N/A, or placeholders).",
].join("\n");

const ABSTENTION_VALUES = new Set([
	"none",
	"n/a",
	"na",
	"null",
	"nil",
	"empty",
	"(none)",
	"(empty)",
	"(no suggestion)",
	"(no next prompt)",
	"<empty>",
	"<none>",
	"no suggestion",
	"no next prompt",
	"nothing",
	"无",
	"暂无",
	"没有",
	"无建议",
	"无需继续",
	"空",
]);

const OUTER_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
];

export function truncateEnd(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (maxChars <= 0) return "";
	if (trimmed.length <= maxChars) return trimmed;
	const suffix = " … [truncated]";
	if (maxChars <= suffix.length) {
		return trimmed.slice(0, maxChars);
	}
	const keep = maxChars - suffix.length;
	return `${trimmed.slice(0, keep).trimEnd()}${suffix}`;
}

export function truncateHeadAndTail(text: string, maxChars: number, headRatio = 0.35): string {
	const trimmed = text.trim();
	if (maxChars <= 0) return "";
	if (trimmed.length <= maxChars) return trimmed;

	const marker = trimmed.includes("\n") ? "\n… [truncated] …\n" : " … [truncated] … ";
	if (maxChars <= marker.length + 8) {
		return truncateEnd(trimmed, maxChars);
	}

	const available = maxChars - marker.length;
	const headLen = Math.floor(available * headRatio);
	const tailLen = Math.max(0, available - headLen);
	const head = trimmed.slice(0, headLen).trimEnd();
	const tail = tailLen > 0 ? trimmed.slice(trimmed.length - tailLen).trimStart() : "";
	const combined = `${head}${marker}${tail}`;
	return combined.length <= maxChars ? combined : combined.slice(0, maxChars);
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
		lines.push(`ToolCall ${block.name}(${truncateEnd(serialized, MAX_TOOL_ARGS_CHARS)})`);
	}
	return lines;
}

function formatMessageEntry(message: MessageLike, options?: { maxTextChars?: number }): string | null {
	const role = message.role;
	const maxTextChars = options?.maxTextChars;

	if (role === "user") {
		const { text, imageCount } = extractText(message.content);
		const capped = text && maxTextChars ? truncateHeadAndTail(text, maxTextChars, 0.5) : text;
		const suffix = imageCount > 0 ? (capped ? `\n[${imageCount} image(s)]` : `[${imageCount} image(s)]`) : "";
		const combined = `${capped}${suffix}`.trim();
		return combined ? `User: ${combined}` : null;
	}

	if (role === "bashExecution") {
		if (message.excludeFromContext) return null;
		const command = typeof message.command === "string" ? message.command.trim() : "";
		if (!command) return null;
		const rawOutput = typeof message.output === "string" ? message.output.replace(/\r\n/g, "\n").trim() : "";
		const statusParts: string[] = [];
		if (message.cancelled) {
			statusParts.push("cancelled");
		} else if (typeof message.exitCode === "number" && message.exitCode !== 0) {
			statusParts.push(`exit ${message.exitCode}`);
		}
		const status = statusParts.length > 0 ? ` (${statusParts.join(", ")})` : "";
		const outputPart = rawOutput ? `\n${truncateHeadAndTail(rawOutput, MAX_BASH_OUTPUT_CHARS, 0.35)}` : "";
		return `User bash: \`${command}\`${status}${outputPart}`;
	}

	if (role === "assistant") {
		const { text } = extractText(message.content);
		const capped = text && maxTextChars ? truncateHeadAndTail(text, maxTextChars, 0.4) : text;
		const toolCalls = summarizeToolCalls(message.content);
		const lines: string[] = [];
		if (capped) lines.push(`Assistant: ${capped}`);
		if (toolCalls.length > 0) lines.push(...toolCalls);
		return lines.length > 0 ? lines.join("\n") : null;
	}

	if (role === "toolResult") {
		const { text, imageCount } = extractText(message.content);
		const body = text
			? truncateHeadAndTail(text.replace(/\r\n/g, "\n"), MAX_TOOL_RESULT_CHARS, 0.35)
			: imageCount > 0
				? `[${imageCount} image(s)]`
				: "";
		if (!body) return null;
		const name = message.toolName || "tool";
		const status = message.isError ? " (error)" : "";
		return `ToolResult ${name}${status}: ${body}`;
	}

	if (role === "compactionSummary") {
		if (typeof message.summary !== "string" || !message.summary.trim()) return null;
		return `Summary (earlier conversation): ${truncateEnd(message.summary, MAX_SUMMARY_CHARS)}`;
	}

	if (role === "branchSummary") {
		if (typeof message.summary !== "string" || !message.summary.trim()) return null;
		return `Summary (branch): ${truncateEnd(message.summary, MAX_SUMMARY_CHARS)}`;
	}

	if (role === "custom") {
		const { text, imageCount } = extractText(message.content);
		const capped = text && maxTextChars ? truncateHeadAndTail(text, maxTextChars, 0.5) : text;
		const suffix = imageCount > 0 ? (capped ? `\n[${imageCount} image(s)]` : `[${imageCount} image(s)]`) : "";
		const combined = `${capped}${suffix}`.trim();
		return combined ? `Context: ${combined}` : null;
	}

	return null;
}

/**
 * Determine whether automatic prediction after agent_settled should be skipped.
 * Skips aborted runs, error endings (unless superseded by newer user/summary entries),
 * and projections with no conversation messages.
 */
export function shouldSkipAutoPredict(messages: readonly MessageLike[], aborted: boolean): boolean {
	if (aborted) return true;

	let hasConversationMessage = false;
	let lastAssistantUnresolved = false;

	for (const message of messages) {
		if (!message) continue;
		const role = message.role;
		if (
			role === "user" ||
			(role === "bashExecution" && !message.excludeFromContext) ||
			((role === "compactionSummary" || role === "branchSummary") &&
				typeof message.summary === "string" &&
				message.summary.trim().length > 0)
		) {
			hasConversationMessage = true;
			lastAssistantUnresolved = false;
			continue;
		}
		if (role === "assistant") {
			hasConversationMessage = true;
			lastAssistantUnresolved = message.stopReason === "error" || message.stopReason === "aborted";
		}
	}

	if (!hasConversationMessage) return true;
	return lastAssistantUnresolved;
}

function fitToCharBudget(segments: string[], maxChars: number): string {
	if (segments.length === 0 || maxChars <= 0) return "";

	const selected: string[] = [];
	let total = 0;

	const newest = segments[segments.length - 1];
	if (newest.length <= maxChars) {
		selected.unshift(newest);
		total = newest.length;
	} else {
		return truncateHeadAndTail(newest, maxChars, 0.35);
	}

	for (let i = segments.length - 2; i >= 0; i -= 1) {
		const segment = segments[i];
		const sep = 2;
		const remaining = maxChars - total - sep;
		if (remaining <= 0) break;

		if (segment.length <= remaining) {
			selected.unshift(segment);
			total += sep + segment.length;
			continue;
		}

		// If an earlier segment (e.g. a compact summary) fits whole inside the remaining budget,
		// skip this oversized intermediate turn so we don't crowd out that summary.
		let earlierFitsWhole = false;
		for (let j = i - 1; j >= 0; j -= 1) {
			if (segments[j].length <= remaining) {
				earlierFitsWhole = true;
				break;
			}
		}
		if (earlierFitsWhole) {
			continue;
		}

		if (remaining >= MIN_TRUNCATE_BUDGET_FOR_SEGMENT) {
			const fitted = truncateHeadAndTail(segment, remaining, 0.35);
			if (fitted) {
				selected.unshift(fitted);
			}
		}
		break;
	}

	return selected.join("\n\n");
}

export function buildConversationTranscript(
	messages: readonly MessageLike[],
	maxContextChars: number,
	maxTurns = MAX_RECENT_TURNS,
): string {
	const summaries: MessageLike[] = [];
	const preamble: MessageLike[] = [];
	const turns: MessageLike[][] = [];
	let currentTurn: MessageLike[] = [];

	for (const message of messages) {
		if (!message) continue;
		if (message.role === "bashExecution" && message.excludeFromContext) continue;

		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			if (typeof message.summary === "string" && message.summary.trim()) {
				summaries.push(message);
			}
		} else if (message.role === "user") {
			if (currentTurn.length > 0) {
				turns.push(currentTurn);
			}
			currentTurn = [message];
		} else if (message.role === "bashExecution") {
			if (formatMessageEntry(message)) {
				currentTurn.push(message);
			}
		} else if (currentTurn.length > 0) {
			currentTurn.push(message);
		} else {
			preamble.push(message);
		}
	}

	if (currentTurn.length > 0) {
		turns.push(currentTurn);
	}

	const summarySegments = summaries
		.map((msg) => formatMessageEntry(msg))
		.filter((entry): entry is string => Boolean(entry));

	const preambleParts = preamble
		.map((msg) => formatMessageEntry(msg, { maxTextChars: MAX_OLDER_MESSAGE_CHARS }))
		.filter((entry): entry is string => Boolean(entry));

	const selectedTurns = maxTurns > 0 ? turns.slice(-maxTurns) : [];
	const turnSegments = selectedTurns
		.map((turnMessages, idx) => {
			const isNewestTurn = idx === selectedTurns.length - 1;
			const formatOpts = isNewestTurn ? undefined : { maxTextChars: MAX_OLDER_MESSAGE_CHARS };
			return turnMessages
				.map((msg) => formatMessageEntry(msg, formatOpts))
				.filter((entry): entry is string => Boolean(entry))
				.join("\n");
		})
		.filter(Boolean);

	// Summaries are background context; spend the budget on recent dialogue first.
	const segments = [
		...summarySegments,
		...(preambleParts.length > 0 ? [preambleParts.join("\n")] : []),
		...turnSegments,
	];

	if (segments.length === 0) return "";
	return fitToCharBudget(segments, maxContextChars);
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

function stripOuterQuotes(value: string): string {
	let text = value.trim();
	for (const [open, close] of OUTER_QUOTE_PAIRS) {
		if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
			text = text.slice(open.length, text.length - close.length).trim();
			break;
		}
	}
	return text;
}

export function cleanPredictionOutput(rawText: string): string {
	let text = rawText.trim();
	if (!text) return "";

	// 1. Strip accidental outer fenced code block wrapper (supports hyphenated/dotted language tags).
	const fenceMatch = text.match(/^```[a-zA-Z0-9._-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/);
	if (fenceMatch) {
		text = fenceMatch[1].trim();
	}

	// 2. Keep the first non-empty block if the model added commentary after a blank line.
	const blocks = text
		.split(/\r?\n\s*\r?\n/)
		.map((block) => block.trim())
		.filter(Boolean);
	text = blocks[0] ?? "";
	if (!text) return "";

	// 3. Reject multi-line bullet lists, numbered options, or multi-line explanations (> 2 lines).
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length > 2) return "";
	if (lines.length > 1 && lines.some((line) => /^(?:[-*•]\s+|\d+[.)]\s+)/.test(line))) {
		return "";
	}
	text = lines.join(" ");

	// 4. Strip outer quotes/backticks -> strip label prefixes -> strip outer quotes again.
	text = stripOuterQuotes(text);
	text = text.replace(
		/^(?:next\s*prompt|predicted\s*prompt|user|suggestion|预测(?:的)?下一句(?:prompt)?|下一句(?:prompt)?)\s*[:：]\s*/i,
		"",
	);
	text = stripOuterQuotes(text).trim();

	if (!text) return "";

	// 5. Reject explicit abstention placeholders.
	const normalizedForAbstention = text.replace(/[.。!！]+$/, "").trim().toLowerCase();
	if (ABSTENTION_VALUES.has(normalizedForAbstention)) {
		return "";
	}

	if (Array.from(text).length > MAX_PREDICTION_CHARS) {
		return "";
	}

	return text;
}
