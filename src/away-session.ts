/**
 * Away session controller for omp-lemmeaskchat.
 * Manages Discord conversations during away mode, handling model completion notifications,
 * prompt follow-up injections, idle timeouts, and session transitions.
 */

import { basename } from "node:path";
import {
	isConfigured,
	loadConfig,
	saveConfig,
} from "./config.ts";
import { getBridge, type DiscordConversation } from "./discord/bridge.ts";
import type { HostApi, HostContext, HostLogger } from "./host.ts";

export interface BridgeLike {
	openConversation(onPrompt: (text: string) => void): Promise<DiscordConversation>;
	onError?(callback: (error: Error) => void): () => void;
}

export interface TimerFactory {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface AwaySessionControllerOptions {
	bridgeFactory?: (opts: { token: string; userId: string; logger?: HostLogger | undefined }) => BridgeLike;
	timerFactory?: TimerFactory;
}

/**
 * Extracts final assistant response text from an agent_end messages array.
 * Safely ignores thinking blocks, tool calls, and non-assistant messages.
 */
export function extractAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) {
		return "";
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || typeof m !== "object") {
			continue;
		}
		if ("role" in m && m.role === "assistant") {
			if (!("content" in m)) {
				return "";
			}
			const content = m.content;
			if (typeof content === "string") {
				return content.trim();
			}
			if (Array.isArray(content)) {
				const textParts: string[] = [];
				for (const item of content) {
					if (
						item &&
						typeof item === "object" &&
						"type" in item &&
						item.type === "text" &&
						"text" in item &&
						typeof item.text === "string"
					) {
						textParts.push(item.text);
					}
				}
				return textParts.join("").trim();
			}
			return "";
		}
	}
	return "";
}

/**
 * Resolves current session display name:
 * Uses pi.getSessionName(), fallback `${basename(ctx.cwd)} (${sessionId.slice(0,8)})`.
 */
export function formatSessionName(pi: HostApi, ctx?: HostContext): string {
	const managerName =
		ctx?.sessionManager &&
		"getSessionName" in ctx.sessionManager &&
		typeof ctx.sessionManager.getSessionName === "function"
			? (ctx.sessionManager.getSessionName as () => string | undefined)()
			: undefined;
	const customName = pi.getSessionName?.() ?? managerName;
	if (typeof customName === "string" && customName.trim().length > 0) {
		return customName.trim();
	}
	const folder = ctx?.cwd ? basename(ctx.cwd) : "omp";
	const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
	const idPart =
		sessionId.length >= 8
			? sessionId.slice(0, 8)
			: sessionId.length > 0
				? sessionId
				: "session";
	return `${folder} (${idPart})`;
}

/**
 * Formats completion notification message:
 * Session “<name>” has finished — awaiting response.\n\n<final assistant text>
 */
export function formatCompletionMessage(name: string, assistantText: string): string {
	const trimmed = assistantText.trim();
	if (trimmed.length > 0) {
		return `Session “${name}” has finished — awaiting response.\n\n${trimmed}`;
	}
	return `Session “${name}” has finished — awaiting response.`;
}

function hasRunningAsyncJobs(ctx?: HostContext): boolean {
	if (!ctx?.getAsyncJobSnapshot) {
		return false;
	}
	const snapshot = ctx.getAsyncJobSnapshot();
	return Boolean(
		snapshot &&
		typeof snapshot === "object" &&
		"running" in snapshot &&
		Array.isArray(snapshot.running) &&
		snapshot.running.length > 0,
	);
}

export class AwaySessionController {
	private readonly pi: HostApi;
	private readonly logger: HostLogger | undefined;
	private readonly bridgeFactory: (opts: { token: string; userId: string; logger?: HostLogger | undefined }) => BridgeLike;
	private readonly timerFactory: TimerFactory;

	private currentContext: HostContext | undefined = undefined;
	private conversation: DiscordConversation | undefined = undefined;
	private errorCleanup: (() => void) | undefined = undefined;
	private isAwayActive = false;
	private isRunning = false;
	private isAskActive = false;
	private hasPendingContinuation = false;
	private runEpoch = 0;
	private activationGen = 0;

