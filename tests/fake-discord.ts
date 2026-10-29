/**
 * In-memory test adapters for Discord REST API and Discord Gateway.
 * Reusable for testing DiscordBridge, startRemoteAsk, and step 6 ask-race wrapper.
 */

import type { AskQuestion, QuestionAnswer } from "../src/ask-format";
import { DiscordBridge, type BridgeOptions, type OpenQuestion } from "../src/discord/bridge";
import type {
	GatewayInteractionCreateData,
	GatewayMessageCreateData,
	GatewayOptions,
} from "../src/discord/gateway";
import {
	type DiscordInteractionResponsePayload,
	type DiscordMessage,
	type DiscordMessageEditPayload,
	type DiscordMessagePayload,
	type DiscordRecentOptions,
	type DiscordRest,
	type DiscordUser,
} from "../src/discord/rest";
import type { HostLogger } from "../src/host";

/**
 * Spy / recorded logger implementing HostLogger.
 */
export class FakeLogger implements HostLogger {
	readonly logs: Array<{
		level: "info" | "warn" | "error" | "debug";
		message: string;
		args: unknown[];
	}> = [];

	info(message: string, ...args: unknown[]): void {
		this.logs.push({ level: "info", message, args });
	}

	warn(message: string, ...args: unknown[]): void {
		this.logs.push({ level: "warn", message, args });
	}

	error(message: string, ...args: unknown[]): void {
		this.logs.push({ level: "error", message, args });
	}

	debug(message: string, ...args: unknown[]): void {
		this.logs.push({ level: "debug", message, args });
	}

	hasMessage(pattern: string | RegExp): boolean {
		return this.logs.some((l) =>
			typeof pattern === "string" ? l.message.includes(pattern) : pattern.test(l.message),
		);
	}

	clear(): void {
		this.logs.length = 0;
	}
}

export function createFakeLogger(): FakeLogger {
	return new FakeLogger();
}

/**
 * In-memory representation of a running Gateway session.
 */
export class FakeGatewayInstance {
	readonly token: string;
	readonly options: GatewayOptions;
	private readonly parent: FakeDiscord;

	running = false;
	startCount = 0;
	stopCount = 0;

	constructor(token: string, options: GatewayOptions, parent: FakeDiscord) {
		this.token = token;
		this.options = options;
		this.parent = parent;
	}

	start(): void {
		this.running = true;
		this.startCount++;
		this.parent.onGatewayStart?.(this);

		if (this.parent.autoReady) {
			queueMicrotask(() => {
				if (this.running) {
					void this.emitReady(this.parent.botUserId);
				}
			});
		}
	}

	stop(): void {
		this.running = false;
		this.stopCount++;
		this.parent.onGatewayStop?.(this);
	}

	async emitReady(botUserId = this.parent.botUserId): Promise<void> {
		await this.options.onReady(botUserId);
	}

	async emitMessage(data: GatewayMessageCreateData): Promise<void> {
		await this.options.onMessage(data);
	}

	async emitInteraction(data: GatewayInteractionCreateData): Promise<void> {
		await this.options.onInteraction(data);
	}

	async emitFatal(error: Error): Promise<void> {
		await this.options.onFatal(error);
	}
}

export interface FakeDiscordOptions {
	botUserId?: string;
	botUsername?: string;
	defaultDmChannelId?: string;
	autoReady?: boolean;
}

export interface FakeBridgeOptionsOverrides {
	token?: string;
	logger?: HostLogger;
	rest?: DiscordRest;
	gatewayFactory?: (token: string, options: GatewayOptions) => { start(): void; stop(): void };
}

/**
 * Full in-memory Discord environment providing simulated REST and Gateway adapters.
 */
export class FakeDiscord {
	readonly botUserId: string;
	readonly botUsername: string;
	readonly defaultDmChannelId: string;
	autoReady: boolean;

	messages: DiscordMessage[] = [];
	sentMessages: Array<{ channelId: string; messageId: string; payload: DiscordMessagePayload }> = [];
	editedMessages: Array<{
		channelId: string;
		messageId: string;
		payload: DiscordMessageEditPayload;
	}> = [];
	interactionResponses: Array<{
		id: string;
		token: string;
		payload: DiscordInteractionResponsePayload | null;
	}> = [];
	gateways: FakeGatewayInstance[] = [];

