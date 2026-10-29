import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Config,
	type RemotePlan,
	configPath,
	isConfigured,
	loadConfig,
	remotePlan,
	saveConfig,
} from "../src/config";

describe("config module", () => {
	const initialEnv = { ...process.env };
	const createdDirs: string[] = [];

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "lemmeaskchat-config-test-"));
		createdDirs.push(dir);
		return dir;
	}

	beforeEach(() => {
		delete process.env.LEMMEASKCHAT_DISCORD_TOKEN;
		delete process.env.LEMMEASKCHAT_DISCORD_USER_ID;
		delete process.env.LEMMEASKCHAT_DELAY_SECONDS;
	});

	afterEach(() => {
		// Restore environment variables
		for (const key of Object.keys(process.env)) {
			if (!(key in initialEnv)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(initialEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			}
		}

		// Clean up isolated temporary directories
		for (const dir of createdDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort directory cleanup
			}
		}
		createdDirs.length = 0;
	});

	describe("defaults and resilience (never throws)", () => {
		it("returns defaults when config file does not exist", () => {
			const agentDir = makeTempDir();
			const cfg = loadConfig(agentDir);

			expect(cfg.away).toBe(false);
			expect(cfg.delaySeconds).toBe(60);
			expect(cfg.discordBotToken).toBeUndefined();
			expect(cfg.discordUserId).toBeUndefined();
		});

		it("returns defaults when agent directory itself does not exist", () => {
			const nonExistent = join(makeTempDir(), "sub", "non-existent");
			const cfg = loadConfig(nonExistent);

			expect(cfg.away).toBe(false);
			expect(cfg.delaySeconds).toBe(60);
			expect(cfg.discordBotToken).toBeUndefined();
			expect(cfg.discordUserId).toBeUndefined();
		});

		it("falls back to defaults and never throws on corrupted / invalid JSON", () => {
			const agentDir = makeTempDir();
			const dir = join(agentDir, "lemmeaskchat");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "config.json"), "{\"away\": true, corrupt json: [", "utf8");

			const cfg = loadConfig(agentDir);
			expect(cfg.away).toBe(false);
			expect(cfg.delaySeconds).toBe(60);
			expect(cfg.discordBotToken).toBeUndefined();
			expect(cfg.discordUserId).toBeUndefined();
		});

		it("falls back to defaults on non-object JSON values", () => {
			const agentDir = makeTempDir();
			const dir = join(agentDir, "lemmeaskchat");
			mkdirSync(dir, { recursive: true });
			const filePath = join(dir, "config.json");

			for (const badValue of ["\"hello\"", "123", "true", "null", "[]", ""]) {
				writeFileSync(filePath, badValue, "utf8");
				const cfg = loadConfig(agentDir);
				expect(cfg.away).toBe(false);
				expect(cfg.delaySeconds).toBe(60);
				expect(cfg.discordBotToken).toBeUndefined();
				expect(cfg.discordUserId).toBeUndefined();
			}
		});

		it("sanitizes invalid field types in JSON while preserving valid fields", () => {
			const agentDir = makeTempDir();
			const dir = join(agentDir, "lemmeaskchat");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({
					away: "not-a-bool",
					delaySeconds: -10,
					discordBotToken: 12345,
					discordUserId: "valid-user",
				}),
				"utf8",
			);

			const cfg = loadConfig(agentDir);
			expect(cfg.away).toBe(false);
			expect(cfg.delaySeconds).toBe(60);
			expect(cfg.discordBotToken).toBeUndefined();
			expect(cfg.discordUserId).toBe("valid-user");
		});
	});

	describe("persistence, mode enforcement, and file merging", () => {
		it("creates directory with 0o700 mode and file with 0o600 mode", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, { discordBotToken: "tok_test" });

			const dirPath = join(agentDir, "lemmeaskchat");
			const filePath = configPath(agentDir);

			expect(existsSync(filePath)).toBe(true);

			const dirStat = statSync(dirPath);
			expect(dirStat.mode & 0o777).toBe(0o700);

			const fileStat = statSync(filePath);
			expect(fileStat.mode & 0o777).toBe(0o600);
		});

		it("merges patch into existing file without losing unmodified fields", () => {
			const agentDir = makeTempDir();

			// First save
			saveConfig(agentDir, { discordBotToken: "tok_first", away: true });
			let disk = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
			expect(disk.discordBotToken).toBe("tok_first");
			expect(disk.away).toBe(true);
			expect(disk.discordUserId).toBeUndefined();

			// Second save with patch
			saveConfig(agentDir, { discordUserId: "user_second", delaySeconds: 30 });
			disk = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
			expect(disk.discordBotToken).toBe("tok_first");
			expect(disk.away).toBe(true);
			expect(disk.discordUserId).toBe("user_second");
			expect(disk.delaySeconds).toBe(30);

			// Third save: update away only
			saveConfig(agentDir, { away: false });
			disk = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
			expect(disk.discordBotToken).toBe("tok_first");
			expect(disk.away).toBe(false);
			expect(disk.discordUserId).toBe("user_second");
			expect(disk.delaySeconds).toBe(30);
		});

		it("removes empty string token or user id when patched with empty/whitespace", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, { discordBotToken: "tok_1", discordUserId: "usr_1" });

			saveConfig(agentDir, { discordBotToken: "" });
			const disk = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
			expect(disk.discordBotToken).toBeUndefined();
			expect(disk.discordUserId).toBe("usr_1");
		});
	});

	describe("environment variable overrides", () => {
		it("overrides file values with env variables", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, {
				discordBotToken: "file_token",
				discordUserId: "file_user",
				delaySeconds: 60,
				away: false,
			});

			process.env.LEMMEASKCHAT_DISCORD_TOKEN = "env_token";
			process.env.LEMMEASKCHAT_DISCORD_USER_ID = "env_user";
			process.env.LEMMEASKCHAT_DELAY_SECONDS = "45";

			const cfg = loadConfig(agentDir);
			expect(cfg.discordBotToken).toBe("env_token");
			expect(cfg.discordUserId).toBe("env_user");
			expect(cfg.delaySeconds).toBe(45);
			expect(cfg.away).toBe(false);
		});

		it("saveConfig never persists environment-supplied values to disk", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, {
				discordBotToken: "file_token",
				discordUserId: "file_user",
				delaySeconds: 60,
				away: false,
			});

			// Set env overrides
			process.env.LEMMEASKCHAT_DISCORD_TOKEN = "env_secret_token";
			process.env.LEMMEASKCHAT_DISCORD_USER_ID = "env_user_id";
			process.env.LEMMEASKCHAT_DELAY_SECONDS = "10";

			// Perform save with only an away toggle
			saveConfig(agentDir, { away: true });

			// Read file directly from disk
			const rawDisk = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
			expect(rawDisk.discordBotToken).toBe("file_token");
			expect(rawDisk.discordUserId).toBe("file_user");
			expect(rawDisk.delaySeconds).toBe(60);
			expect(rawDisk.away).toBe(true);

			// Unset env and confirm file values are intact
			delete process.env.LEMMEASKCHAT_DISCORD_TOKEN;
			delete process.env.LEMMEASKCHAT_DISCORD_USER_ID;
			delete process.env.LEMMEASKCHAT_DELAY_SECONDS;

			const refreshed = loadConfig(agentDir);
			expect(refreshed.discordBotToken).toBe("file_token");
			expect(refreshed.discordUserId).toBe("file_user");
			expect(refreshed.delaySeconds).toBe(60);
			expect(refreshed.away).toBe(true);
		});

		it("ignores NaN, empty, whitespace, and negative delaySeconds env vars", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, { delaySeconds: 25 });

			for (const invalid of ["not-a-number", "-1", "-100", "", "   ", "NaN"]) {
				process.env.LEMMEASKCHAT_DELAY_SECONDS = invalid;
				const cfg = loadConfig(agentDir);
				expect(cfg.delaySeconds).toBe(25);
			}
		});

		it("accepts non-negative integer delaySeconds in env, including 0", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, { delaySeconds: 30 });

			process.env.LEMMEASKCHAT_DELAY_SECONDS = "0";
			expect(loadConfig(agentDir).delaySeconds).toBe(0);

			process.env.LEMMEASKCHAT_DELAY_SECONDS = "120";
			expect(loadConfig(agentDir).delaySeconds).toBe(120);
		});

		it("accepts explicit custom env object passed to loadConfig", () => {
			const agentDir = makeTempDir();
			const customEnv: NodeJS.ProcessEnv = {
				LEMMEASKCHAT_DISCORD_TOKEN: "param_token",
				LEMMEASKCHAT_DISCORD_USER_ID: "param_user",
				LEMMEASKCHAT_DELAY_SECONDS: "15",
			};

			const cfg = loadConfig(agentDir, customEnv);
			expect(cfg.discordBotToken).toBe("param_token");
			expect(cfg.discordUserId).toBe("param_user");
			expect(cfg.delaySeconds).toBe(15);
		});
	});

	describe("fresh file reads", () => {
		it("reads fresh config from disk on every call without caching", () => {
			const agentDir = makeTempDir();
			saveConfig(agentDir, { away: false, delaySeconds: 60 });

			const first = loadConfig(agentDir);
			expect(first.away).toBe(false);

			// Direct file modification simulating external process update
			const diskPath = configPath(agentDir);
			writeFileSync(
				diskPath,
				JSON.stringify({
					away: true,
					delaySeconds: 12,
					discordBotToken: "external_tok",
					discordUserId: "external_user",
				}),
				"utf8",
			);

			const second = loadConfig(agentDir);
			expect(second.away).toBe(true);
			expect(second.delaySeconds).toBe(12);
			expect(second.discordBotToken).toBe("external_tok");
			expect(second.discordUserId).toBe("external_user");
		});
	});

	describe("isConfigured", () => {
		it("returns true only when both discordBotToken and discordUserId are non-empty strings", () => {
			expect(isConfigured({ away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordBotToken: "tok", away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordUserId: "usr", away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordBotToken: "", discordUserId: "usr", away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordBotToken: "tok", discordUserId: "", away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordBotToken: "   ", discordUserId: "usr", away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordBotToken: "tok", discordUserId: "   ", away: false, delaySeconds: 60 })).toBe(false);
			expect(isConfigured({ discordBotToken: "tok", discordUserId: "usr", away: false, delaySeconds: 60 })).toBe(true);
		});
	});

	describe("remotePlan policy branches", () => {
		it("returns send: false when unconfigured, regardless of away or delay", () => {
			expect(remotePlan({ away: true, delaySeconds: 60 })).toEqual({ send: false });
			expect(remotePlan({ away: false, delaySeconds: 30 })).toEqual({ send: false });
			expect(remotePlan({ discordBotToken: "tok", away: true, delaySeconds: 60 })).toEqual({ send: false });
			expect(remotePlan({ discordUserId: "usr", away: true, delaySeconds: 60 })).toEqual({ send: false });
			expect(remotePlan({ discordBotToken: "", discordUserId: "usr", away: true, delaySeconds: 0 })).toEqual({ send: false });
		});

		it("returns send: true, delayMs: 0 when configured and away is true", () => {
			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: true,
					delaySeconds: 60,
				}),
			).toEqual({ send: true, delayMs: 0 });

			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: true,
					delaySeconds: 0,
				}),
			).toEqual({ send: true, delayMs: 0 });

			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: true,
					delaySeconds: -10,
				}),
			).toEqual({ send: true, delayMs: 0 });
		});

		it("returns send: true, delayMs: delaySeconds * 1000 when configured, away is false, and delaySeconds > 0", () => {
			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: false,
					delaySeconds: 60,
				}),
			).toEqual({ send: true, delayMs: 60000 });

			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: false,
					delaySeconds: 15,
				}),
			).toEqual({ send: true, delayMs: 15000 });

			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: false,
					delaySeconds: 1,
				}),
			).toEqual({ send: true, delayMs: 1000 });
		});

		it("returns send: false when configured, away is false, and delaySeconds <= 0", () => {
			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: false,
					delaySeconds: 0,
				}),
			).toEqual({ send: false });

			expect(
				remotePlan({
					discordBotToken: "tok",
					discordUserId: "usr",
					away: false,
					delaySeconds: -5,
				}),
			).toEqual({ send: false });
		});
	});
});