	private idleTimer: unknown = undefined;
	private idleTimerEpoch: number | undefined = undefined;
	private settleTimer: unknown = undefined;
	constructor(pi: HostApi, options: AwaySessionControllerOptions = {}) {
		this.pi = pi;
		this.logger = pi.logger;
		this.bridgeFactory =
			options.bridgeFactory ??
			((opts) => getBridge(opts));
		this.timerFactory = options.timerFactory ?? {
			setTimeout: (cb, ms) => setTimeout(cb, ms),
			clearTimeout: (h) => {
				if (h !== undefined) {
					clearTimeout(h as NodeJS.Timeout | number);
				}
			},
		};
	}

	public get activeConversation(): DiscordConversation | undefined {
		return this.conversation;
	}

	public get isAway(): boolean {
		return this.isAwayActive;
	}

	public setContext(ctx: HostContext): void {
		this.currentContext = ctx;
	}

	public setAskActive(active: boolean): void {
		this.isAskActive = active;
		if (active) {
			this.clearTimers();
		} else if (this.isAwayActive && this.conversation && !this.isRunning) {
			this.scheduleIdleCheck(this.runEpoch, 0);
		}
	}

	public isBusy(): boolean {
		if (this.isRunning) {
			return true;
		}
		if (this.isAskActive) {
			return true;
		}
		if (this.hasPendingContinuation) {
			return true;
		}
		if (this.currentContext) {
			if (this.currentContext.isIdle && !this.currentContext.isIdle()) {
				return true;
			}
			if (this.currentContext.hasPendingMessages && this.currentContext.hasPendingMessages()) {
				return true;
			}
			if (hasRunningAsyncJobs(this.currentContext)) {
				return true;
			}
		}
		return false;
	}

