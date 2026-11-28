import type { ConfigDiagnostic, NexpConfig } from "./config.ts";

export type EffectivePredictionMode = "reuse" | "compact";

export type FallbackReason =
	| "explicit-model"
	| "no-snapshot"
	| "session-changed"
	| "context-changed"
	| "model-changed"
	| "snapshot-expired";

export interface PredictionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal?: number;
}

export type PredictionOutcome = "predicted" | "empty" | "aborted" | "timeout" | "error";

export interface LastPredictionRecord {
	timestamp: number;
	manual: boolean;
	configuredMode: NexpConfig["contextMode"];
	effectiveMode?: EffectivePredictionMode;
	fallbackReason?: FallbackReason;
	modelLabel?: string;
	thinkingLevel?: string;
	outcome: PredictionOutcome;
	latencyMs: number;
	usage?: PredictionUsage;
	error?: string;
}

export interface SessionStatsSnapshot {
	total: number;
	predicted: number;
	empty: number;
	aborted: number;
	timeouts: number;
	errors: number;
	accepted: number;
	dismissed: number;
	reuseRuns: number;
	compactRuns: number;
	last?: LastPredictionRecord;
}

export interface SessionStatsTracker {
	recordPrediction(record: LastPredictionRecord): void;
	recordAccept(): void;
	recordDismiss(): void;
	getSnapshot(): SessionStatsSnapshot;
	reset(): void;
}

export function createSessionStatsTracker(): SessionStatsTracker {
	const state: SessionStatsSnapshot = {
		total: 0,
		predicted: 0,
		empty: 0,
		aborted: 0,
		timeouts: 0,
		errors: 0,
		accepted: 0,
		dismissed: 0,
		reuseRuns: 0,
		compactRuns: 0,
	};

	return {
		recordPrediction(record) {
			state.total += 1;
			if (record.effectiveMode === "reuse") state.reuseRuns += 1;
			else if (record.effectiveMode === "compact") state.compactRuns += 1;

			if (record.outcome === "predicted") state.predicted += 1;
			else if (record.outcome === "empty") state.empty += 1;
			else if (record.outcome === "aborted") state.aborted += 1;
			else if (record.outcome === "timeout") state.timeouts += 1;
			else if (record.outcome === "error") state.errors += 1;

			state.last = { ...record };
		},
		recordAccept() {
			state.accepted += 1;
		},
		recordDismiss() {
			state.dismissed += 1;
		},
		getSnapshot() {
			return {
				...state,
				last: state.last ? { ...state.last } : undefined,
			};
		},
		reset() {
			state.total = 0;
			state.predicted = 0;
			state.empty = 0;
			state.aborted = 0;
			state.timeouts = 0;
			state.errors = 0;
			state.accepted = 0;
			state.dismissed = 0;
			state.reuseRuns = 0;
			state.compactRuns = 0;
			state.last = undefined;
		},
	};
}

export interface StatusSummaryInput {
	config: NexpConfig;
	activeModelLabel?: string;
	activeThinkingLevel?: string;
	projectOverrides?: ReadonlySet<keyof NexpConfig>;
	configWarnings?: readonly ConfigDiagnostic[];
	stats: SessionStatsSnapshot;
}

function formatFallbackReason(reason: FallbackReason): string {
	switch (reason) {
		case "explicit-model":
			return "explicit model configured";
		case "no-snapshot":
			return "no main request snapshot yet";
		case "session-changed":
			return "session changed";
		case "context-changed":
			return "branch/compaction/context changed";
		case "model-changed":
			return "active model changed";
		case "snapshot-expired":
			return "snapshot TTL expired";
	}
}

export function formatStatusSummary(input: StatusSummaryInput): string {
	const { config, activeModelLabel, activeThinkingLevel, projectOverrides, configWarnings, stats } = input;
	const modelLabel = config.model ?? `follow (${activeModelLabel ?? "none"})`;
	const thinkingLabel =
		config.thinkingLevel === "follow" ? `follow (${activeThinkingLevel ?? "off"})` : config.thinkingLevel;

	const lines: string[] = [
		[
			`pi-nexp: auto=${config.enabled ? "on" : "off"}`,
			`mode=${config.contextMode}`,
			`model=${modelLabel}`,
			`thinking=${thinkingLabel}`,
			`budget=${config.maxContextChars}`,
			`timeout=${config.timeoutMs}ms`,
		].join(" | "),
	];

	if (projectOverrides && projectOverrides.size > 0) {
		lines.push(`project overrides (.pi/pi-nexp.json): ${Array.from(projectOverrides).join(", ")}`);
	}

	if (configWarnings && configWarnings.length > 0) {
		lines.push(`config warnings: ${configWarnings.map((w) => w.message).join("; ")}`);
	}

	if (stats.total > 0 || stats.accepted > 0 || stats.dismissed > 0) {
		lines.push(
			`session stats: runs=${stats.total} (reuse=${stats.reuseRuns}, compact=${stats.compactRuns}), predicted=${stats.predicted}, accepted=${stats.accepted}, dismissed=${stats.dismissed}, empty=${stats.empty}, timeout=${stats.timeouts}, error=${stats.errors}`,
		);
	} else {
		lines.push("session stats: no predictions yet");
	}

	if (stats.last) {
		const last = stats.last;
		const modeDetail = last.effectiveMode
			? `${last.effectiveMode}${last.fallbackReason ? ` (${formatFallbackReason(last.fallbackReason)})` : ""}`
			: last.configuredMode;
		const usagePart = last.usage
			? `, tokens=in:${last.usage.input}/out:${last.usage.output}/cacheR:${last.usage.cacheRead}/cacheW:${last.usage.cacheWrite}`
			: "";
		const errorPart = last.error ? `, error="${last.error}"` : "";
		lines.push(
			`last run: ${last.outcome} via ${modeDetail}${last.modelLabel ? ` [${last.modelLabel}]` : ""} in ${last.latencyMs}ms${usagePart}${errorPart}`,
		);
	}

	return lines.join("\n");
}
