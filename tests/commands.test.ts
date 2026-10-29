import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfigured, loadConfig, saveConfig } from "../src/config.ts";
import { DiscordBridge, getBridge, getCurrentBridge } from "../src/discord/bridge.ts";
import type { FetchImpl } from "../src/discord/rest.ts";
import type {
	HostApi,
	HostCommandContext,
	HostCommandOptions,
	HostContext,
	HostEventHandler,
	HostLogger,
	HostToolDefinition,
	ToolInfoLite,
} from "../src/host.ts";
import lemmeaskchat from "../src/index.ts";

interface RecordedNotification {
	message: string;
	type?: "info" | "warning" | "error" | undefined;
}

function defined<T>(value: T | undefined | null, message = "Expected value to be defined"): T {
	if (value === undefined || value === null) {
		throw new Error(message);
	}
	return value;
}

interface FakeHostContextOptions {
	agentKind?: "main" | "sub";
	hasUI?: boolean;
	cwd?: string;
	inputs?: Array<string | undefined>;
}

function createFakeCommandContext(options: FakeHostContextOptions = {}): HostCommandContext & {
	notifications: RecordedNotification[];
	statuses: Map<string, string | undefined>;
	inputsPrompted: Array<{ title: string; placeholder?: string | undefined }>;
} {
	const notifications: RecordedNotification[] = [];
	const statuses = new Map<string, string | undefined>();
	const inputsPrompted: Array<{ title: string; placeholder?: string | undefined }> = [];
	const inputQueue = [...(options.inputs ?? [])];

	const ctx: HostCommandContext & {
		notifications: RecordedNotification[];
		statuses: Map<string, string | undefined>;
		inputsPrompted: Array<{ title: string; placeholder?: string | undefined }>;
	} = {
		notifications,
		statuses,
		inputsPrompted,
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? "/test/project",
		agent: { kind: options.agentKind ?? "main" },
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push(type !== undefined ? { message, type } : { message });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
			async input(title: string, placeholder?: string) {
				inputsPrompted.push(placeholder !== undefined ? { title, placeholder } : { title });
				return inputQueue.shift();
			},
		},
	};

	return ctx;
}
function createMockBridge(conversationSender?: (msg: string) => Promise<void>) {
	const sentMessages: string[] = [];
	let promptHandler: ((text: string) => void) | undefined;
	const conv = {
		closed: false,
		async send(content: string) {
			sentMessages.push(content);
			if (conversationSender) {
				await conversationSender(content);
			}
		},
		close() {
			this.closed = true;
		},
	};
	return {
		sentMessages,
		get promptHandler() {
			return promptHandler;
		},
		conv,
		openConversation: async (onPrompt: (text: string) => void) => {
			promptHandler = onPrompt;
			return conv;
		},
	};
}

interface FakeHostApi {
	api: HostApi;
	eventHandlers: Map<string, HostEventHandler<unknown>[]>;
	tools: HostToolDefinition<unknown, unknown>[];
	getCommand(): HostCommandOptions;
	emit: (event: string, ctx: HostContext) => Promise<void>;
}

const createdHosts: FakeHostApi[] = [];

function createFakeHostApi(agentDir: string): FakeHostApi {
	const eventHandlers = new Map<string, HostEventHandler<unknown>[]>();
	const tools: HostToolDefinition<unknown, unknown>[] = [];
	let registeredCommand: { name: string; options: HostCommandOptions } | undefined;
	const logger: HostLogger = {
		warn: () => {},
		debug: () => {},
		info: () => {},
		error: () => {},
	};

	const api: HostApi = {
		on(event: string, handler: HostEventHandler<unknown>) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerTool(tool: HostToolDefinition<unknown, unknown>) {
			tools.push(tool);
		},
		registerCommand(name: string, options: HostCommandOptions) {
			registeredCommand = { name, options };
		},
		getAllTools(): ToolInfoLite[] {
			return [
				{
					name: "ask",
					description: "Native ask description",
					parameters: { type: "object" },
					sourceInfo: { source: "builtin" },
				},
			];
		},
		logger,
		pi: {
			getAgentDir(): string {
				return agentDir;
			},
		},
	};

	const host: FakeHostApi = {
		api,
		eventHandlers,
		tools,
		getCommand(): HostCommandOptions {
			if (!registeredCommand) {
				throw new Error("No command registered by plugin");
			}
			return registeredCommand.options;
		},
		emit: async (event: string, ctx: HostContext) => {
			const handlers = eventHandlers.get(event) ?? [];
			for (const h of handlers) {
				await h({}, ctx);
			}
		},
	};
	createdHosts.push(host);
	return host;
}

