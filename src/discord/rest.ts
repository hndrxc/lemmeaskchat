/**
 * Discord REST API client for omp-lemmeaskchat.
 * Implements Discord v10 REST endpoints with bot authorization,
 * automatic rate limit (HTTP 429) retries, and parse: [] allowed_mentions.
 */

import { setTimeout as sleep } from "node:timers/promises";

export const BASE_URL = "https://discord.com/api/v10";
export const USER_AGENT = "DiscordBot (https://github.com/hndrxc/lemmemeaskchat, 0.1.0)";

/**
 * Error thrown when a Discord REST API request fails.
 *
 * @param status - HTTP response status code (e.g. 401, 403, 404, 429, 500)
 * @param code - Discord API JSON error code (e.g. 50007 "Cannot send messages to this user"), or undefined if unavailable
 * @param message - Human-readable error description
 */
export class DiscordApiError extends Error {
	readonly status: number;
	readonly code: number | undefined;

	constructor(status: number, code: number | undefined, message: string) {
		super(message);
		this.name = "DiscordApiError";
		this.status = status;
		this.code = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export interface DiscordUser {
	id: string;
	username: string;
	discriminator?: string;
	bot?: boolean;
	[key: string]: unknown;
}

export interface DiscordMessage {
	id: string;
	channel_id: string;
	author: DiscordUser;
	content: string;
	components?: unknown[];
	message_reference?: {
		message_id?: string;
		channel_id?: string;
		guild_id?: string;
	};
	[key: string]: unknown;
}

export interface DiscordMessagePayload {
	content: string;
	components?: unknown[];
	[key: string]: unknown;
}

export interface DiscordMessageEditPayload {
	content?: string;
	components?: unknown[];
	[key: string]: unknown;
}

export interface DiscordRecentOptions {
	after?: string;
	limit?: number;
}

export interface DiscordInteractionResponsePayload {
	content?: string;
	components?: unknown[];
	[key: string]: unknown;
}

export interface DiscordRest {
	getMe(): Promise<DiscordUser>;
	openDm(userId: string): Promise<string>;
	send(channelId: string, payload: DiscordMessagePayload): Promise<string>;
	edit(channelId: string, messageId: string, payload: DiscordMessageEditPayload): Promise<DiscordMessage>;
	recent(channelId: string, options?: DiscordRecentOptions): Promise<DiscordMessage[]>;
	respondInteraction(id: string, token: string, payload: DiscordInteractionResponsePayload | null): Promise<void>;
}

/**
 * Callable fetch implementation signature compatible with standard fetch.
 * Omits platform-specific static properties such as Bun's fetch.preconnect.
 */
export type FetchImpl = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Creates a Discord REST client with bot authorization and 429 rate limit retries.
 *
 * @param token - Discord bot token
 * @param fetchImpl - Fetch implementation to use (defaults to global fetch)
 */
export function createDiscordRest(
	token: string,
	fetchImpl: FetchImpl = fetch,
): DiscordRest {
	async function request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
		const url = `${BASE_URL}${endpoint}`;
		const init: RequestInit = {
			method,
			headers: {
				Authorization: `Bot ${token}`,
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
			},
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const MAX_ATTEMPTS = 3;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const response = await fetchImpl(url, init);

			if (response.status === 429) {
				let retryAfterSeconds = 1;
				let errorCode: number | undefined;
				let errorMessage: string | undefined;

				try {
					const text = await response.text();
					if (text) {
						const parsed = JSON.parse(text) as Record<string, unknown>;
						if (typeof parsed === "object" && parsed !== null) {
							if (typeof parsed.retry_after === "number" && parsed.retry_after >= 0) {
								retryAfterSeconds = parsed.retry_after;
							}
							if (typeof parsed.code === "number") {
								errorCode = parsed.code;
							}
							if (typeof parsed.message === "string") {
								errorMessage = parsed.message;
							}
						}
						if (!errorMessage && text) {
							errorMessage = text;
						}
					}
				} catch {
					// Body text or JSON parsing failed
				}

				if (attempt < MAX_ATTEMPTS) {
					await sleep(retryAfterSeconds * 1000);
					continue;
				}

				throw new DiscordApiError(
					429,
					errorCode,
					errorMessage ?? "Rate limited",
				);
			}

			if (!response.ok) {
				let errorCode: number | undefined;
				let errorMessage: string | undefined;

				try {
					const text = await response.text();
					if (text) {
						const parsed = JSON.parse(text) as Record<string, unknown>;
						if (typeof parsed === "object" && parsed !== null) {
							if (typeof parsed.code === "number") {
								errorCode = parsed.code;
							}
							if (typeof parsed.message === "string") {
								errorMessage = parsed.message;
							}
						}
						if (!errorMessage && text) {
							errorMessage = text;
						}
					}
				} catch {
					// Body text or JSON parsing failed
				}

				throw new DiscordApiError(
					response.status,
					errorCode,
					errorMessage ?? response.statusText ?? `HTTP error ${response.status}`,
				);
			}

			if (response.status === 204) {
				return undefined as T;
			}

			const text = await response.text();
			if (!text) {
				return undefined as T;
			}

			try {
				return JSON.parse(text) as T;
			} catch {
				return text as unknown as T;
			}
		}

		throw new DiscordApiError(429, undefined, "Rate limited");
	}

	return {
		async getMe(): Promise<DiscordUser> {
			return await request<DiscordUser>("GET", "/users/@me");
		},

		async openDm(userId: string): Promise<string> {
			const channel = await request<{ id: string }>("POST", "/users/@me/channels", {
				recipient_id: userId,
			});
			if (typeof channel?.id !== "string") {
				throw new DiscordApiError(500, undefined, "Discord API did not return a channel ID");
			}
			return channel.id;
		},

		async send(channelId: string, payload: DiscordMessagePayload): Promise<string> {
			const message = await request<{ id: string }>("POST", `/channels/${channelId}/messages`, {
				...payload,
				allowed_mentions: { parse: [] },
			});
			if (typeof message?.id !== "string") {
				throw new DiscordApiError(500, undefined, "Discord API did not return a message ID");
			}
			return message.id;
		},

		async edit(channelId: string, messageId: string, payload: DiscordMessageEditPayload): Promise<DiscordMessage> {
			return await request<DiscordMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, {
				...payload,
				allowed_mentions: { parse: [] },
			});
		},

		async recent(channelId: string, options?: DiscordRecentOptions): Promise<DiscordMessage[]> {
			const params = new URLSearchParams();
			params.set("limit", String(options?.limit ?? 50));
			if (options?.after !== undefined && options.after !== "") {
				params.set("after", options.after);
			}
			const query = params.toString();
			return await request<DiscordMessage[]>("GET", `/channels/${channelId}/messages?${query}`);
		},

		async respondInteraction(
			id: string,
			token: string,
			payload: DiscordInteractionResponsePayload | null,
		): Promise<void> {
			const body = payload !== null
				? {
						type: 7,
						data: {
							...payload,
							allowed_mentions: { parse: [] },
						},
					}
				: {
						type: 6,
					};
			await request<void>("POST", `/interactions/${id}/${token}/callback`, body);
		},
	};
}
