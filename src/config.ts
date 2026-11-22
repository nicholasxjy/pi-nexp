import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type NexpThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface NexpConfig {
	enabled: boolean;
	model?: string;
	thinkingLevel: NexpThinkingLevel;
	maxContextChars: number;
}

export interface NexpConfigPatch {
	enabled?: boolean;
	/** Pass null to clear explicit model and follow the active session model. */
	model?: string | null;
	thinkingLevel?: NexpThinkingLevel;
	maxContextChars?: number;
}

export interface ConfigPathOptions {
	globalPath?: string;
	projectPath?: string;
}

export const DEFAULT_CONFIG: Readonly<NexpConfig> = {
	enabled: true,
	thinkingLevel: "off",
	maxContextChars: 8000,
};

const MIN_CONTEXT_CHARS = 1000;
const MAX_CONTEXT_CHARS = 64000;

export function getGlobalConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".pi", "agent", "pi-nexp.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-nexp.json");
}

export function isThinkingLevel(value: unknown): value is NexpThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
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

function readRawConfigFile(filePath: string): Record<string, unknown> | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Ignore malformed config files rather than breaking session startup.
	}
	return undefined;
}

function applyRawConfig(base: NexpConfig, raw: Record<string, unknown> | undefined): NexpConfig {
	if (!raw) return base;
	const next: NexpConfig = { ...base };

	if (typeof raw.enabled === "boolean") {
		next.enabled = raw.enabled;
	}

	if (raw.model === null || raw.model === "") {
		delete next.model;
	} else if (typeof raw.model === "string") {
		const parsed = parseModelSpec(raw.model);
		if (parsed) next.model = `${parsed.provider}/${parsed.modelId}`;
	}

	if (isThinkingLevel(raw.thinkingLevel)) {
		next.thinkingLevel = raw.thinkingLevel;
	}

	if (typeof raw.maxContextChars === "number" && Number.isFinite(raw.maxContextChars)) {
		next.maxContextChars = Math.min(
			MAX_CONTEXT_CHARS,
			Math.max(MIN_CONTEXT_CHARS, Math.round(raw.maxContextChars)),
		);
	}

	return next;
}

export function loadConfig(cwd: string, options?: ConfigPathOptions): NexpConfig {
	const globalPath = options?.globalPath ?? getGlobalConfigPath();
	const projectPath = options?.projectPath ?? getProjectConfigPath(cwd);

	const afterGlobal = applyRawConfig({ ...DEFAULT_CONFIG }, readRawConfigFile(globalPath));
	return applyRawConfig(afterGlobal, readRawConfigFile(projectPath));
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

	const existing = readRawConfigFile(targetPath) ?? {};
	const next: Record<string, unknown> = { ...existing };

	if (patch.enabled !== undefined) {
		next.enabled = patch.enabled;
	}

	if (patch.model !== undefined) {
		if (patch.model === null) {
			const globalRaw = scope === "project" ? readRawConfigFile(globalPath) : undefined;
			if (scope === "project" && typeof globalRaw?.model === "string" && globalRaw.model.trim()) {
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

	if (patch.thinkingLevel !== undefined) {
		next.thinkingLevel = patch.thinkingLevel;
	}

	if (patch.maxContextChars !== undefined) {
		next.maxContextChars = Math.min(
			MAX_CONTEXT_CHARS,
			Math.max(MIN_CONTEXT_CHARS, Math.round(patch.maxContextChars)),
		);
	}

	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return targetPath;
}
