import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Config {
	discordBotToken?: string;
	discordUserId?: string;
	away: boolean;
	delaySeconds: number;
}

export type RemotePlan = { send: false } | { send: true; delayMs: number };

export function configPath(agentDir: string): string {
	return join(agentDir, "lemmeaskchat", "config.json");
}

export function isConfigured(cfg: Config): boolean {
	return (
		typeof cfg.discordBotToken === "string" &&
		cfg.discordBotToken.trim().length > 0 &&
		typeof cfg.discordUserId === "string" &&
		cfg.discordUserId.trim().length > 0
	);
}

export function remotePlan(cfg: Config): RemotePlan {
	if (!isConfigured(cfg)) {
		return { send: false };
	}
	if (cfg.away) {
		return { send: true, delayMs: 0 };
	}
	if (cfg.delaySeconds > 0) {
		return { send: true, delayMs: cfg.delaySeconds * 1000 };
	}
	return { send: false };
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Config {
	let fileObj: Record<string, unknown> = {};
	const filePath = configPath(agentDir);

	try {
		if (existsSync(filePath)) {
			const content = readFileSync(filePath, "utf8");
			const parsed = JSON.parse(content);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				fileObj = parsed as Record<string, unknown>;
			}
		}
	} catch {
		fileObj = {};
	}

	let away = false;
	if (typeof fileObj.away === "boolean") {
		away = fileObj.away;
	}

	let delaySeconds = 60;
	if (
		typeof fileObj.delaySeconds === "number" &&
		Number.isFinite(fileObj.delaySeconds) &&
		!Number.isNaN(fileObj.delaySeconds) &&
		fileObj.delaySeconds >= 0
	) {
		delaySeconds = Math.floor(fileObj.delaySeconds);
	}

	if (env.LEMMEASKCHAT_DELAY_SECONDS !== undefined && env.LEMMEASKCHAT_DELAY_SECONDS.trim() !== "") {
		const parsed = parseInt(env.LEMMEASKCHAT_DELAY_SECONDS, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) {
			delaySeconds = parsed;
		}
	}

	let discordBotToken: string | undefined;
	if (typeof fileObj.discordBotToken === "string" && fileObj.discordBotToken.trim().length > 0) {
		discordBotToken = fileObj.discordBotToken.trim();
	}
	const envToken = env.LEMMEASKCHAT_DISCORD_TOKEN?.trim();
	if (envToken && envToken.length > 0) {
		discordBotToken = envToken;
	}

	let discordUserId: string | undefined;
	if (typeof fileObj.discordUserId === "string" && fileObj.discordUserId.trim().length > 0) {
		discordUserId = fileObj.discordUserId.trim();
	}
	const envUserId = env.LEMMEASKCHAT_DISCORD_USER_ID?.trim();
	if (envUserId && envUserId.length > 0) {
		discordUserId = envUserId;
	}

	const result: Config = {
		away,
		delaySeconds,
	};
	if (discordBotToken !== undefined) {
		result.discordBotToken = discordBotToken;
	}
	if (discordUserId !== undefined) {
		result.discordUserId = discordUserId;
	}

	return result;
}

export function saveConfig(agentDir: string, patch: Partial<Config>): void {
	const filePath = configPath(agentDir);
	let existing: Record<string, unknown> = {};

	if (existsSync(filePath)) {
		try {
			const content = readFileSync(filePath, "utf8");
			const parsed = JSON.parse(content);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			existing = {};
		}
	}

	const merged: Record<string, unknown> = { ...existing };

	if ("discordBotToken" in patch) {
		if (typeof patch.discordBotToken === "string" && patch.discordBotToken.trim().length > 0) {
			merged.discordBotToken = patch.discordBotToken.trim();
		} else {
			delete merged.discordBotToken;
		}
	}

	if ("discordUserId" in patch) {
		if (typeof patch.discordUserId === "string" && patch.discordUserId.trim().length > 0) {
			merged.discordUserId = patch.discordUserId.trim();
		} else {
			delete merged.discordUserId;
		}
	}

	if ("away" in patch) {
		if (typeof patch.away === "boolean") {
			merged.away = patch.away;
		}
	}

	if ("delaySeconds" in patch) {
		if (
			typeof patch.delaySeconds === "number" &&
			Number.isFinite(patch.delaySeconds) &&
			!Number.isNaN(patch.delaySeconds) &&
			patch.delaySeconds >= 0
		) {
			merged.delaySeconds = Math.floor(patch.delaySeconds);
		}
	}

	const toSave: Record<string, unknown> = {};
	if (typeof merged.discordBotToken === "string" && merged.discordBotToken.trim().length > 0) {
		toSave.discordBotToken = merged.discordBotToken.trim();
	}
	if (typeof merged.discordUserId === "string" && merged.discordUserId.trim().length > 0) {
		toSave.discordUserId = merged.discordUserId.trim();
	}
	if (typeof merged.away === "boolean") {
		toSave.away = merged.away;
	}
	if (
		typeof merged.delaySeconds === "number" &&
		Number.isFinite(merged.delaySeconds) &&
		!Number.isNaN(merged.delaySeconds) &&
		merged.delaySeconds >= 0
	) {
		toSave.delaySeconds = Math.floor(merged.delaySeconds);
	}

	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best-effort directory permission enforcement
	}

	writeFileSync(filePath, `${JSON.stringify(toSave, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// Best-effort file permission enforcement
	}
}
