import { describe, expect, it } from "bun:test";
import {
	BASE_URL,
	DiscordApiError,
	type FetchImpl,
	USER_AGENT,
	createDiscordRest,
} from "../src/discord/rest";

describe("Discord REST client", () => {
	const TEST_TOKEN = "secret-bot-token-xyz";

	describe("security-relevant headers and payloads", () => {
		it("sends Bot authorization and required User-Agent on requests", async () => {
			let capturedUrl = "";
			let capturedHeaders: HeadersInit | undefined;

			const mockFetch: FetchImpl = async (input, init) => {
				capturedUrl = String(input);
				capturedHeaders = init?.headers;
				return new Response(JSON.stringify({ id: "123", username: "bot" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			const me = await rest.getMe();

			expect(me.id).toBe("123");
			expect(capturedUrl).toBe(`${BASE_URL}/users/@me`);
			const headers = capturedHeaders as Record<string, string>;
			expect(headers.Authorization).toBe(`Bot ${TEST_TOKEN}`);
			expect(headers["User-Agent"]).toBe(USER_AGENT);
		});

		it("enforces allowed_mentions: { parse: [] } on send to prevent mentions", async () => {
			let capturedBody: Record<string, unknown> | undefined;

			const mockFetch: FetchImpl = async (_input, init) => {
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({ id: "msg-123" }), { status: 200 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			const msgId = await rest.send("channel-1", {
				content: "Hello @everyone",
				// Attempting to override allowed_mentions must be overridden by { parse: [] }
				...({ allowed_mentions: { parse: ["everyone"] } } as object),
			});

			expect(msgId).toBe("msg-123");
			expect(capturedBody?.allowed_mentions).toEqual({ parse: [] });
		});

		it("enforces allowed_mentions: { parse: [] } on edit", async () => {
			let capturedBody: Record<string, unknown> | undefined;

			const mockFetch: FetchImpl = async (_input, init) => {
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({ id: "msg-123", content: "updated" }), { status: 200 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			await rest.edit("channel-1", "msg-123", { content: "updated" });

			expect(capturedBody?.allowed_mentions).toEqual({ parse: [] });
		});

		it("sends type 7 with allowed_mentions: { parse: [] } on interaction response with payload", async () => {
			let capturedBody: Record<string, unknown> | undefined;

			const mockFetch: FetchImpl = async (_input, init) => {
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(null, { status: 204 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			await rest.respondInteraction("int-id", "int-tok", {
				content: "Answered",
				components: [],
			});

			expect(capturedBody).toEqual({
				type: 7,
				data: {
					content: "Answered",
					components: [],
					allowed_mentions: { parse: [] },
				},
			});
		});

		it("sends type 6 without data on interaction response when payload is null", async () => {
			let capturedBody: Record<string, unknown> | undefined;

			const mockFetch: FetchImpl = async (_input, init) => {
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(null, { status: 204 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			await rest.respondInteraction("int-id", "int-tok", null);

			expect(capturedBody).toEqual({ type: 6 });
		});
	});

	describe("consumer-visible error behavior", () => {
		it("parses Discord JSON error code and message on 403 (e.g. 50007 DM disabled)", async () => {
			const mockFetch: FetchImpl = async () => {
				return new Response(
					JSON.stringify({
						code: 50007,
						message: "Cannot send messages to this user",
					}),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				);
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			let thrown: unknown;
			try {
				await rest.send("dm-chan", { content: "question" });
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(DiscordApiError);
			const apiErr = thrown as DiscordApiError;
			expect(apiErr.status).toBe(403);
			expect(apiErr.code).toBe(50007);
			expect(apiErr.message).toBe("Cannot send messages to this user");
		});

		it("handles non-JSON error bodies gracefully", async () => {
			const mockFetch: FetchImpl = async () => {
				return new Response("502 Bad Gateway from cloudflare", {
					status: 502,
					statusText: "Bad Gateway",
				});
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			let thrown: unknown;
			try {
				await rest.getMe();
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(DiscordApiError);
			const apiErr = thrown as DiscordApiError;
			expect(apiErr.status).toBe(502);
			expect(apiErr.code).toBeUndefined();
		});
	});

	describe("rate limit (429) retry behavior", () => {
		it("retries after retry_after seconds and returns successful response on subsequent attempt", async () => {
			let callCount = 0;

			const mockFetch: FetchImpl = async () => {
				callCount++;
				if (callCount === 1) {
					return new Response(
						JSON.stringify({
							message: "You are being rate limited.",
							retry_after: 0.005,
							global: false,
						}),
						{ status: 429, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ id: "chan-999" }), { status: 200 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			const channelId = await rest.openDm("user-456");

			expect(channelId).toBe("chan-999");
			expect(callCount).toBe(2);
		});

		it("exhausts at max 3 attempts on continuous 429 and throws DiscordApiError(429)", async () => {
			let callCount = 0;

			const mockFetch: FetchImpl = async () => {
				callCount++;
				return new Response(
					JSON.stringify({
						message: "Exceeded rate limit",
						retry_after: 0.005,
						code: 0,
					}),
					{ status: 429, headers: { "Content-Type": "application/json" } },
				);
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			let thrown: unknown;
			try {
				await rest.send("chan-1", { content: "ping" });
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(DiscordApiError);
			const apiErr = thrown as DiscordApiError;
			expect(apiErr.status).toBe(429);
			expect(apiErr.code).toBe(0);
			expect(apiErr.message).toBe("Exceeded rate limit");
			expect(callCount).toBe(3);
		});
	});

	describe("endpoint routing and query formatting", () => {
		it("openDm returns channel id from POST /users/@me/channels", async () => {
			let capturedUrl = "";
			let capturedBody: Record<string, unknown> | undefined;

			const mockFetch: FetchImpl = async (input, init) => {
				capturedUrl = String(input);
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({ id: "dm-channel-id", type: 1 }), { status: 200 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			const chanId = await rest.openDm("target-user-id");

			expect(chanId).toBe("dm-channel-id");
			expect(capturedUrl).toBe(`${BASE_URL}/users/@me/channels`);
			expect(capturedBody).toEqual({ recipient_id: "target-user-id" });
		});

		it("recent defaults limit to 50 and appends after when provided", async () => {
			const urls: string[] = [];

			const mockFetch: FetchImpl = async (input) => {
				urls.push(String(input));
				return new Response(JSON.stringify([]), { status: 200 });
			};

			const rest = createDiscordRest(TEST_TOKEN, mockFetch);
			await rest.recent("chan-1");
			await rest.recent("chan-1", { after: "msg-99", limit: 20 });

			expect(urls[0]).toBe(`${BASE_URL}/channels/chan-1/messages?limit=50`);
			expect(urls[1]).toBe(`${BASE_URL}/channels/chan-1/messages?limit=20&after=msg-99`);
		});
	});
});