	private nextMessageId = 1000000000000000000n;
	private nextInteractionId = 5000000000000000000n;

	private sendWaiters: Array<
		(msg: { channelId: string; messageId: string; payload: DiscordMessagePayload }) => void
	> = [];
	private editWaiters: Array<
		(edit: { channelId: string; messageId: string; payload: DiscordMessageEditPayload }) => boolean
	> = [];
	private interactionWaiters: Array<
		(resp: { id: string; token: string; payload: DiscordInteractionResponsePayload | null }) => void
	> = [];
	// Injected errors for failure injection
	sendError: Error | null = null;
	editError: Error | null = null;
	getMeError: Error | null = null;
	openDmError: Error | null = null;

	// Interceptors
	onSend?: (channelId: string, payload: DiscordMessagePayload) => void;
	onEdit?: (channelId: string, messageId: string, payload: DiscordMessageEditPayload) => void;
	onRespondInteraction?: (
		id: string,
		token: string,
		payload: DiscordInteractionResponsePayload | null,
	) => void;
	onGatewayStart?: (gateway: FakeGatewayInstance) => void;
	onGatewayStop?: (gateway: FakeGatewayInstance) => void;

	readonly rest: DiscordRest;
	readonly gatewayFactory: (token: string, options: GatewayOptions) => { start(): void; stop(): void };

	constructor(options: FakeDiscordOptions = {}) {
		this.botUserId = options.botUserId ?? "bot_user_123";
		this.botUsername = options.botUsername ?? "TestBot";
		this.defaultDmChannelId = options.defaultDmChannelId ?? "dm_channel_999";
		this.autoReady = options.autoReady ?? true;

		this.rest = {
			getMe: async (): Promise<DiscordUser> => {
				if (this.getMeError) {
					throw this.getMeError;
				}
				const user: DiscordUser = {
					id: this.botUserId,
					username: this.botUsername,
					bot: true,
				};
				return user;
			},

			openDm: async (_userId: string): Promise<string> => {
				if (this.openDmError) {
					throw this.openDmError;
				}
				return this.defaultDmChannelId;
			},

			send: async (channelId: string, payload: DiscordMessagePayload): Promise<string> => {
				if (this.sendError) {
					throw this.sendError;
				}
				this.onSend?.(channelId, payload);

				const messageId = String(++this.nextMessageId);
				const msg: DiscordMessage = {
					id: messageId,
					channel_id: channelId,
					author: {
						id: this.botUserId,
						username: this.botUsername,
						bot: true,
					},
					content: payload.content,
				};
				if (payload.components !== undefined) {
					msg.components = payload.components;
				}

				this.messages.push(msg);
				const sentEntry = { channelId, messageId, payload };
				this.sentMessages.push(sentEntry);
				const sendWaiters = this.sendWaiters.splice(0);
				for (const resolve of sendWaiters) {
					resolve(sentEntry);
				}
				return messageId;
			},

			edit: async (
				channelId: string,
				messageId: string,
				payload: DiscordMessageEditPayload,
			): Promise<DiscordMessage> => {
				if (this.editError) {
					throw this.editError;
				}
				this.onEdit?.(channelId, messageId, payload);

				let existing = this.messages.find((m) => m.id === messageId);
				if (!existing) {
					existing = {
						id: messageId,
						channel_id: channelId,
						author: {
							id: this.botUserId,
							username: this.botUsername,
							bot: true,
						},
						content: payload.content ?? "",
					};
					if (payload.components !== undefined) {
						existing.components = payload.components;
					}
					this.messages.push(existing);
				} else {
					if (payload.content !== undefined) {
						existing.content = payload.content;
					}
					if (payload.components !== undefined) {
						existing.components = payload.components;
					}
				}

				const editEntry = { channelId, messageId, payload };
				this.editedMessages.push(editEntry);
				this.editWaiters = this.editWaiters.filter((waiter) => !waiter(editEntry));
				return existing;
			},

			recent: async (
				channelId: string,
				options?: DiscordRecentOptions,
			): Promise<DiscordMessage[]> => {
				const channelMessages = this.messages.filter((m) => m.channel_id === channelId);

				if (options?.after !== undefined) {
					const afterIndex = channelMessages.findIndex((m) => m.id === options.after);
					const msgs = afterIndex >= 0 ? channelMessages.slice(afterIndex + 1) : channelMessages;
					const limit = options.limit ?? 50;
					return msgs.slice(0, limit);
				}

				const limit = options?.limit ?? 50;
				// Default Discord recent: descending (newest first)
				const msgs = [...channelMessages].reverse().slice(0, limit);
				return msgs;
			},

			respondInteraction: async (
				id: string,
				token: string,
				payload: DiscordInteractionResponsePayload | null,
			): Promise<void> => {
				this.onRespondInteraction?.(id, token, payload);
				const respEntry = { id, token, payload };
				this.interactionResponses.push(respEntry);
				const interactionWaiters = this.interactionWaiters.splice(0);
				for (const resolve of interactionWaiters) {
					resolve(respEntry);
				}
			},
		};

		this.gatewayFactory = (
			token: string,
			gatewayOptions: GatewayOptions,
		): { start(): void; stop(): void } => {
			const gw = new FakeGatewayInstance(token, gatewayOptions, this);
			this.gateways.push(gw);
			return gw;
		};
	}

