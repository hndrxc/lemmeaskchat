/**
 * DiscordBridge manages Discord DM relay state, Gateway lifecycle,
 * and routing for ask relay questions.
 */

import type { AskQuestion, QuestionAnswer } from "../ask-format.ts";
import {
	answerFromComponent,
	answeredContent,
	closedContent,
	parseReply,
} from "../ask-format.ts";
import type { HostLogger } from "../host.ts";
import type {
	GatewayInteractionCreateData,
	GatewayMessageCreateData,
	GatewayOptions,
	TimerHandle,
} from "./gateway.ts";
import { Gateway } from "./gateway.ts";
import type { DiscordMessage, DiscordRest } from "./rest.ts";
import { createDiscordRest } from "./rest.ts";

/**
 * An in-flight question waiting for a user answer through Discord.
 */
export interface OpenQuestion {
	askKey: string;
	qIndex: number;
	question: AskQuestion;
	content: string;
	components: unknown[];
	resolve(answer: QuestionAnswer): void;
}

export interface BridgeGatewayLike {
	start(): void;
	stop(): void;
}

export type GatewayFactory = (
	token: string,
	options: GatewayOptions,
) => BridgeGatewayLike;

export interface BridgeOptions {
	token: string;
	userId: string;
	logger?: HostLogger | undefined;
	rest?: DiscordRest | undefined;
	gatewayFactory?: GatewayFactory | undefined;
}

/**
 * Compares two snowflake strings in descending order (newest first).
 */
function compareSnowflakesDesc(a: string, b: string): number {
	try {
		const diff = BigInt(b) - BigInt(a);
		return diff < 0n ? -1 : diff > 0n ? 1 : 0;
	} catch {
		if (b.length !== a.length) {
			return b.length - a.length;
		}
		return b.localeCompare(a);
	}
}

export class DiscordBridge {
	public readonly open = new Map<string, OpenQuestion>();
	public readonly closedAskKeys: string[] = [];
	public logger?: HostLogger | undefined;

	private readonly token: string;
	private readonly userId: string;
	private readonly rest: DiscordRest;
	private readonly gatewayFactory: (token: string, options: GatewayOptions) => { start(): void; stop(): void };

	private dmChannelId: string | undefined;
	private dmChannelPromise: Promise<string> | undefined;
	private botUserId: string | undefined;
	private lastSeenMessageId: string | undefined;

	private refs = 0;
	private _connected = false;
	private isFirstReady = true;
	private isShuttingDown = false;

	private gateway: BridgeGatewayLike | undefined;
	private readyPromise: Promise<void> | undefined;
	private readyResolve: (() => void) | undefined;
	private readyReject: ((error: Error) => void) | undefined;
	private readyTimer: TimerHandle | undefined;

	private readonly errorHandlers = new Set<(error: Error) => void>();

	constructor(options: BridgeOptions) {
		this.token = options.token;
		this.userId = options.userId;
		if (options.logger !== undefined) {
			this.logger = options.logger;
		}
		this.rest = options.rest ?? createDiscordRest(options.token);
		this.gatewayFactory =
			options.gatewayFactory ??
			((token: string, opts: GatewayOptions) => new Gateway(token, opts));
	}

	public get connected(): boolean {
		return this._connected;
	}

	public async acquire(): Promise<void> {
		if (this.isShuttingDown) {
			throw new Error("Cannot acquire DiscordBridge: bridge has been shut down");
		}

		this.refs++;

		if (this._connected) {
			return;
		}

		if (this.readyPromise) {
			try {
				await this.readyPromise;
			} catch (err) {
				this.refs = Math.max(0, this.refs - 1);
				if (this.refs === 0) {
					this.stopGateway();
				}
				throw err;
			}
			return;
		}

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.readyPromise = promise;
		this.readyResolve = resolve;
		this.readyReject = reject;
		const timer = setTimeout(() => {
			this.readyTimer = undefined;
			const timeoutErr = new Error("Timeout awaiting Discord gateway READY (15s)");
			this.handleFatal(timeoutErr);
		}, 15_000);
		timer.unref?.();
		this.readyTimer = timer;

		try {
			this.gateway = this.gatewayFactory(this.token, {
				...(this.logger !== undefined ? { logger: this.logger } : {}),
				onReady: (botUserId: string) => this.handleReady(botUserId),
				onMessage: (msg: GatewayMessageCreateData) => this.handleMessage(msg),
				onInteraction: (data: GatewayInteractionCreateData) => this.handleInteraction(data),
				onFatal: (err: Error) => this.handleFatal(err),
			});

			this.gateway.start();
			await this.readyPromise;
		} catch (err) {
			this.refs = Math.max(0, this.refs - 1);
			if (this.refs === 0) {
				this.stopGateway();
			}
			throw err;
		}
	}