describe("/lemmeaskchat commands & lifecycle", () => {
	const initialEnv = { ...process.env };
	const originalFetch: typeof globalThis.fetch = globalThis.fetch;
	const createdDirs: string[] = [];

	function stubFetch(impl: FetchImpl): void {
		globalThis.fetch = impl as unknown as typeof globalThis.fetch;
	}

	function makeTempAgentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "lemmeaskchat-cmd-test-"));
		createdDirs.push(dir);
		return dir;
	}

	beforeEach(() => {
		delete process.env.LEMMEASKCHAT_DISCORD_TOKEN;
		delete process.env.LEMMEASKCHAT_DISCORD_USER_ID;
		delete process.env.LEMMEASKCHAT_DELAY_SECONDS;
	});

	afterEach(async () => {
		// Clean up any controller timers by emitting session_shutdown for all created hosts
		for (const host of createdHosts) {
			try {
				await host.emit(
					"session_shutdown",
					createFakeCommandContext({ agentKind: "main", hasUI: true }),
				);
			} catch {
				// ignore
			}
		}
		createdHosts.length = 0;

		// Clean up any singleton bridge instance
		const bridge = getCurrentBridge();
		if (bridge) {
			try {
				await bridge.shutdownAll("shutdown");
			} catch {
				// ignore
			}
		}

		// Restore env
		for (const key of Object.keys(process.env)) {
			if (!(key in initialEnv)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(initialEnv)) {
			process.env[key] = value;
		}

		// Restore global fetch
		globalThis.fetch = originalFetch;

		// Clean up temp directories
		for (const dir of createdDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
		createdDirs.length = 0;
	});

	describe("status reporting & token masking", () => {
		it("bare command invocation defaults to status reporting", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("info");
		});

		it("masks token showing only last 4 chars preceded by ellipsis, never revealing the secret", async () => {
			const agentDir = makeTempAgentDir();
			const secretToken = "super-confidential-bot-token-xyz-9876";
			saveConfig(agentDir, {
				discordBotToken: secretToken,
				discordUserId: "555566667777888899",
				away: true,
				delaySeconds: 15,
			});

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("status", ctx);

			expect(ctx.notifications.length).toBe(1);
			const msg = defined(ctx.notifications[0]).message;

			expect(msg).toContain("Token: …9876");
			expect(msg).toContain("555566667777888899");

			// Absolute guarantee: the unmasked token secret never appears in the output
			expect(msg).not.toContain(secretToken);
			expect(msg).not.toContain("super-confidential");
			expect(msg).not.toContain("bot-token-xyz");
		});

		it("handles whitespace padding around status argument", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("   status   ", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("info");
		});
	});

	describe("away mode toggles, explicit states, and persistence", () => {
		it("rejects enabling away mode when unconfigured without setting false status", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("away", ctx);

			expect(loadConfig(agentDir).away).toBe(false);
			expect(ctx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(defined(ctx.notifications[0]).message).toContain("not configured");
		});

		it("toggles away mode with bare 'away' command when configured", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, {
				discordBotToken: "mock-token",
				discordUserId: "mock-user",
			});
			const mockBridge = createMockBridge();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api, { bridgeFactory: () => mockBridge });
			const command = host.getCommand();

			// Initial state is away: false
			expect(loadConfig(agentDir).away).toBe(false);

			// First toggle -> on
			const ctx1 = createFakeCommandContext();
			await command.handler("away", ctx1);

			expect(loadConfig(agentDir).away).toBe(true);
			expect(ctx1.statuses.get("lemmeaskchat")).toBe("away → Discord");
			expect(ctx1.notifications.length).toBe(1);
			expect(defined(ctx1.notifications[0]).type).toBe("info");
			expect(mockBridge.sentMessages.length).toBe(1);

			// Second toggle -> off
			const ctx2 = createFakeCommandContext();
			await command.handler("away", ctx2);

			expect(loadConfig(agentDir).away).toBe(false);
			expect(ctx2.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(ctx2.notifications.length).toBe(1);
			expect(defined(ctx2.notifications[0]).type).toBe("info");
			expect(mockBridge.conv.closed).toBe(true);
		});

		it("sets away mode explicitly with 'away on' and 'away off'", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, {
				discordBotToken: "mock-token",
				discordUserId: "mock-user",
			});
			const mockBridge = createMockBridge();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api, { bridgeFactory: () => mockBridge });
			const command = host.getCommand();

			// Explicit 'away on'
			const ctxOn = createFakeCommandContext();
			await command.handler("away on", ctxOn);

			expect(loadConfig(agentDir).away).toBe(true);
			expect(ctxOn.statuses.get("lemmeaskchat")).toBe("away → Discord");
			expect(ctxOn.notifications.length).toBe(1);
			expect(defined(ctxOn.notifications[0]).type).toBe("info");

			// Explicit 'away off'
			const ctxOff = createFakeCommandContext();
			await command.handler("away off", ctxOff);

			expect(loadConfig(agentDir).away).toBe(false);
			expect(ctxOff.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(ctxOff.notifications.length).toBe(1);
			expect(defined(ctxOff.notifications[0]).type).toBe("info");
			expect(mockBridge.conv.closed).toBe(true);
		});

		it("rejects invalid away arguments without modifying config or UI status", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { away: true });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("away maybe", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(ctx.statuses.size).toBe(0);
			// Config must remain unmodified
			expect(loadConfig(agentDir).away).toBe(true);
		});
	});

	describe("timeout configuration and validation", () => {
		it("status command reports current timeout", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("status", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).message).toContain("Timeout: 900s");
		});

		it("argument completions include timeout subcommand", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const rawCompletions = await command.getArgumentCompletions?.("time");
			const completions = rawCompletions ?? [];
			expect(completions.map((c) => c.value)).toContain("timeout");
		});

		it("persists valid timeout and notifies user", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("timeout 1800", ctx);

			expect(loadConfig(agentDir).awayTimeoutSeconds).toBe(1800);
			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("info");
			expect(defined(ctx.notifications[0]).message).toBe("Timeout set to 1800 seconds.");
		});

		it("handles singular second grammar for timeout 1", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("timeout 1", ctx);

			expect(loadConfig(agentDir).awayTimeoutSeconds).toBe(1);
			expect(defined(ctx.notifications[0]).message).toBe("Timeout set to 1 second.");
		});

		it("rejects bare timeout with usage error", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { awayTimeoutSeconds: 600 });
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("timeout", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(defined(ctx.notifications[0]).message).toBe("Usage: /lemmeaskchat timeout <seconds>");
			expect(loadConfig(agentDir).awayTimeoutSeconds).toBe(600);
		});

		it("strictly rejects 0, negative values, non-integers, and out-of-range values", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { awayTimeoutSeconds: 900 });
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const invalidInputs = ["timeout 0", "timeout -10", "timeout 12.5", "timeout abc", "timeout 2147484"];
			for (const input of invalidInputs) {
				const ctx = createFakeCommandContext();
				await command.handler(input, ctx);
				expect(ctx.notifications.length).toBe(1);
				expect(defined(ctx.notifications[0]).type).toBe("error");
				expect(defined(ctx.notifications[0]).message).toContain("Invalid timeout");
			}
			expect(loadConfig(agentDir).awayTimeoutSeconds).toBe(900);
		});
	});

	describe("delay configuration, zero handling, and strict input validation", () => {
		it("persists valid non-negative delay values and notifies user", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			// 30 seconds
			const ctx30 = createFakeCommandContext();
			await command.handler("delay 30", ctx30);
			expect(loadConfig(agentDir).delaySeconds).toBe(30);
			expect(ctx30.notifications.length).toBe(1);
			expect(defined(ctx30.notifications[0]).type).toBe("info");

			// 1 second (singular)
			const ctx1 = createFakeCommandContext();
			await command.handler("delay 1", ctx1);
			expect(loadConfig(agentDir).delaySeconds).toBe(1);
			expect(ctx1.notifications.length).toBe(1);
			expect(defined(ctx1.notifications[0]).type).toBe("info");
		});

		it("persists delay 0 which explicitly disables the delayed DM", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { delaySeconds: 45 });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx0 = createFakeCommandContext();
			await command.handler("delay 0", ctx0);

			expect(loadConfig(agentDir).delaySeconds).toBe(0);
			expect(ctx0.notifications.length).toBe(1);
			expect(defined(ctx0.notifications[0]).type).toBe("info");
		});

		it("strictly rejects bare delay with usage error and does not mutate config", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { delaySeconds: 25 });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("delay", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(loadConfig(agentDir).delaySeconds).toBe(25);
		});

		it("strictly rejects negative integers without mutating config", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { delaySeconds: 20 });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("delay -5", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(loadConfig(agentDir).delaySeconds).toBe(20);
		});

		it("strictly rejects decimals and floating point numbers without mutating config", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { delaySeconds: 15 });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("delay 1.5", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(loadConfig(agentDir).delaySeconds).toBe(15);
		});

		it("strictly rejects non-numeric strings and multiple arguments", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { delaySeconds: 10 });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctxText = createFakeCommandContext();
			await command.handler("delay sixty", ctxText);
			expect(defined(ctxText.notifications[0]).type).toBe("error");
			expect(loadConfig(agentDir).delaySeconds).toBe(10);

			const ctxMulti = createFakeCommandContext();
			await command.handler("delay 10 20", ctxMulti);
			expect(defined(ctxMulti.notifications[0]).type).toBe("error");
			expect(loadConfig(agentDir).delaySeconds).toBe(10);
		});
	});

	describe("setup wizard, prompt aborts, and validation failure handling", () => {
		it("aborts setup when bot token prompt is cancelled or empty without saving", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			// 1. Cancelled (returns undefined)
			const ctxUndefined = createFakeCommandContext({ inputs: [undefined] });
			await command.handler("setup", ctxUndefined);

			expect(ctxUndefined.inputsPrompted.length).toBe(1);
			expect(defined(ctxUndefined.inputsPrompted[0]).title).toBe("Discord bot token");
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();

			// 2. Whitespace-only string
			const ctxEmpty = createFakeCommandContext({ inputs: ["   "] });
			await command.handler("setup", ctxEmpty);

			expect(ctxEmpty.inputsPrompted.length).toBe(1);
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();
		});

		it("aborts setup when user ID prompt is cancelled or empty without saving", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			// Valid token, but undefined user ID
			const ctxNoUserId = createFakeCommandContext({
				inputs: ["valid-token-1234", undefined],
			});
			await command.handler("setup", ctxNoUserId);

			expect(ctxNoUserId.inputsPrompted.length).toBe(2);
			expect(defined(ctxNoUserId.inputsPrompted[1]).title).toBe("Your Discord user ID");
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();
			expect(loadConfig(agentDir).discordUserId).toBeUndefined();

			// Valid token, but empty user ID
			const ctxEmptyUserId = createFakeCommandContext({
				inputs: ["valid-token-1234", "   "],
			});
			await command.handler("setup", ctxEmptyUserId);

			expect(ctxEmptyUserId.inputsPrompted.length).toBe(2);
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();
		});

		it("handles getMe failure without persisting credentials", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			stubFetch(async (url: string | URL | Request) => {
				const urlStr = String(url);
				if (urlStr.endsWith("/users/@me")) {
					return new Response(
						JSON.stringify({ code: 0, message: "401: Unauthorized" }),
						{
							status: 401,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response("Not found", { status: 404 });
			});

			const ctx = createFakeCommandContext({
				inputs: ["bad-token", "123456789"],
			});
			await command.handler("setup", ctx);

			expect(ctx.notifications.length).toBe(1);
			const notif = defined(ctx.notifications[0]);
			expect(notif.type).toBe("error");
			expect(notif.message).toContain("401");
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();
			expect(loadConfig(agentDir).discordUserId).toBeUndefined();
		});

		it("handles Discord 50007 error with exact friendly DM hint and does not save credentials", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			stubFetch(async (url: string | URL | Request) => {
				const urlStr = String(url);
				if (urlStr.endsWith("/users/@me")) {
					return new Response(
						JSON.stringify({ id: "999888", username: "AskBot" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (urlStr.endsWith("/users/@me/channels")) {
					// Discord error 50007: Cannot send messages to this user
					return new Response(
						JSON.stringify({
							code: 50007,
							message: "Cannot send messages to this user",
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response("Not found", { status: 404 });
			});

			const ctx = createFakeCommandContext({
				inputs: ["test-token", "123456789"],
			});
			await command.handler("setup", ctx);

			expect(ctx.notifications.length).toBe(1);
			const notif = defined(ctx.notifications[0]);
			expect(notif.type).toBe("error");
			expect(notif.message).toBe(
				"Discord bot cannot DM you: share a server with the bot and allow DMs from that server's members.",
			);

			// Credentials must NOT be saved on validation failure
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();
			expect(loadConfig(agentDir).discordUserId).toBeUndefined();
			expect(isConfigured(loadConfig(agentDir))).toBe(false);
		});

		it("handles send message failure without saving credentials", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			stubFetch(async (url: string | URL | Request) => {
				const urlStr = String(url);
				if (urlStr.endsWith("/users/@me")) {
					return new Response(
						JSON.stringify({ id: "999888", username: "AskBot" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (urlStr.endsWith("/users/@me/channels")) {
					return new Response(JSON.stringify({ id: "channel-1122" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (urlStr.includes("/channels/channel-1122/messages")) {
					return new Response(
						JSON.stringify({ message: "Internal server error" }),
						{
							status: 500,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response("Not found", { status: 404 });
			});

			const ctx = createFakeCommandContext({
				inputs: ["test-token", "123456789"],
			});
			await command.handler("setup", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
			expect(loadConfig(agentDir).discordBotToken).toBeUndefined();
		});

		it("saves credentials only after getMe, openDm, and send succeed, then notifies username", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const requestedUrls: string[] = [];
			const requestBodies: unknown[] = [];
			let authHeader: string | undefined;

			stubFetch(async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr = String(url);
				requestedUrls.push(urlStr);
				if (init?.headers) {
					const headers = new Headers(init.headers);
					authHeader = headers.get("Authorization") ?? undefined;
				}
				if (init?.body && typeof init.body === "string") {
					requestBodies.push(JSON.parse(init.body));
				}

				if (urlStr.endsWith("/users/@me")) {
					return new Response(
						JSON.stringify({ id: "bot-id-123", username: "FriendlyHelper" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				if (urlStr.endsWith("/users/@me/channels")) {
					return new Response(JSON.stringify({ id: "dm-channel-888" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (urlStr.includes("/channels/dm-channel-888/messages")) {
					return new Response(
						JSON.stringify({ id: "msg-999", content: "ok" }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				return new Response("Not found", { status: 404 });
			});

			const secretToken = "my-bot-secret-token-7777";
			const userId = "target-user-id-5555";
			const ctx = createFakeCommandContext({
				inputs: [secretToken, userId],
			});
			await command.handler("setup", ctx);

			// Assert requests were made in proper sequence with proper payloads
			expect(requestedUrls).toEqual([
				"https://discord.com/api/v10/users/@me",
				"https://discord.com/api/v10/users/@me/channels",
				"https://discord.com/api/v10/channels/dm-channel-888/messages",
			]);
			expect(authHeader).toBe(`Bot ${secretToken}`);
			expect(requestBodies).toEqual([
				{ recipient_id: userId },
				{
					content: "✅ lemmeaskchat connected to omp.",
					allowed_mentions: { parse: [] },
				},
			]);

			// Assert notification and persistence
			expect(ctx.notifications.length).toBe(1);
			const notif = defined(ctx.notifications[0]);
			expect(notif.type).toBe("info");
			expect(notif.message).toContain("FriendlyHelper");

			const saved = loadConfig(agentDir);
			expect(saved.discordBotToken).toBe(secretToken);
			expect(saved.discordUserId).toBe(userId);
			expect(isConfigured(saved)).toBe(true);

			// Confirm full secret token is never echoed in notification
			expect(notif.message).not.toContain(secretToken);
		});
	});

	describe("test command and unknown command handling", () => {
		it("notifies when the 120-second test deadline expires", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { discordBotToken: "smoke-token", discordUserId: "smoke-user" });
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const ctx = createFakeCommandContext();
			const realSetTimeout = globalThis.setTimeout;
			let expire: (() => void) | undefined;
			const replacement = Object.assign(
				(callback: TimerHandler, ms?: number, ...args: unknown[]) => {
					if (ms === 120_000 && typeof callback === "function") expire = () => callback(...args);
					return realSetTimeout(callback, ms, ...args);
				},
				{ __promisify__: realSetTimeout.__promisify__ },
			);
			// Bun returns a Timer; DOM's string-handler overload also declares a numeric return.
			const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(replacement as typeof setTimeout);
			try {
				const command = host.getCommand().handler("test", ctx);
				defined(expire)();
				await command;
				expect(ctx.notifications).toContainEqual({
					message: "No Discord answer within 120s",
					type: "warning",
				});
			} finally {
				timerSpy.mockRestore();
			}
		});

		it("notifies error when running test command without configuration", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("test", ctx);

			expect(ctx.notifications.length).toBe(1);
			expect(defined(ctx.notifications[0]).type).toBe("error");
		});

		it("notifies error with usage hint for unknown subcommands", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);
			const command = host.getCommand();

			const ctx = createFakeCommandContext();
			await command.handler("foobar", ctx);

			expect(ctx.notifications.length).toBe(1);
			const notif = defined(ctx.notifications[0]);
			expect(notif.type).toBe("error");
			expect(notif.message).toContain("foobar");
		});
	});

	describe("session lifecycle guards (main vs sub agent)", () => {
		it("session_start updates status only for main agent with UI", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, {
				away: true,
				discordBotToken: "mock-token",
				discordUserId: "mock-user",
			});

			const mockBridge = createMockBridge();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api, { bridgeFactory: () => mockBridge });

			// 1. Subagent session start -> should ignore completely
			const subCtx = createFakeCommandContext({
				agentKind: "sub",
				hasUI: true,
			});
			await host.emit("session_start", subCtx);
			expect(subCtx.statuses.size).toBe(0);
			expect(host.tools.length).toBe(0);

			// 2. Main agent without UI -> should ignore
			const noUiCtx = createFakeCommandContext({
				agentKind: "main",
				hasUI: false,
			});
			await host.emit("session_start", noUiCtx);
			expect(noUiCtx.statuses.size).toBe(0);
			expect(host.tools.length).toBe(0);

			// 3. Main agent with UI and away: true and configured -> sets status and registers ask tool
			const mainCtx = createFakeCommandContext({
				agentKind: "main",
				hasUI: true,
			});
			await host.emit("session_start", mainCtx);
			expect(mainCtx.statuses.get("lemmeaskchat")).toBe("away → Discord");
			expect(host.tools.length).toBe(1);
			expect(defined(host.tools[0]).name).toBe("ask");
			await host.emit("session_shutdown", mainCtx);
		});

		it("session_start clears status and warns when away mode is saved without credentials", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { away: true });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);

			const mainCtx = createFakeCommandContext({
				agentKind: "main",
				hasUI: true,
			});
			await host.emit("session_start", mainCtx);
			expect(mainCtx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(loadConfig(agentDir).away).toBe(false);
			expect(mainCtx.notifications.some((n) => n.message.includes("not configured"))).toBe(true);
		});

		it("session_start clears status when away mode is disabled", async () => {
			const agentDir = makeTempAgentDir();
			saveConfig(agentDir, { away: false });

			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);

			const mainCtx = createFakeCommandContext({
				agentKind: "main",
				hasUI: true,
			});
			await host.emit("session_start", mainCtx);
			expect(mainCtx.statuses.get("lemmeaskchat")).toBeUndefined();
		});

		it("session_shutdown does not trigger shutdown for sub agents or headless sessions", async () => {
			const agentDir = makeTempAgentDir();
			const host = createFakeHostApi(agentDir);
			lemmeaskchat(host.api);

			// Create a singleton bridge instance
			const bridge = getBridge({
				token: "dummy-token",
				userId: "dummy-user",
			});
			expect(getCurrentBridge()).toBe(bridge);
			// Subagent session shutdown -> must not stop main singleton bridge
			const subCtx = createFakeCommandContext({
				agentKind: "sub",
				hasUI: true,
			});
			await host.emit("session_shutdown", subCtx);
			expect(getCurrentBridge()).toBe(bridge);

			// Headless main session shutdown -> must not stop bridge
			const noUiCtx = createFakeCommandContext({
				agentKind: "main",
				hasUI: false,
			});
			await host.emit("session_shutdown", noUiCtx);
			expect(getCurrentBridge()).toBe(bridge);

			// Main session with UI -> triggers bridge shutdown
			const mainCtx = createFakeCommandContext({
				agentKind: "main",
				hasUI: true,
			});
			await host.emit("session_shutdown", mainCtx);
			expect(getCurrentBridge()).toBeUndefined();
			await expect(bridge.acquire()).rejects.toThrow(
				"Cannot acquire DiscordBridge: bridge has been shut down",
			);
		});
	});
});