	get latestGateway(): FakeGatewayInstance | undefined {
		return this.gateways[this.gateways.length - 1];
	}

	createBridgeOptions(userId: string, overrides?: FakeBridgeOptionsOverrides): BridgeOptions {
		return {
			token: overrides?.token ?? "fake_token_abc",
			userId,
			logger: overrides?.logger ?? new FakeLogger(),
			rest: overrides?.rest ?? this.rest,
			gatewayFactory: overrides?.gatewayFactory ?? this.gatewayFactory,
		};
	}
	waitForNextSend(): Promise<{
		channelId: string;
		messageId: string;
		payload: DiscordMessagePayload;
	}> {
		const { promise, resolve } = Promise.withResolvers<{
			channelId: string;
			messageId: string;
			payload: DiscordMessagePayload;
		}>();
		this.sendWaiters.push(resolve);
		return promise;
	}

	waitForNextEdit(
		messageId?: string,
	): Promise<{ channelId: string; messageId: string; payload: DiscordMessageEditPayload }> {
		const { promise, resolve } = Promise.withResolvers<{
			channelId: string;
			messageId: string;
			payload: DiscordMessageEditPayload;
		}>();
		this.editWaiters.push((entry) => {
			if (messageId === undefined || entry.messageId === messageId) {
				resolve(entry);
				return true;
			}
			return false;
		});
		return promise;
	}

	/**
	 * Waits for the next send REST call and then waits until bridge.open has registered it.
	 */
	async waitForNextOpen(
		bridge: DiscordBridge,
		timeoutMs = 2000,
	): Promise<{
		channelId: string;
		messageId: string;
		payload: DiscordMessagePayload;
		openQuestion: OpenQuestion;
	}> {
		const sent = await this.waitForNextSend();
		const { openQuestion } = await waitForBridgeOpen(bridge, sent.messageId, timeoutMs);
		return { ...sent, openQuestion };
	}

	waitForNextInteractionResponse(): Promise<{
		id: string;
		token: string;
		payload: DiscordInteractionResponsePayload | null;
	}> {
		const { promise, resolve } = Promise.withResolvers<{
			id: string;
			token: string;
			payload: DiscordInteractionResponsePayload | null;
		}>();
		this.interactionWaiters.push(resolve);
		return promise;
	}


	/**
	 * Simulates the user sending a text message in the DM channel.
	 */
	async sendUserMessage(
		userId: string,
		content: string,
		options?: {
			replyToMessageId?: string;
			channelId?: string;
			messageId?: string;
			username?: string;
		},
	): Promise<GatewayMessageCreateData> {
		const messageId = options?.messageId ?? String(++this.nextMessageId);
		const channelId = options?.channelId ?? this.defaultDmChannelId;
		const username = options?.username ?? "TestUser";

		const discordMsg: DiscordMessage = {
			id: messageId,
			channel_id: channelId,
			author: {
				id: userId,
				username,
				bot: false,
			},
			content,
		};
		if (options?.replyToMessageId !== undefined) {
			discordMsg.message_reference = { message_id: options.replyToMessageId };
		}
		this.messages.push(discordMsg);

		const gwData: GatewayMessageCreateData = {
			id: messageId,
			channel_id: channelId,
			content,
			author: {
				id: userId,
				username,
				bot: false,
			},
		};
		if (options?.replyToMessageId !== undefined) {
			gwData.message_reference = { message_id: options.replyToMessageId };
		}

		if (this.latestGateway?.running) {
			await this.latestGateway.emitMessage(gwData);
		}

		return gwData;
	}

