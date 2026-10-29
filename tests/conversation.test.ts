import { describe, expect, it } from "bun:test";
import type { AskParams } from "../src/ask-format.ts";
import {
	DiscordBridge,
	type DiscordConversation,
	splitMessageChunks,
} from "../src/discord/bridge.ts";
import { startRemoteAsk } from "../src/remote-ask.ts";
import { createFakeDiscord, createFakeLogger, waitForBridgeOpen } from "./fake-discord.ts";
function defined<T>(value: T | undefined | null, message = "Expected value to be defined"): T {
	if (value === undefined || value === null) {
		throw new Error(message);
	}
	return value;
}


describe("DiscordConversation transport in DiscordBridge", () => {
	const userId = "user_conv_123456";

	describe("splitMessageChunks", () => {
		it("returns empty array for empty string", () => {
			expect(splitMessageChunks("")).toEqual([]);
		});

		it("returns single chunk when text <= 2000 code units", () => {
			const text = "a".repeat(2000);
			const chunks = splitMessageChunks(text);
			expect(chunks).toEqual([text]);
		});

		it("splits text > 2000 code units into ordered chunks", () => {
			const text = "a".repeat(2500);
			const chunks = splitMessageChunks(text);
			expect(chunks.length).toBe(2);
			const [chunk0, chunk1] = [defined(chunks[0]), defined(chunks[1])];
			expect(chunk0).toBe("a".repeat(2000));
			expect(chunk1).toBe("a".repeat(500));
			expect(chunks.join("")).toBe(text);
		});

		it("does not split surrogate pairs across chunk boundary", () => {
			// 1999 ASCII + 1 surrogate pair ("👍" = \uD83D\uDC4D, length 2) = 2001 code units
			const text = "a".repeat(1999) + "👍";
			expect(text.length).toBe(2001);

			const chunks = splitMessageChunks(text);
			expect(chunks.length).toBe(2);
			const [chunk0, chunk1] = [defined(chunks[0]), defined(chunks[1])];
			// Chunk 0 must end at index 1999 (avoiding splitting the high surrogate)
			expect(chunk0.length).toBe(1999);
			expect(chunk0).toBe("a".repeat(1999));
			// Chunk 1 must contain the entire surrogate pair
			expect(chunk1).toBe("👍");
			expect(chunks.join("")).toBe(text);
		});

		it("keeps surrogate pair intact when it ends at chunk boundary", () => {
			// 1998 ASCII + "👍" = 2000 code units
			const text = "a".repeat(1998) + "👍";
			expect(text.length).toBe(2000);

			const chunks = splitMessageChunks(text);
			expect(chunks.length).toBe(1);
			expect(defined(chunks[0])).toBe(text);
		});
	});

	it("repeated prompts to own messages work across turns", async () => {
		const fake = createFakeDiscord();
		const logger = createFakeLogger();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId, { logger }));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		expect(bridge.connected).toBe(true);

		// Send initial announcement
		await conv.send("Session has started.");
		expect(fake.sentMessages.length).toBe(1);
		const msg1 = defined(fake.sentMessages[0]);

		// First prompt quoting message 1
		await fake.sendUserMessage(userId, "Hello assistant", {
			replyToMessageId: msg1.messageId,
		});
		expect(prompts).toEqual(["Hello assistant"]);

		// Second prompt also quoting message 1 (e.g. repeated or queued followup)
		await fake.sendUserMessage(userId, "Second thought on message 1", {
			replyToMessageId: msg1.messageId,
		});
		expect(prompts).toEqual(["Hello assistant", "Second thought on message 1"]);

		// Assistant sends a completion message
		await conv.send("Session “test” has finished — awaiting response.\n\nHere is the answer.");
		expect(fake.sentMessages.length).toBe(2);
		const msg2 = defined(fake.sentMessages[1]);

		// User quotes message 2
		await fake.sendUserMessage(userId, "Follow-up to message 2", {
			replyToMessageId: msg2.messageId,
		});
		expect(prompts).toEqual([
			"Hello assistant",
			"Second thought on message 1",
			"Follow-up to message 2",
		]);

		// User quotes message 1 again
		await fake.sendUserMessage(userId, "Back to message 1", {
			replyToMessageId: msg1.messageId,
		});
		expect(prompts).toEqual([
			"Hello assistant",
			"Second thought on message 1",
			"Follow-up to message 2",
			"Back to message 1",
		]);

		conv.close();
		expect(bridge.connected).toBe(false);
	});

	it("foreign, stale, unauthorized, bot, wrong-channel, unquoted, and empty refs are ignored", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		await conv.send("Valid bot message");
		const validMsg = defined(fake.sentMessages[0]);

		// 1. Foreign quote ref (message ID not belonging to this conversation)
		await fake.sendUserMessage(userId, "quoting foreign message", {
			replyToMessageId: "999999999999999999",
		});
		expect(prompts.length).toBe(0);

		// 2. Unauthorized user
		await fake.sendUserMessage("unauthorized_user_999", "I am an attacker", {
			replyToMessageId: validMsg.messageId,
		});
		expect(prompts.length).toBe(0);

		// 3. Bot message (author.bot = true)
		if (fake.latestGateway?.running) {
			await fake.latestGateway.emitMessage({
				id: "bot_msg_event_1",
				channel_id: fake.defaultDmChannelId,
				content: "Bot echoing",
				author: { id: userId, bot: true },
				message_reference: { message_id: validMsg.messageId },
			});
		}
		expect(prompts.length).toBe(0);

		// 4. Wrong channel ID
		await fake.sendUserMessage(userId, "in wrong channel", {
			replyToMessageId: validMsg.messageId,
			channelId: "channel_not_dm_channel",
		});
		expect(prompts.length).toBe(0);

		// 5. Empty or whitespace-only prompt
		await fake.sendUserMessage(userId, "   ", {
			replyToMessageId: validMsg.messageId,
		});
		await fake.sendUserMessage(userId, "", {
			replyToMessageId: validMsg.messageId,
		});
		expect(prompts.length).toBe(0);

		// 6. Stale quote ref after conversation is closed
		// Keep gateway running with independent ref so message reaches bridge
		await bridge.acquire();
		conv.close();
		await fake.sendUserMessage(userId, "prompt to closed conversation", {
			replyToMessageId: validMsg.messageId,
		});
		expect(prompts.length).toBe(0);
		// 7. Unquoted message (no message_reference)
		await fake.sendUserMessage(userId, "unquoted prompt without reference");
		expect(prompts.length).toBe(0);
		bridge.release();
	});

	it("an ask reply vs conversation reply while ask is open", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const convPrompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			convPrompts.push(text);
		});

		// Send conversation greeting
		await conv.send("Conversation greeting");
		const convMsg = defined(fake.sentMessages[0]);

		// Start an ask question concurrently
		const askParams: AskParams = {
			questions: [
				{
					id: "q1",
					question: "What is your preference?",
					options: [{ label: "Option A" }, { label: "Option B" }],
				},
			],
		};

		const askSendPromise = fake.waitForNextSend();
		let askResolvedAnswer: unknown = undefined;
		const askHandle = startRemoteAsk({
			bridge,
			params: askParams,
			delayMs: 0,
			project: "test-proj",
			onError: () => {},
		});
		askHandle.result.then((res) => {
			askResolvedAnswer = res;
		});

		const askSent = await askSendPromise;
		await waitForBridgeOpen(bridge, askSent.messageId);

		// Both conversation and ask are open!
		expect(bridge.open.has(askSent.messageId)).toBe(true);

		// User quote-replies to the CONVERSATION message
		await fake.sendUserMessage(userId, "Replying to conversation while ask is open", {
			replyToMessageId: convMsg.messageId,
		});

		// Conversation receives prompt, ask remains open
		expect(convPrompts).toEqual(["Replying to conversation while ask is open"]);
		expect(bridge.open.has(askSent.messageId)).toBe(true);
		expect(askResolvedAnswer).toBeUndefined();

		// User quote-replies to the ASK message
		await fake.sendUserMessage(userId, "Option A", {
			replyToMessageId: askSent.messageId,
		});

		// Ask resolves, conversation callback is not called
		const results = await askHandle.result;
		expect(results).toBeDefined();
		expect(results).toHaveLength(1);
		expect(results?.[0]?.selectedOptions).toEqual(["Option A"]);
		expect(askResolvedAnswer).toEqual(results);
		expect(bridge.open.size).toBe(0);
		expect(convPrompts.length).toBe(1);

		conv.close();
	});

	it("duplicate events inject once across concurrent delivery and reconnect catch-up", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		await conv.send("Question from bot");
		const botMsg = defined(fake.sentMessages[0]);
		// User sends message to fake store while gateway is down
		fake.latestGateway!.stop();
		const gwData = await fake.sendUserMessage(userId, "Unique prompt text", {
			replyToMessageId: botMsg.messageId,
		});

		// Gated recent fetch started before live duplicate so same event arrives live+catchup
		const originalRecent = fake.rest.recent;
		const { promise: catchUpStartedPromise, resolve: notifyCatchUpStarted } = Promise.withResolvers<void>();
		const { promise: recentGatePromise, resolve: releaseRecentGate } = Promise.withResolvers<void>();

		fake.rest.recent = async (channelId, options) => {
			notifyCatchUpStarted();
			await recentGatePromise;
			return originalRecent(channelId, options);
		};

		// 1. Reconnect triggers catchUpAfterReconnect, which begins the gated recent() fetch
		const reconnectPromise = fake.latestGateway!.emitReady();

		// Wait until recent() fetch has been initiated
		await catchUpStartedPromise;

		// 2. While catch-up fetch is paused in flight, the live gateway duplicate arrives
		await fake.latestGateway!.emitMessage(gwData);
		expect(prompts).toEqual(["Unique prompt text"]);

		// 3. Now release the catch-up recent() fetch so the same message is processed by catch-up
		releaseRecentGate();
		await reconnectPromise;
		// 4. Deduplication ensures catch-up dropped the duplicate
		expect(prompts).toEqual(["Unique prompt text"]);
		conv.close();
	});

	it(">2000 response delivered in order and all chunks targetable", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		// 4500 characters: chunk 1 (2000), chunk 2 (2000), chunk 3 (500)
		const part1 = "1".repeat(2000);
		const part2 = "2".repeat(2000);
		const part3 = "3".repeat(500);
		const longText = part1 + part2 + part3;

		await conv.send(longText);

		expect(fake.sentMessages.length).toBe(3);
		const [chunk1, chunk2, chunk3] = [
			defined(fake.sentMessages[0]),
			defined(fake.sentMessages[1]),
			defined(fake.sentMessages[2]),
		];
		expect(chunk1.payload.content).toBe(part1);
		expect(chunk2.payload.content).toBe(part2);
		expect(chunk3.payload.content).toBe(part3);

		const chunk1Id = chunk1.messageId;
		const chunk2Id = chunk2.messageId;
		const chunk3Id = chunk3.messageId;

		// All 3 chunks must be targetable by quote-replies
		await fake.sendUserMessage(userId, "Replying to chunk 1", {
			replyToMessageId: chunk1Id,
		});
		await fake.sendUserMessage(userId, "Replying to chunk 2", {
			replyToMessageId: chunk2Id,
		});
		await fake.sendUserMessage(userId, "Replying to chunk 3", {
			replyToMessageId: chunk3Id,
		});

		expect(prompts).toEqual([
			"Replying to chunk 1",
			"Replying to chunk 2",
			"Replying to chunk 3",
		]);

		conv.close();
	});

	it("close during async send invalidates continuations, releases ref, and cannot reactivate", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		let conv: DiscordConversation | undefined;
		const prompts: string[] = [];

		conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		// Intercept the first REST send to close conversation mid-flight
		let closedDuringSend = false;
		fake.onSend = () => {
			if (!closedDuringSend) {
				closedDuringSend = true;
				conv!.close();
			}
		};

		// Send multi-chunk message (4000 chars = 2 chunks)
		const multiChunk = "x".repeat(4000);
		await conv.send(multiChunk);

		// Only the first chunk was initiated before close; second chunk must not be sent
		expect(fake.sentMessages.length).toBe(1);

		// Gateway reference released
		expect(bridge.connected).toBe(false);

		// Late send target was invalidated: quote-replying cannot reactivate conversation
		const lateSentMsgId = defined(fake.sentMessages[0]).messageId;
		await fake.latestGateway!.emitMessage({
			id: "late-reactivation-1",
			channel_id: fake.defaultDmChannelId,
			content: "Late reply attempting reactivation",
			author: { id: userId, username: "TestUser", bot: false },
			message_reference: { message_id: lateSentMsgId },
		});
		expect(prompts.length).toBe(0);

		// Subsequent send on closed conversation throws and does not resurrect refs
		await expect(conv.send("New message")).rejects.toThrow("Cannot send: conversation is closed");
		expect(bridge.connected).toBe(false);
	});

	it("shutdownAll invalidates all active conversations without reactivating", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		await conv.send("Hello before shutdown");
		const msgId = defined(fake.sentMessages[0]).messageId;

		await bridge.shutdownAll("shutdown");
		expect(bridge.connected).toBe(false);

		// Replying to sent message after shutdown is ignored
		await fake.latestGateway!.emitMessage({
			id: "after-shutdown-1",
			channel_id: fake.defaultDmChannelId,
			content: "Attempt after shutdown",
			author: { id: userId, username: "TestUser", bot: false },
			message_reference: { message_id: msgId },
		});
		expect(prompts.length).toBe(0);

		// Subsequent send throws and does not resurrect bridge
		await expect(conv.send("Send after shutdown")).rejects.toThrow();
		await expect(bridge.openConversation(() => {})).rejects.toThrow("Cannot open conversation: bridge has been shut down");
	});

	it("existing ask references remain completely independent from conversation refs", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const convPrompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			convPrompts.push(text);
		});

		// Bridge refs is 1 (conversation)
		expect(bridge.connected).toBe(true);

		// Start an ask question (acquires second ref -> refs is 2)
		const askParams: AskParams = {
			questions: [
				{
					id: "q1",
					question: "Select option",
					options: [{ label: "One" }],
				},
			],
		};

		const sendWait = fake.waitForNextSend();
		let askResolvedAnswer: unknown = undefined;
		const askHandle = startRemoteAsk({
			bridge,
			params: askParams,
			delayMs: 0,
			project: "proj",
			onError: () => {},
		});
		askHandle.result.then((res) => {
			askResolvedAnswer = res;
		});

		const askSent = await sendWait;
		await waitForBridgeOpen(bridge, askSent.messageId);

		// Now close the conversation
		conv.close();

		// Gateway must STAY connected because the ask holds its own independent ref!
		expect(bridge.connected).toBe(true);
		expect(bridge.open.has(askSent.messageId)).toBe(true);

		// Answering the ask works normally
		await fake.sendUserMessage(userId, "One", {
			replyToMessageId: askSent.messageId,
		});

		const results = await askHandle.result;
		expect(results).toBeDefined();
		expect(results).toHaveLength(1);
		expect(results?.[0]?.selectedOptions).toEqual(["One"]);
		expect(askResolvedAnswer).toEqual(results);

		// Now that both conversation and ask are closed, bridge gateway stops
		expect(bridge.connected).toBe(false);
	});

	it("multiple concurrent conversations in same process have independent targets and refs", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts1: string[] = [];
		const conv1 = await bridge.openConversation((text) => {
			prompts1.push(text);
		});

		const prompts2: string[] = [];
		const conv2 = await bridge.openConversation((text) => {
			prompts2.push(text);
		});

		await conv1.send("From conv 1");
		const msg1 = defined(fake.sentMessages[0]).messageId;

		await conv2.send("From conv 2");
		const msg2 = defined(fake.sentMessages[1]).messageId;

		// Reply to conv 1 routes only to conv 1
		await fake.sendUserMessage(userId, "To 1", { replyToMessageId: msg1 });
		expect(prompts1).toEqual(["To 1"]);
		expect(prompts2.length).toBe(0);

		// Reply to conv 2 routes only to conv 2
		await fake.sendUserMessage(userId, "To 2", { replyToMessageId: msg2 });
		expect(prompts1).toEqual(["To 1"]);
		expect(prompts2).toEqual(["To 2"]);

		// Close conv 1; conv 2 continues working
		conv1.close();
		expect(bridge.connected).toBe(true);

		// Msg 1 is now stale
		await fake.sendUserMessage(userId, "To 1 again", { replyToMessageId: msg1 });
		expect(prompts1.length).toBe(1);

		// Msg 2 is still live
		await fake.sendUserMessage(userId, "To 2 again", { replyToMessageId: msg2 });
		expect(prompts2).toEqual(["To 2", "To 2 again"]);

		// Close conv 2; bridge disconnects
		conv2.close();
		expect(bridge.connected).toBe(false);
	});

	it("close is idempotent and does not release excess refs", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const conv = await bridge.openConversation(() => {});
		expect(bridge.connected).toBe(true);

		conv.close();
		expect(bridge.connected).toBe(false);

		// Multiple close calls should not throw or cause negative refs
		conv.close();
		conv.close();
		expect(bridge.connected).toBe(false);
	});

	it("concurrent send calls preserve delivery order and targets", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		const textA = "a".repeat(2500);
		const textB = "b".repeat(2500);
		const p1 = conv.send(textA);
		const p2 = conv.send(textB);
		await Promise.all([p1, p2]);

		expect(fake.sentMessages.length).toBe(4);
		const [msg0, msg1, msg2, msg3] = [
			defined(fake.sentMessages[0]),
			defined(fake.sentMessages[1]),
			defined(fake.sentMessages[2]),
			defined(fake.sentMessages[3]),
		];
		expect(msg0.payload.content).toBe("a".repeat(2000));
		expect(msg1.payload.content).toBe("a".repeat(500));
		expect(msg2.payload.content).toBe("b".repeat(2000));
		expect(msg3.payload.content).toBe("b".repeat(500));

		const chunk2A = msg1.messageId;
		const chunk1B = msg2.messageId;

		await fake.sendUserMessage(userId, "Reply to A chunk 2", { replyToMessageId: chunk2A });
		await fake.sendUserMessage(userId, "Reply to B chunk 1", { replyToMessageId: chunk1B });

		expect(prompts).toEqual(["Reply to A chunk 2", "Reply to B chunk 1"]);
		conv.close();
		expect(bridge.connected).toBe(false);
	});

	it("boundary chunk with surrogate pair delivered intact through handle", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		const boundaryText = "a".repeat(1999) + "👍" + "b".repeat(500);
		await conv.send(boundaryText);

		expect(fake.sentMessages.length).toBe(2);
		const [chunk1, chunk2] = [
			defined(fake.sentMessages[0]),
			defined(fake.sentMessages[1]),
		];
		expect(chunk1.payload.content).toBe("a".repeat(1999));
		expect(chunk2.payload.content).toBe("👍" + "b".repeat(500));

		const chunk1Id = chunk1.messageId;
		const chunk2Id = chunk2.messageId;

		await fake.sendUserMessage(userId, "Prompt on chunk 1", { replyToMessageId: chunk1Id });
		await fake.sendUserMessage(userId, "Prompt on chunk 2", { replyToMessageId: chunk2Id });

		expect(prompts).toEqual(["Prompt on chunk 1", "Prompt on chunk 2"]);

		conv.close();
		expect(bridge.connected).toBe(false);
	});

	it("acquire failure releases ref and cleans up gateway", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge({
			token: "fake_tok",
			userId,
			rest: fake.rest,
			gatewayFactory: () => ({
				start: () => {
					throw new Error("Simulated gateway start failure");
				},
				stop: () => {},
			}),
		});

		await expect(bridge.openConversation(() => {})).rejects.toThrow("Simulated gateway start failure");
		expect(bridge.connected).toBe(false);
	});

	it("acquire failure rejects concurrent waiters and cleans up refs", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge({
			token: "fake_tok",
			userId,
			rest: fake.rest,
			gatewayFactory: (_token, options) => ({
				start: () => {
					queueMicrotask(() => {
						void options.onFatal(new Error("Simulated gateway start failure"));
					});
				},
				stop: () => {},
			}),
		});

		const p1 = bridge.openConversation(() => {});
		const p2 = bridge.openConversation(() => {});

		const outcomes = await Promise.allSettled([p1, p2]);
		expect(outcomes).toEqual([
			{ status: "rejected", reason: new Error("Simulated gateway start failure") },
			{ status: "rejected", reason: new Error("Simulated gateway start failure") },
		]);
		expect(bridge.connected).toBe(false);
	});

	it("outage history recovers user replies sent before bot completion during outage", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const prompts: string[] = [];
		const conv = await bridge.openConversation((text) => {
			prompts.push(text);
		});

		// 1. Initial message from bot seeds the cursor
		await conv.send("Initial prompt from bot");
		const initialBotMsg = defined(fake.sentMessages[0]);

		// 2. User replies normally while gateway is up (moves cursor to user reply)
		await fake.sendUserMessage(userId, "First reply", {
			replyToMessageId: initialBotMsg.messageId,
		});
		expect(prompts).toEqual(["First reply"]);

		// 3. Gateway goes down (disconnect/outage)
		fake.latestGateway!.stop();
		expect(fake.latestGateway!.running).toBe(false);

		// 4. User sends a message via DM while gateway is disconnected
		await fake.sendUserMessage(userId, "Missed reply during outage", {
			replyToMessageId: initialBotMsg.messageId,
		});

		// 5. Bot sends completion message via REST during outage
		// Because lastSeenMessageId is already set to user reply, bot send must NOT advance cursor
		await conv.send("Bot completion during outage");

		// 6. Gateway reconnects (READY)
		await fake.latestGateway!.emitReady();

		// 7. Reconnect catch-up must fetch after first user reply, recovering missed user reply
		expect(prompts).toEqual(["First reply", "Missed reply during outage"]);

		conv.close();
	});
});