	public release(): void {
		this.refs = Math.max(0, this.refs - 1);
		if (this.refs === 0) {
			this.stopGateway();
		}
	}

	public async postQuestion(oq: OpenQuestion): Promise<string> {
		if (this.isShuttingDown || this.closedAskKeys.includes(oq.askKey)) {
			throw new Error(`Cannot post question: ask ${oq.askKey} is already closed or shutting down`);
		}

		const channelId = await this.ensureDmChannel();
		const messageId = await this.rest.send(channelId, {
			content: oq.content,
			components: oq.components,
		});

		// Async send must not resurrect a question during shutdown.
		if (this.isShuttingDown) {
			try {
				await this.rest.edit(channelId, messageId, {
					content: closedContent(oq.content, "shutdown"),
					components: [],
				});
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				this.logger?.warn("Failed to close resurrected question after send", { error: error.message });
			}
			return messageId;
		}

		// When closedAskKeys contains key after send but not isShuttingDown,
		// do not register in open and do not edit cancelled here.
		// Remote-ask owns the closure reason (terminal vs cancelled) and will
		// close the question with that captured reason once postQuestion returns.
		if (this.closedAskKeys.includes(oq.askKey)) {
			return messageId;
		}

		this.open.set(messageId, oq);
		this.updateLastSeenMessageId(messageId);
		return messageId;
	}

