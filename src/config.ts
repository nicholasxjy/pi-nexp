import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONTEXT_MODES = ["auto", "compact", "reuse"] as const;
export type NexpContextMode = (typeof CONTEXT_MODES)[number];

export const THINKING_LEVELS = ["follow", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type NexpThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface NexpConfig {
	enabled: boolean;
	model?: string;
	contextMode: NexpContextMode;
	thinkingLevel: NexpThinkingLevel;
	maxContextChars: number;
	timeoutMs: number;
}

export interface NexpConfigPatch {
	enabled?: boolean;
	/** Pass null to clear explicit model and follow the active session model. */
	model?: string | null;
	contextMode?: NexpContextMode;
	thinkingLevel?: NexpThinkingLevel;
	maxContextChars?: number;
	timeoutMs?: number;
}

export interface ConfigPathOptions {
	globalPath?: string;
	projectPath?: string;
}

export interface ConfigDiagnostic {
	path: string;
	scope: "global" | "project";
	message: string;
}

export interface LoadedConfigResult {
	config: NexpConfig;
	warnings: ConfigDiagnostic[];
	projectOverrides: Set<keyof NexpConfig>;
}

export const MIN_CONTEXT_CHARS = 1000;
export const MAX_CONTEXT_CHARS = 64000;
export const MIN_TIMEOUT_MS = 2000;
export const MAX_TIMEOUT_MS = 120000;

export const DEFAULT_CONFIG: Readonly<NexpConfig> = {
	enabled: true,
	contextMode: "auto",
	thinkingLevel: "follow",
	maxContextChars: 8000,
	timeoutMs: 15000,
};

export function getGlobalConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".pi", "agent", "pi-nexp.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-nexp.json");
}

export function isContextMode(value: unknown): value is NexpContextMode {
	return typeof value === "string" && (CONTEXT_MODES as readonly string[]).includes(value);
}

export function isThinkingLevel(value: unknown): value is NexpThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function clampContextChars(value: number): number {
	return Math.min(MAX_CONTEXT_CHARS, Math.max(MIN_CONTEXT_CHARS, Math.round(value)));
}

export function clampTimeoutMs(value: number): number {
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

export function parseModelSpec(value: string): { provider: string; modelId: string } | null {
	const trimmed = value.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
	const provider = trimmed.slice(0, slashIndex).trim();
	const modelId = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !modelId) return null;
	return { provider, modelId };
}

type RawReadResult =
	| { status: "missing" }
	| { status: "ok"; data: Record<string, unknown> }
	| { status: "invalid"; error: string };

function readRawConfigFileWithStatus(filePath: string): RawReadResult {
	if (!existsSync(filePath)) return { status: "missing" };
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: "invalid", error: `Failed to read config: ${message}` };
	}

	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { status: "ok", data: parsed as Record<string, unknown> };
		}
		return { status: "invalid", error: "Config JSON root must be an object" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: "invalid", error: `Malformed JSON (${message})` };
	}
}

function applyRawConfig(
	base: NexpConfig,
	raw: Record<string, unknown> | undefined,
	filePath: string,
	scope: "global" | "project",
	warnings: ConfigDiagnostic[],
): { config: NexpConfig; appliedKeys: Set<keyof NexpConfig> } {
	const appliedKeys = new Set<keyof NexpConfig>();
	if (!raw) return { config: base, appliedKeys };
	const next: NexpConfig = { ...base };

	if ("enabled" in raw && raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") {
			next.enabled = raw.enabled;
			appliedKeys.add("enabled");
		} else {
			warnings.push({ path: filePath, scope, message: `Invalid "enabled" value in ${scope} config (expected boolean)` });
		}
	}

	if ("model" in raw && raw.model !== undefined) {
		if (raw.model === null || raw.model === "") {
			delete next.model;
			appliedKeys.add("model");
		} else if (typeof raw.model === "string") {
			const parsed = parseModelSpec(raw.model);
			if (parsed) {
				next.model = `${parsed.provider}/${parsed.modelId}`;
				appliedKeys.add("model");
			} else {
				warnings.push({ path: filePath, scope, message: `Invalid "model" "${raw.model}" in ${scope} config` });
			}
		} else {
			warnings.push({ path: filePath, scope, message: `Invalid "model" value in ${scope} config (expected string or null)` });
		}
	}

	if ("contextMode" in raw && raw.contextMode !== undefined) {
		if (isContextMode(raw.contextMode)) {
			next.contextMode = raw.contextMode;
			appliedKeys.add("contextMode");
		} else {
			warnings.push({
				path: filePath,
				scope,
				message: `Invalid "contextMode" "${String(raw.contextMode)}" in ${scope} config`,
			});
		}
	}

	if ("thinkingLevel" in raw && raw.thinkingLevel !== undefined) {
		if (isThinkingLevel(raw.thinkingLevel)) {
			next.thinkingLevel = raw.thinkingLevel;
			appliedKeys.add("thinkingLevel");
		} else {
			warnings.push({
				path: filePath,
				scope,
				message: `Invalid "thinkingLevel" "${String(raw.thinkingLevel)}" in ${scope} config`,
			});
		}
	}

	if ("maxContextChars" in raw && raw.maxContextChars !== undefined) {
		if (typeof raw.maxContextChars === "number" && Number.isFinite(raw.maxContextChars)) {
			next.maxContextChars = clampContextChars(raw.maxContextChars);
			appliedKeys.add("maxContextChars");
		} else {
			warnings.push({
				path: filePath,
				scope,
				message: `Invalid "maxContextChars" value in ${scope} config (expected finite number)`,
			});
		}
	}

	if ("timeoutMs" in raw && raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
			next.timeoutMs = clampTimeoutMs(raw.timeoutMs);
			appliedKeys.add("timeoutMs");
		} else {
			warnings.push({
				path: filePath,
				scope,
				message: `Invalid "timeoutMs" value in ${scope} config (expected finite number)`,
			});
		}
	}

	return { config: next, appliedKeys };
}

