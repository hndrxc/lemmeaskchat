import { basename } from "node:path";
import type { AskParams } from "./ask-format.ts";
import { createAskExecute } from "./ask-race.ts";
import {
	AwaySessionController,
	type AwaySessionControllerOptions,
} from "./away-session.ts";
import {
	isConfigured,
	loadConfig,
	parseAwayTimeout,
	saveConfig,
} from "./config.ts";
import { getBridge, getCurrentBridge } from "./discord/bridge.ts";
import { DiscordApiError, createDiscordRest } from "./discord/rest.ts";
import type {
	HostApi,
	HostCommandContext,
	HostContext,
	ToolUpdateCallback,
} from "./host.ts";
import { startRemoteAsk } from "./remote-ask.ts";

interface CachedNativeAsk {
	description: string;
	parameters: unknown;
}

let nativeAsk: CachedNativeAsk | undefined;
let firstSessionSeen = false;

const HINT_50007 =
	"Discord bot cannot DM you: share a server with the bot and allow DMs from that server's members.";

export default function lemmeaskchat(
	pi: HostApi,
	options?: AwaySessionControllerOptions,
): void {
	const away = new AwaySessionController(pi, options);

	pi.registerCommand("lemmeaskchat", {
		description:
			"Discord DM relay for ask: setup | away [on|off] | timeout <seconds> | delay <seconds> | test | status",
		getArgumentCompletions: (prefix: string) =>
			[
				"setup",
				"away",
				"away on",
				"away off",
				"timeout",
				"delay",
				"test",
				"status",
			]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args: string, ctx: HostCommandContext) => {
			const agentDir = pi.pi.getAgentDir();
			const trimmed = args.trim();

			if (trimmed === "" || trimmed === "status") {
				const cfg = loadConfig(agentDir);
				const configured = isConfigured(cfg);
				const token = cfg.discordBotToken;
				const maskedToken =
					token && token.length > 0 ? `…${token.slice(-4)}` : "(not set)";
				const userId =
					cfg.discordUserId && cfg.discordUserId.length > 0
						? cfg.discordUserId
						: "(not set)";
				const bridge = getCurrentBridge();
				const bridgeConnected = bridge ? bridge.connected : false;

				const statusMsg = [
					`Configured: ${configured ? "yes" : "no"}`,
					`Token: ${maskedToken}`,
					`User ID: ${userId}`,
					`Away: ${cfg.away ? "on" : "off"}`,
					`Timeout: ${cfg.awayTimeoutSeconds}s`,
					`Delay: ${cfg.delaySeconds}s`,
					`Bridge: ${bridgeConnected ? "connected" : "disconnected"}`,
				].join("\n");

				ctx.ui.notify(statusMsg, "info");
				return;
			}

			if (trimmed === "setup") {
				const tokenInput = await ctx.ui.input("Discord bot token", "paste token");
				const token = tokenInput?.trim();
				if (!token) {
					return;
				}

				const userIdInput = await ctx.ui.input(
					"Your Discord user ID",
					"Developer Mode → right-click yourself → Copy User ID",
				);
				const userId = userIdInput?.trim();
				if (!userId) {
					return;
				}

				try {
					const rest = createDiscordRest(token);
					const me = await rest.getMe();
					const dmChannelId = await rest.openDm(userId);
					await rest.send(dmChannelId, { content: "✅ lemmeaskchat connected to omp." });
					saveConfig(agentDir, { discordBotToken: token, discordUserId: userId });
					ctx.ui.notify(`Connected to Discord bot ${me.username}`, "info");
					await away.onCredentialsChanged(ctx);
				} catch (err: unknown) {
					let message: string;
					if (err && typeof err === "object") {
						const anyErr = err as { code?: number | string; message?: string };
						if (
							anyErr.code === 50007 ||
							anyErr.code === "50007" ||
							(typeof anyErr.message === "string" && anyErr.message.includes("50007"))
						) {
							message = HINT_50007;
						} else if (err instanceof DiscordApiError || err instanceof Error) {
							message = err.message;
						} else {
							message = String(err);
						}
					} else {
						message = String(err);
					}
					ctx.ui.notify(message, "error");
				}
				return;
			}

			if (
				trimmed === "away" ||
				trimmed.startsWith("away ") ||
				trimmed.startsWith("away\t")
			) {
				const parts = trimmed.split(/\s+/);
				let newAway: boolean;
				if (parts.length === 1) {
					const cfg = loadConfig(agentDir);
					newAway = !cfg.away;
				} else if (parts.length === 2 && parts[1] === "on") {
					newAway = true;
				} else if (parts.length === 2 && parts[1] === "off") {
					newAway = false;
				} else {
					ctx.ui.notify("Usage: /lemmeaskchat away [on|off]", "error");
					return;
				}

				await away.setAway(newAway, ctx);
				return;
			}

			if (
				trimmed === "timeout" ||
				trimmed.startsWith("timeout ") ||
				trimmed.startsWith("timeout\t")
			) {
				const parts = trimmed.split(/\s+/);
				const val = parts[1];
				if (parts.length !== 2 || val === undefined) {
					ctx.ui.notify("Usage: /lemmeaskchat timeout <seconds>", "error");
					return;
				}

				const parsed = parseAwayTimeout(val);
				if (parsed === undefined) {
					ctx.ui.notify(
						"Invalid timeout: expected an integer between 1 and 2147483 seconds.",
						"error",
					);
					return;
				}

				saveConfig(agentDir, { awayTimeoutSeconds: parsed });
				away.resetTimeout();
				ctx.ui.notify(
					`Timeout set to ${parsed} second${parsed === 1 ? "" : "s"}.`,
					"info",
				);
				return;
			}

			if (
				trimmed === "delay" ||
				trimmed.startsWith("delay ") ||
				trimmed.startsWith("delay\t")
			) {
				const parts = trimmed.split(/\s+/);
				const val = parts[1];
				if (parts.length !== 2 || val === undefined) {
					ctx.ui.notify("Usage: /lemmeaskchat delay <seconds>", "error");
					return;
				}

				if (!/^\d+$/.test(val)) {
					ctx.ui.notify(
						"Invalid delay: expected a non-negative integer of seconds.",
						"error",
					);
					return;
				}

				const seconds = Number.parseInt(val, 10);
				if (!Number.isSafeInteger(seconds) || seconds < 0) {
					ctx.ui.notify(
						"Invalid delay: expected a non-negative integer of seconds.",
						"error",
					);
					return;
				}

				saveConfig(agentDir, { delaySeconds: seconds });
				ctx.ui.notify(
					seconds === 0
						? "Delay set to 0 seconds (delayed DM disabled)."
						: `Delay set to ${seconds} second${seconds === 1 ? "" : "s"}.`,
					"info",
				);
				return;
			}

			if (trimmed === "test") {
				const cfg = loadConfig(agentDir);
				if (!isConfigured(cfg)) {
					ctx.ui.notify(
						"lemmeaskchat is not configured. Run /lemmeaskchat setup first.",
						"error",
					);
					return;
				}

				const bridge = getBridge({
					token: cfg.discordBotToken!,
					userId: cfg.discordUserId!,
					logger: pi.logger,
				});

				const testParams: AskParams = {
					questions: [
						{
							id: "test",
							question: "lemmeaskchat test — tap a button or reply",
							options: [{ label: "Works" }, { label: "Also works" }],
						},
					],
				};

				const project = ctx.cwd ? basename(ctx.cwd) : "omp";
				const remote = startRemoteAsk({
					bridge,
					params: testParams,
					delayMs: 0,
					project,
					onError: (err) => {
						try {
							ctx.ui.notify(`lemmeaskchat: ${err.message}`, "warning");
						} catch {
							// ignore notification error
						}
					},
				});

				const { promise: timeoutPromise, resolve: resolveTimeout } =
					Promise.withResolvers<"timeout">();
				const timer = setTimeout(() => {
					resolveTimeout("timeout");
					try {
						remote.close("cancelled");
					} catch {
						// ignore
					}
				}, 120_000);
				timer.unref?.();

				try {
					const outcome = await Promise.race([remote.result, timeoutPromise]);

					if (outcome === "timeout") {
						ctx.ui.notify("No Discord answer within 120s", "warning");
					} else if (outcome && outcome.length > 0) {
						const first = outcome[0];
						if (!first) {
							return;
						}
						const answerText =
							first.selectedOptions && first.selectedOptions.length > 0
								? first.selectedOptions.join(", ")
								: (first.customInput ?? "");
						ctx.ui.notify(`Discord answer: ${answerText}`, "info");
					}
				} finally {
					clearTimeout(timer);
				}
				return;
			}

			ctx.ui.notify(
				`Unknown command: /lemmeaskchat ${trimmed}. Usage: /lemmeaskchat setup | away [on|off] | timeout <seconds> | delay <seconds> | test | status`,
				"error",
			);
		},
	});

	pi.on("session_start", async (_event: unknown, ctx: HostContext) => {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) {
			return;
		}

		const agentDir = pi.pi.getAgentDir();

		const allTools = pi.getAllTools();
		const askTool = allTools.find((tool) => tool.name === "ask");

		if (askTool) {
			if (askTool.sourceInfo?.source === "builtin") {
				nativeAsk = {
					description: askTool.description,
					parameters: askTool.parameters,
				};
			} else if (askTool.sourceInfo === undefined && !firstSessionSeen) {
				nativeAsk = {
					description: askTool.description,
					parameters: askTool.parameters,
				};
			}
		}
		firstSessionSeen = true;

		if (askTool && nativeAsk) {
			const execute = createAskExecute({
				agentDir,
				logger: pi.logger,
			});

			const wrappedExecute = async (
				toolCallId: string,
				params: AskParams,
				signal: AbortSignal | undefined,
				onUpdate: ToolUpdateCallback | undefined,
				toolCtx: HostContext,
			) => {
				away.setAskActive(true);
				try {
					return await execute(toolCallId, params, signal, onUpdate, toolCtx);
				} finally {
					away.setAskActive(false);
				}
			};

			pi.registerTool({
				name: "ask",
				label: "Ask",
				description: nativeAsk.description,
				parameters: nativeAsk.parameters,
				approval: "read",
				strict: true,
				concurrency: "exclusive",
				execute: wrappedExecute,
			});
		}

		await away.onSessionStart(ctx);
	});

	pi.on("session_shutdown", async (_event: unknown, ctx: HostContext) => {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) {
			return;
		}
		away.onSessionShutdown(ctx);
		try {
			await getCurrentBridge()?.shutdownAll("shutdown");
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			pi.logger?.warn("Error during session_shutdown", { error: error.message });
		}
	});

	pi.on("session_switch", async (_event: unknown, ctx: HostContext) => {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) {
			return;
		}
		await away.onSessionSwitch(ctx);
	});

	pi.on("agent_start", (_event: unknown, ctx: HostContext) => {
		if (ctx.agent.kind !== "main") {
			return;
		}
		away.onAgentStart();
	});

	pi.on("agent_end", async (event: unknown, ctx: HostContext) => {
		if (ctx.agent.kind !== "main") {
			return;
		}
		await away.onAgentEnd(event);
	});
}