	public async closeQuestion(id: string, content: string): Promise<void> {
		// Remove synchronously before awaited edit
		this.open.delete(id);
		try {
			const channelId = await this.ensureDmChannel();
			await this.rest.edit(channelId, id, {
				content,
				components: [],
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logger?.warn("Failed to edit closed question message", { error: error.message });
		}
	}

	public rememberClosedAsk(key: string): void {
		if (!key) {
			return;
		}
		const idx = this.closedAskKeys.indexOf(key);
		if (idx !== -1) {
			this.closedAskKeys.splice(idx, 1);
		}
		this.closedAskKeys.push(key);
		while (this.closedAskKeys.length > 100) {
			this.closedAskKeys.shift();
		}
	}

	public onError(handler: (error: Error) => void): () => void {
		this.errorHandlers.add(handler);
		return () => {
			this.errorHandlers.delete(handler);
		};
	}

	public async shutdownAll(
		reason: "terminal" | "cancelled" | "shutdown" = "shutdown",
	): Promise<void> {
		this.isShuttingDown = true;
		if (currentBridge === this) {
			currentBridge = undefined;
			currentKey = undefined;
		}

		const entries = Array.from(this.open.entries());
		this.open.clear();

		for (const [, oq] of entries) {
			this.rememberClosedAsk(oq.askKey);
		}

		if (entries.length > 0) {
			const editPromises = entries.map(async ([msgId, oq]) => {
				try {
					const channelId = await this.ensureDmChannel();
					await this.rest.edit(channelId, msgId, {
						content: closedContent(oq.content, reason),
						components: [],
					});
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					this.logger?.warn("Failed to edit message in shutdownAll", { error: error.message });
				}
			});

			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
			const timeoutTimer = setTimeout(timeoutResolve, 1500);
			timeoutTimer.unref?.();

			try {
				await Promise.race([
					Promise.allSettled(editPromises),
					timeoutPromise,
				]);
			} finally {
				clearTimeout(timeoutTimer);
			}
		}

		this.stopGateway();
	}

	private async ensureDmChannel(): Promise<string> {
		if (this.dmChannelId) {
			return this.dmChannelId;
		}
		if (!this.dmChannelPromise) {
			this.dmChannelPromise = (async () => {
				try {
					const id = await this.rest.openDm(this.userId);
					this.dmChannelId = id;
					return id;
				} finally {
					this.dmChannelPromise = undefined;
				}
			})();
		}
		return this.dmChannelPromise;
	}

	private async ensureBotUserId(): Promise<string> {
		if (this.botUserId) {
			return this.botUserId;
		}
		const me = await this.rest.getMe();
		this.botUserId = me.id;
		return this.botUserId;
	}

	private stopGateway(): void {
		if (this.readyTimer !== undefined) {
			clearTimeout(this.readyTimer as unknown as number);
			this.readyTimer = undefined;
		}
		if (this.readyReject) {
			const reject = this.readyReject;
			this.readyReject = undefined;
			this.readyResolve = undefined;
			reject(new Error("Gateway stopped before READY"));
		}
		this.readyPromise = undefined;
		this._connected = false;
		this.isFirstReady = true;

		if (this.gateway) {
			try {
				this.gateway.stop();
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				this.logger?.warn("Error stopping gateway", { error: error.message });
			}
			this.gateway = undefined;
		}
	}

	private async handleReady(botUserId: string): Promise<void> {
		try {
			this.botUserId = botUserId;
			this._connected = true;

			if (this.readyTimer !== undefined) {
				clearTimeout(this.readyTimer as unknown as number);
				this.readyTimer = undefined;
			}
			if (this.readyResolve) {
				const resolve = this.readyResolve;
				this.readyResolve = undefined;
				this.readyReject = undefined;
				this.readyPromise = undefined;
				resolve();
			}

			if (this.isFirstReady) {
				this.isFirstReady = false;
			} else {
				await this.catchUpAfterReconnect();
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logger?.warn("Error in handleReady", { error: error.message });
		}
	}

	private handleFatal(err: Error): void {
		try {
			if (this.readyTimer !== undefined) {
				clearTimeout(this.readyTimer as unknown as number);
				this.readyTimer = undefined;
			}
			if (this.readyReject) {
				const reject = this.readyReject;
				this.readyReject = undefined;
				this.readyResolve = undefined;
				this.readyPromise = undefined;
				reject(err);
			}
			this._connected = false;
			this.notifyError(err);
		} catch (innerErr) {
			const error = innerErr instanceof Error ? innerErr : new Error(String(innerErr));
			this.logger?.warn("Error in handleFatal", { error: error.message });
		}
	}

	private updateLastSeenMessageId(id: string): void {
		if (!id) {
			return;
		}
		if (!this.lastSeenMessageId) {
			this.lastSeenMessageId = id;
			return;
		}
		if (compareSnowflakesDesc(this.lastSeenMessageId, id) > 0) {
			this.lastSeenMessageId = id;
		}
	}

	private async catchUpAfterReconnect(): Promise<void> {
		if (!this.lastSeenMessageId) {
			return;
		}
		try {
			const channelId = await this.ensureDmChannel();
			const cursor = this.lastSeenMessageId;
			const messages = await this.rest.recent(channelId, { after: cursor });

			const sorted = [...messages].sort((a, b) => compareSnowflakesDesc(b.id, a.id));

			for (const msg of sorted) {
				await this.handleMessage({
					id: msg.id,
					channel_id: msg.channel_id,
					content: msg.content,
					author: {
						id: msg.author.id,
						...(msg.author.username !== undefined ? { username: msg.author.username } : {}),
						...(msg.author.bot !== undefined ? { bot: msg.author.bot } : {}),
					},
					...(msg.message_reference !== undefined ? { message_reference: msg.message_reference } : {}),
				});
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logger?.warn("Error during reconnect catch-up", { error: error.message });
		}
	}

	private async handleMessage(d: GatewayMessageCreateData): Promise<void> {
		try {
			if (d.author.id !== this.userId) {
				return;
			}
			if (this.botUserId && d.author.id === this.botUserId) {
				return;
			}
			if (d.author.bot) {
				return;
			}

			let dmId = this.dmChannelId;
			if (!dmId) {
				try {
					dmId = await this.ensureDmChannel();
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					this.logger?.warn("Failed to get DM channel in handleMessage", { error: error.message });
					return;
				}
			}
			if (d.channel_id !== dmId) {
				return;
			}

			this.updateLastSeenMessageId(d.id);

			if (this.open.size === 0) {
				return;
			}

			let targetMessageId: string | undefined;

			if (d.message_reference?.message_id) {
				const refId = d.message_reference.message_id;
				if (this.open.has(refId)) {
					targetMessageId = refId;
				} else {
					// Reference to other process or closed question: must not steal!
					return;
				}
			} else {
				let recentMessages: DiscordMessage[];
				try {
					recentMessages = await this.rest.recent(dmId, { limit: 50 });
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					this.logger?.warn("Error fetching recent messages for routing", { error: error.message });
					return;
				}

				let botId = this.botUserId;
				if (!botId) {
					try {
						botId = await this.ensureBotUserId();
					} catch (err) {
						const error = err instanceof Error ? err : new Error(String(err));
						this.logger?.warn("Error resolving bot user id for routing", { error: error.message });
						return;
					}
				}

				const botQuestions = recentMessages.filter(
					(m) =>
						(m.author?.id === botId || (this.botUserId !== undefined && m.author?.id === this.botUserId)) &&
						typeof m.content === "string" &&
						m.content.startsWith("❓") &&
						compareSnowflakesDesc(m.id, d.id) > 0,
				);

				if (botQuestions.length === 0) {
					return;
				}

				botQuestions.sort((a, b) => compareSnowflakesDesc(a.id, b.id));
				const newestBotMsg = botQuestions[0];
				if (!newestBotMsg) {
					return;
				}

				if (this.open.has(newestBotMsg.id)) {
					targetMessageId = newestBotMsg.id;
				} else {
					// Newest bot question belongs to another process!
					return;
				}
			}

			if (!targetMessageId) {
				return;
			}

			const oq = this.open.get(targetMessageId);
			if (!oq) {
				return;
			}

			const answer = parseReply(oq.question, d.content);
			if (!answer) {
				return;
			}

			// Remove synchronously before resolve to prevent double claims
			this.open.delete(targetMessageId);

			// Call edit promptly without waiting network
			const editContent = answeredContent(oq.content, answer);
			this.rest
				.edit(dmId, targetMessageId, {
					content: editContent,
					components: [],
				})
				.catch((err) => {
					const error = err instanceof Error ? err : new Error(String(err));
					this.logger?.warn("Failed to edit answered question message", { error: error.message });
				});

			// Resolve without waiting network for first-answer semantics
			oq.resolve(answer);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logger?.warn("Error in handleMessage", { error: error.message });
		}
	}

	private handleInteraction(d: GatewayInteractionCreateData): void {
		try {
			if (d.type !== 3) {
				return;
			}

			const interactorId = d.user?.id ?? d.member?.user?.id;
			if (interactorId !== this.userId) {
				return;
			}

			const customId = d.data?.custom_id;
			if (!customId) {
				return;
			}

			const match = /^lac:([^:]+):(\d+):(\d+|sel)$/.exec(customId);
			if (!match) {
				return;
			}

			const [, askKey, qIndexStr, customIdTail] = match;
			if (askKey === undefined || qIndexStr === undefined || customIdTail === undefined) {
				return;
			}
			const qIndex = Number.parseInt(qIndexStr, 10);

			let targetMsgId: string | undefined;
			let targetOq: OpenQuestion | undefined;
			for (const [msgId, oq] of this.open.entries()) {
				if (oq.askKey === askKey && oq.qIndex === qIndex) {
					targetMsgId = msgId;
					targetOq = oq;
					break;
				}
			}

			if (targetOq && targetMsgId) {
				const answer = answerFromComponent(targetOq.question, customIdTail, d.data?.values);
				if (!answer) {
					return;
				}

				// Synchronously remove from open to prevent double claims
				this.open.delete(targetMsgId);

				// Own open ACK type 7 immediately before other awaits
				const content = answeredContent(targetOq.content, answer);
				this.rest
					.respondInteraction(d.id, d.token, {
						content,
						components: [],
					})
					.catch((err) => {
						const error = err instanceof Error ? err : new Error(String(err));
						this.logger?.warn("Failed to respond to interaction (type 7)", { error: error.message });
					});

				// Resolve immediately
				targetOq.resolve(answer);
				return;
			}

			// Bounded last 100 closed keys ACK null (type 6)
			if (this.closedAskKeys.includes(askKey)) {
				this.rest
					.respondInteraction(d.id, d.token, null)
					.catch((err) => {
						const error = err instanceof Error ? err : new Error(String(err));
						this.logger?.warn("Failed to respond to interaction on closed ask (type 6)", {
							error: error.message,
						});
					});
				return;
			}

			// Foreign: ignore
			return;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logger?.warn("Error in handleInteraction", { error: error.message });
		}
	}

	private notifyError(error: Error): void {
		for (const handler of this.errorHandlers) {
			try {
				handler(error);
			} catch (err) {
				const handlerErr = err instanceof Error ? err : new Error(String(err));
				this.logger?.warn("Error in onError listener", { error: handlerErr.message });
			}
		}
	}
}

let currentBridge: DiscordBridge | undefined;
let currentKey: string | undefined;

export function getCurrentBridge(): DiscordBridge | undefined {
	return currentBridge;
}

export function getBridge(options: BridgeOptions): DiscordBridge {
	const key = `${options.token}:${options.userId}`;
	if (currentBridge && currentKey === key) {
		if (options.logger !== undefined) {
			currentBridge.logger = options.logger;
		}
		return currentBridge;
	}

	if (currentBridge) {
		const old = currentBridge;
		void old.shutdownAll("shutdown").catch((err) => {
			const error = err instanceof Error ? err : new Error(String(err));
			old.logger?.warn?.("Error shutting down previous bridge", { error: error.message });
		});
	}

	currentKey = key;
	currentBridge = new DiscordBridge(options);
	return currentBridge;
}