export function loadConfigWithDiagnostics(cwd: string, options?: ConfigPathOptions): LoadedConfigResult {
	const globalPath = options?.globalPath ?? getGlobalConfigPath();
	const projectPath = options?.projectPath ?? getProjectConfigPath(cwd);
	const warnings: ConfigDiagnostic[] = [];

	const globalRead = readRawConfigFileWithStatus(globalPath);
	if (globalRead.status === "invalid") {
		warnings.push({ path: globalPath, scope: "global", message: globalRead.error });
	}
	const afterGlobal = applyRawConfig(
		{ ...DEFAULT_CONFIG },
		globalRead.status === "ok" ? globalRead.data : undefined,
		globalPath,
		"global",
		warnings,
	);

	const projectRead = readRawConfigFileWithStatus(projectPath);
	if (projectRead.status === "invalid") {
		warnings.push({ path: projectPath, scope: "project", message: projectRead.error });
	}
	const afterProject = applyRawConfig(
		afterGlobal.config,
		projectRead.status === "ok" ? projectRead.data : undefined,
		projectPath,
		"project",
		warnings,
	);

	return {
		config: afterProject.config,
		warnings,
		projectOverrides: afterProject.appliedKeys,
	};
}

export function loadConfig(cwd: string, options?: ConfigPathOptions): NexpConfig {
	return loadConfigWithDiagnostics(cwd, options).config;
}

export function saveConfigPatch(
	scope: "global" | "project",
	cwd: string,
	patch: NexpConfigPatch,
	options?: ConfigPathOptions,
): string {
	const globalPath = options?.globalPath ?? getGlobalConfigPath();
	const projectPath = options?.projectPath ?? getProjectConfigPath(cwd);
	const targetPath = scope === "project" ? projectPath : globalPath;

	const existingRead = readRawConfigFileWithStatus(targetPath);
	if (existingRead.status === "invalid") {
		throw new Error(`Refusing to overwrite invalid config file "${targetPath}": ${existingRead.error}`);
	}

	const next: Record<string, unknown> = existingRead.status === "ok" ? { ...existingRead.data } : {};

	if (patch.enabled !== undefined) {
		next.enabled = patch.enabled;
	}

	if (patch.model !== undefined) {
		if (patch.model === null) {
			const globalRead = scope === "project" ? readRawConfigFileWithStatus(globalPath) : undefined;
			const globalModel = globalRead?.status === "ok" ? globalRead.data.model : undefined;
			if (scope === "project" && typeof globalModel === "string" && globalModel.trim()) {
				// Keep an explicit null in project config so it overrides the global model back to follow-main.
				next.model = null;
			} else {
				delete next.model;
			}
		} else {
			const parsed = parseModelSpec(patch.model);
			if (!parsed) {
				throw new Error(`Invalid model "${patch.model}". Expected "provider/modelId".`);
			}
			next.model = `${parsed.provider}/${parsed.modelId}`;
		}
	}

	if (patch.contextMode !== undefined) {
		next.contextMode = patch.contextMode;
	}

	if (patch.thinkingLevel !== undefined) {
		next.thinkingLevel = patch.thinkingLevel;
	}

	if (patch.maxContextChars !== undefined) {
		next.maxContextChars = clampContextChars(patch.maxContextChars);
	}

	if (patch.timeoutMs !== undefined) {
		next.timeoutMs = clampTimeoutMs(patch.timeoutMs);
	}

	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return targetPath;
}