	/**
	 * Simulates the user clicking a button or selecting an option on a component.
	 */
	async sendUserInteraction(
		userId: string,
		customId: string,
		options?: {
			values?: string[];
			interactionId?: string;
			token?: string;
			username?: string;
		},
	): Promise<GatewayInteractionCreateData> {
		const interactionId = options?.interactionId ?? String(++this.nextInteractionId);
		const token = options?.token ?? `inter_token_${interactionId}`;
		const username = options?.username ?? "TestUser";

		const interaction: GatewayInteractionCreateData = {
			id: interactionId,
			token,
			type: 3, // MESSAGE_COMPONENT
			user: {
				id: userId,
				username,
			},
			data: {
				custom_id: customId,
			},
		};
		if (options?.values !== undefined && interaction.data) {
			interaction.data.values = options.values;
		}

		if (this.latestGateway?.running) {
			await this.latestGateway.emitInteraction(interaction);
		}

		return interaction;
	}

	/**
	 * Directly injects a bot message into the channel history (useful for simulating
	 * other processes or pre-existing questions).
	 */
	addBotMessage(
		channelId: string,
		content: string,
		options?: {
			messageId?: string;
			botUserId?: string;
			botUsername?: string;
			components?: unknown[];
		},
	): DiscordMessage {
		const messageId = options?.messageId ?? String(++this.nextMessageId);
		const msg: DiscordMessage = {
			id: messageId,
			channel_id: channelId,
			author: {
				id: options?.botUserId ?? this.botUserId,
				username: options?.botUsername ?? this.botUsername,
				bot: true,
			},
			content,
		};
		if (options?.components !== undefined) {
			msg.components = options.components;
		}
		this.messages.push(msg);
		return msg;
	}

	findMessage(messageId: string): DiscordMessage | undefined {
		return this.messages.find((m) => m.id === messageId);
	}

	findLatestBotQuestion(): DiscordMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m && m.author.id === this.botUserId && m.content.startsWith("❓")) {
				return m;
			}
		}
		return undefined;
	}

	reset(): void {
		this.messages.length = 0;
		this.sentMessages.length = 0;
		this.editedMessages.length = 0;
		this.interactionResponses.length = 0;
		this.gateways.length = 0;
		this.sendError = null;
		this.editError = null;
		this.getMeError = null;
		this.openDmError = null;
		this.sendWaiters.length = 0;
		this.editWaiters.length = 0;
		this.interactionWaiters.length = 0;
	}
}

export function createFakeDiscord(options?: FakeDiscordOptions): FakeDiscord {
	return new FakeDiscord(options);
}

/**
 * Polls a predicate until it returns true or timeout expires.
 * Yields via setTimeout(5) to allow event loop and microtask execution.
 */
export async function waitForCondition(
	predicate: () => boolean,
	description = "condition",
	timeoutMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 5);
		await promise;
	}
}

/**
 * Awaits until bridge.open contains a question (optionally matching messageId).
 * Bounded check ensuring bridge postQuestion has completed open registration.
 */
export async function waitForBridgeOpen(
	bridge: DiscordBridge,
	messageId?: string,
	timeoutMs = 2000,
): Promise<{ messageId: string; openQuestion: OpenQuestion }> {
	await waitForCondition(
		() => (messageId !== undefined ? bridge.open.has(messageId) : bridge.open.size > 0),
		`bridge.open to register question${messageId ? ` for messageId ${messageId}` : ""}`,
		timeoutMs,
	);
	const targetId = messageId ?? bridge.open.keys().next().value!;
	const openQuestion = bridge.open.get(targetId)!;
	return { messageId: targetId, openQuestion };
}