	public clearTimers(): void {
		if (this.idleTimer !== undefined) {
			this.timerFactory.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
			this.idleTimerEpoch = undefined;
		}
		if (this.settleTimer !== undefined) {
			this.timerFactory.clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
	}

	public onAgentStart(): void {
		this.isRunning = true;
		this.hasPendingContinuation = false;
		this.runEpoch++;
		this.clearTimers();
	}

	public async onAgentEnd(event: unknown): Promise<void> {
		this.isRunning = false;
		this.clearTimers();
		if (!this.isAwayActive || !this.conversation) {
			return;
		}

		let willContinue = false;
		let awaitingAsyncWork = false;
		let messages: unknown;
		if (event && typeof event === "object") {
			if ("willContinue" in event && typeof event.willContinue === "boolean") {
				willContinue = event.willContinue;
			}
			if ("awaitingAsyncWork" in event && typeof event.awaitingAsyncWork === "boolean") {
				awaitingAsyncWork = event.awaitingAsyncWork;
			}
			if ("messages" in event) {
				messages = event.messages;
			}
		}

		// Nonterminal flags set no final message and keep away mode active without idle expiry
		if (willContinue || awaitingAsyncWork) {
			this.hasPendingContinuation = true;
			this.scheduleIdleCheck(this.runEpoch, 0);
			return;
		}

		this.hasPendingContinuation = false;

		const assistantText = extractAssistantText(messages);
		const name = formatSessionName(this.pi, this.currentContext);
		const completionMessage = formatCompletionMessage(name, assistantText);
		const endEpoch = this.runEpoch;
		const activation = this.activationGen;

		try {
			await this.conversation.send(completionMessage);
		} catch (err) {
			// Invariant: fail closed on completion send failure to prevent unmonitored away state.
			if (this.activationGen !== activation || !this.isAwayActive) {
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			this.logger?.warn("Failed to send away completion message", { error: msg });
			this.disableAwaySafely();
			this.currentContext?.ui?.notify?.(
				`Failed to send away completion message: ${msg}`,
				"error",
			);
			return;
		}

		// Don't let own output-delivery await arm timer after a newer run started,
		// or if activation changed, or if away turned off.
		if (
			this.activationGen !== activation ||
			this.runEpoch !== endEpoch ||
			this.isRunning ||
			!this.isAwayActive ||
			!this.conversation
		) {
			return;
		}

		// If runner is settling, ask is active, queued followups exist, or async jobs remain,
		// continue idle monitoring with backoff. Expiry waits until all jobs finish.
		if (this.isBusy()) {
			this.scheduleIdleCheck(endEpoch, 0);
			return;
		}

		this.armIdleTimer(endEpoch);
	}

	private scheduleIdleCheck(epoch: number, attempt: number): void {
		if (this.settleTimer !== undefined) {
			this.timerFactory.clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
		const activation = this.activationGen;
		const delay = Math.min(1000, attempt < 6 ? 50 : 100 * Math.pow(2, Math.min(4, attempt - 6)));
		this.settleTimer = this.timerFactory.setTimeout(() => {
			this.settleTimer = undefined;
			if (
				this.activationGen !== activation ||
				this.runEpoch !== epoch ||
				this.isRunning ||
				!this.isAwayActive ||
				!this.conversation
			) {
				return;
			}
			if (this.isBusy()) {
				this.scheduleIdleCheck(epoch, attempt + 1);
				return;
			}
			this.armIdleTimer(epoch);
		}, delay);
	}

	private armIdleTimer(epoch: number): void {
		if (this.idleTimer !== undefined) {
			this.timerFactory.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
			this.idleTimerEpoch = undefined;
		}
		if (this.runEpoch !== epoch || this.isRunning || !this.isAwayActive || !this.conversation || this.isBusy()) {
			return;
		}

		const agentDir = this.pi.pi.getAgentDir();
		const config = loadConfig(agentDir);
		const timeoutSeconds = config.awayTimeoutSeconds;
		const ms = timeoutSeconds * 1000;

		this.idleTimerEpoch = epoch;
		this.idleTimer = this.timerFactory.setTimeout(() => {
			void this.onIdleTimeout(epoch);
		}, ms);
	}

	private onIdleTimeout(epoch: number): void {
		if (this.idleTimerEpoch !== epoch || this.runEpoch !== epoch || !this.isAwayActive) {
			return;
		}
		if (this.isBusy()) {
			// Invariant: when idle timer fires while busy, schedule post-busy idle check and start full new idle window once truly idle.
			this.scheduleIdleCheck(epoch, 0);
			return;
		}

		this.isAwayActive = false;
		this.clearTimers();
		this.runEpoch++;
		this.activationGen++;
		this.errorCleanup?.();
		this.errorCleanup = undefined;

		const conv = this.conversation;
		this.conversation = undefined;
		conv?.close();

		const agentDir = this.pi.pi.getAgentDir();
		saveConfig(agentDir, { away: false });

		if (this.currentContext?.ui) {
			this.currentContext.ui.setStatus("lemmeaskchat", undefined);
			this.currentContext.ui.notify("Away mode expired after idle timeout.", "info");
		}
	}

	private handlePrompt(text: string): void {
		if (!this.conversation || !this.isAwayActive) {
			return;
		}

		if (typeof this.pi.sendUserMessage !== "function") {
			const errMsg = "Host sendUserMessage runtime method is not available.";
			this.logger?.error?.(errMsg);
			this.disableAwaySafely();
			this.currentContext?.ui?.notify?.(`lemmeaskchat: ${errMsg} Away mode disabled.`, "error");
			return;
		}

		// Clear timers and advance epoch immediately before host runner starts
		this.clearTimers();
		this.runEpoch++;
		const promptEpoch = this.runEpoch;

		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}

		const busy = this.isBusy();
		try {
			if (busy) {
				this.pi.sendUserMessage(trimmed, { deliverAs: "followUp" });
			} else {
				this.pi.sendUserMessage(trimmed);
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.logger?.error?.("Failed to deliver user message to host runner", { error: errMsg });
			this.disableAwaySafely();
			this.currentContext?.ui?.notify?.(`lemmeaskchat: ${errMsg}. Away mode disabled.`, "error");
			return;
		}

		// After accepted idle injection arrange a future idle check/window which agent_start cancels.
		// Busy followups must not expire queued work, host queries cover pending.
		if (!busy) {
			this.scheduleIdleCheck(promptEpoch, 0);
		} else if (!this.isRunning) {
			this.scheduleIdleCheck(promptEpoch, 0);
		}
	}

	private handleFatalError(err: Error): void {
		if (!this.isAwayActive) {
			return;
		}
		this.logger?.warn("Fatal error in Discord bridge during away session", { error: err.message });
		this.disableAwaySafely();

		if (this.currentContext?.ui) {
			this.currentContext.ui.notify(`lemmeaskchat: ${err.message}`, "error");
		}
	}

	private disableAwaySafely(): void {
		this.isAwayActive = false;
		this.hasPendingContinuation = false;
		this.clearTimers();
		this.runEpoch++;
		this.activationGen++;
		this.errorCleanup?.();
		this.errorCleanup = undefined;

		const conv = this.conversation;
		this.conversation = undefined;
		conv?.close();

		try {
			const agentDir = this.pi.pi.getAgentDir();
			saveConfig(agentDir, { away: false });
		} catch {
			// ignore filesystem errors
		}

		if (this.currentContext?.ui) {
			this.currentContext.ui.setStatus("lemmeaskchat", undefined);
		}
	}

	public async setAway(enabled: boolean, ctx: HostContext): Promise<void> {
		this.currentContext = ctx;
		const agentDir = this.pi.pi.getAgentDir();

		if (!enabled) {
			this.isAwayActive = false;
			this.isRunning = false;
			this.isAskActive = false;
			this.hasPendingContinuation = false;
			this.activationGen++;
			this.clearTimers();
			this.runEpoch++;
			this.errorCleanup?.();
			this.errorCleanup = undefined;

			const conv = this.conversation;
			this.conversation = undefined;
			conv?.close();

			saveConfig(agentDir, { away: false });
			ctx.ui.setStatus("lemmeaskchat", undefined);
			ctx.ui.notify("Away mode off.", "info");
			return;
		}

		const config = loadConfig(agentDir);
		if (!isConfigured(config)) {
			ctx.ui.notify("lemmeaskchat is not configured. Run /lemmeaskchat setup first.", "error");
			this.isAwayActive = false;
			this.hasPendingContinuation = false;
			this.activationGen++;
			this.errorCleanup?.();
			this.errorCleanup = undefined;
			this.conversation?.close();
			this.conversation = undefined;
			saveConfig(agentDir, { away: false });
			ctx.ui.setStatus("lemmeaskchat", undefined);
			return;
		}
		if (this.isAwayActive && this.conversation) {
			saveConfig(agentDir, { away: true });
			ctx.ui.setStatus("lemmeaskchat", "away → Discord");
			ctx.ui.notify("Away mode on.", "info");
			return;
		}

		this.clearTimers();
		this.runEpoch++;
		const activation = ++this.activationGen;
		this.isAwayActive = true;
		this.hasPendingContinuation = false;

		saveConfig(agentDir, { away: true });
		ctx.ui.setStatus("lemmeaskchat", "away → Discord");
		ctx.ui.notify("Away mode on.", "info");

		try {
			const bridge = this.bridgeFactory({
				token: config.discordBotToken!,
				userId: config.discordUserId!,
				...(this.logger !== undefined ? { logger: this.logger } : {}),
			});

			if (typeof bridge.onError === "function") {
				this.errorCleanup?.();
				this.errorCleanup = bridge.onError((err) => this.handleFatalError(err));
			}

			const conv = await bridge.openConversation((promptText) => {
				this.handlePrompt(promptText);
			});

			// Guard: If activation generation changed (away turned off, switched, etc.),
			// close handle and abort. An agent_start does NOT invalidate activationGen.
			if (this.activationGen !== activation || !this.isAwayActive) {
				conv.close();
				return;
			}

			this.conversation = conv;
			const name = formatSessionName(this.pi, ctx);
			const busy = this.isBusy();

			if (busy) {
				await conv.send(`Session “${name}” is now away (task running).`);
			} else {
				await conv.send(`Session “${name}” is now away — awaiting response.`);
			}

			// Guard after send against intervening activation changes
			if (this.activationGen !== activation || !this.isAwayActive) {
				return;
			}

			if (!this.isBusy()) {
				this.armIdleTimer(this.runEpoch);
			} else if (!this.isRunning) {
				this.scheduleIdleCheck(this.runEpoch, 0);
			}
		} catch (err) {
			// An old failed open/send catch must not disable a newer activation
			if (this.activationGen !== activation) {
				return;
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			this.logger?.warn("Failed to activate away mode", { error: errMsg });
			ctx.ui.notify(`Failed to activate away mode: ${errMsg}`, "error");
			this.isAwayActive = false;
			this.hasPendingContinuation = false;
			this.clearTimers();
			this.activationGen++;
			this.errorCleanup?.();
			this.errorCleanup = undefined;
			this.conversation?.close();
			this.conversation = undefined;
			saveConfig(agentDir, { away: false });
			ctx.ui.setStatus("lemmeaskchat", undefined);
		}
	}

	public resetTimeout(): void {
		if (this.isAwayActive && this.conversation && this.idleTimer !== undefined) {
			this.armIdleTimer(this.runEpoch);
		}
	}

	public async onCredentialsChanged(ctx: HostContext): Promise<void> {
		if (!this.isAwayActive) {
			return;
		}
		this.currentContext = ctx;
		this.closeCurrentConversation();

		const agentDir = this.pi.pi.getAgentDir();
		const config = loadConfig(agentDir);
		if (!isConfigured(config)) {
			this.isAwayActive = false;
			saveConfig(agentDir, { away: false });
			ctx.ui.setStatus("lemmeaskchat", undefined);
			ctx.ui.notify("lemmeaskchat credentials invalid; away mode disabled.", "warning");
			return;
		}

		await this.setAway(true, ctx);
	}

	public async onSessionStart(ctx: HostContext): Promise<void> {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) {
			return;
		}
		this.isAwayActive = false;
		this.isRunning = false;
		this.isAskActive = false;
		this.activationGen++;
		this.closeCurrentConversation();
		this.currentContext = ctx;

		const agentDir = this.pi.pi.getAgentDir();
		const config = loadConfig(agentDir);

		if (config.away) {
			if (isConfigured(config)) {
				await this.setAway(true, ctx);
			} else {
				ctx.ui.notify("lemmeaskchat is not configured. Away mode cannot start.", "warning");
				saveConfig(agentDir, { away: false });
				ctx.ui.setStatus("lemmeaskchat", undefined);
			}
		} else {
			ctx.ui.setStatus("lemmeaskchat", undefined);
		}
	}

	public onSessionShutdown(ctx: HostContext): void {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) {
			return;
		}
		this.isAwayActive = false;
		this.isRunning = false;
		this.isAskActive = false;
		this.hasPendingContinuation = false;
		this.activationGen++;
		this.closeCurrentConversation();
	}

	public async onSessionSwitch(ctx: HostContext): Promise<void> {
		if (ctx.agent.kind !== "main" || !ctx.hasUI) {
			return;
		}
		this.isAwayActive = false;
		this.isRunning = false;
		this.isAskActive = false;
		this.hasPendingContinuation = false;
		this.activationGen++;
		this.closeCurrentConversation();
		this.currentContext = ctx;

		const agentDir = this.pi.pi.getAgentDir();
		const config = loadConfig(agentDir);
		if (config.away && isConfigured(config)) {
			await this.setAway(true, ctx);
		}
	}

	private closeCurrentConversation(): void {
		this.hasPendingContinuation = false;
		this.clearTimers();
		this.runEpoch++;
		this.activationGen++;
		this.errorCleanup?.();
		this.errorCleanup = undefined;
		const conv = this.conversation;
		this.conversation = undefined;
		conv?.close();
	}
}
