import { describe, expect, it } from "bun:test";
import { type AskParams } from "../src/ask-format";
import { DiscordBridge, getCurrentBridge, getBridge } from "../src/discord/bridge";
import type { GatewayMessageCreateData } from "../src/discord/gateway";
import { DiscordApiError } from "../src/discord/rest";
import { startRemoteAsk } from "../src/remote-ask";
import { createFakeDiscord, createFakeLogger, waitForBridgeOpen } from "./fake-discord";

describe("startRemoteAsk + DiscordBridge remote flow", () => {
	const userId = "user_456789";

	it("handles sequential questions: posts question 2 only after question 1 is answered", async () => {
		const fake = createFakeDiscord();
		const logger = createFakeLogger();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId, { logger }));

		const params: AskParams = {
			questions: [
				{
					id: "q1",
					question: "What beverage would you like?",
					options: [{ label: "Tea" }, { label: "Coffee" }],
				},
				{
					id: "q2",
					question: "Would you like sugar?",
					options: [{ label: "Yes" }, { label: "No" }],
				},
			],
		};

		const send1Promise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "test-project",
			onError: () => {},
		});

		// Wait deterministically for question 1 to be sent
		const sent1 = await send1Promise;
		expect(fake.sentMessages.length).toBe(1);
		expect(sent1.payload.content).toContain("What beverage would you like?");
		await waitForBridgeOpen(bridge, sent1.messageId);
		// Extract custom_id for "Coffee" (button index 1)
		const q1ActionRow = sent1.payload.components?.[0] as
			| { components?: Array<{ custom_id?: string; label?: string }> }
			| undefined;
		const coffeeCustomId = q1ActionRow?.components?.[1]?.custom_id;
		expect(coffeeCustomId).toBeDefined();

		// Answer question 1 via button click and await question 2 send
		const send2Promise = fake.waitForNextSend();
		await fake.sendUserInteraction(userId, coffeeCustomId!);
		const sent2 = await send2Promise;

		expect(fake.sentMessages.length).toBe(2);
		expect(sent2.payload.content).toContain("Would you like sugar?");
		await waitForBridgeOpen(bridge, sent2.messageId);
		// Extract custom_id for "Yes" (button index 0)
		const q2ActionRow = sent2.payload.components?.[0] as
			| { components?: Array<{ custom_id?: string; label?: string }> }
			| undefined;
		const yesCustomId = q2ActionRow?.components?.[0]?.custom_id;
		expect(yesCustomId).toBeDefined();

		// Answer question 2 via button click
		await fake.sendUserInteraction(userId, yesCustomId!);

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results).toHaveLength(2);
		expect(results?.[0]?.selectedOptions).toEqual(["Coffee"]);
		expect(results?.[1]?.selectedOptions).toEqual(["Yes"]);

		// Bridge open map is empty, and askKey was remembered
		expect(bridge.open.size).toBe(0);
		expect(bridge.closedAskKeys.length).toBe(1);
	});

	it("answers single-select question via component button click", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "lang",
					question: "Choose your preferred language",
					options: [{ label: "TypeScript" }, { label: "Rust" }, { label: "Python" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "code-project",
			onError: () => {},
		});

		const sent = await sendPromise;
		expect(fake.sentMessages.length).toBe(1);
		const msgId = sent.messageId;
		await waitForBridgeOpen(bridge, msgId);
		// Custom ID for "Rust" (button index 1)
		const actionRow = sent.payload.components?.[0] as
			| { components?: Array<{ custom_id?: string }> }
			| undefined;
		const rustCustomId = actionRow?.components?.[1]?.custom_id;
		expect(rustCustomId).toBeDefined();

		const respPromise = fake.waitForNextInteractionResponse();
		await fake.sendUserInteraction(userId, rustCustomId!);
		const resp = await respPromise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["Rust"]);

		// Interaction response type 7 was sent with answered content
		expect(fake.interactionResponses.length).toBe(1);
		expect(resp.payload?.content).toContain("✅");
		expect(resp.payload?.content).toContain("Rust");

	});

	it("answers multi-select question via component select menu", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "toppings",
					question: "Choose pizza toppings",
					multi: true,
					options: [
						{ label: "Mushrooms" },
						{ label: "Onions" },
						{ label: "Olives" },
						{ label: "Peppers" },
					],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "pizza-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		expect(fake.sentMessages.length).toBe(1);
		await waitForBridgeOpen(bridge, sent.messageId);
		// Multi-select component custom ID
		const actionRow = sent.payload.components?.[0] as
			| { components?: Array<{ custom_id?: string }> }
			| undefined;
		const selectCustomId = actionRow?.components?.[0]?.custom_id;
		expect(selectCustomId).toBeDefined();

		// Select index 0 (Mushrooms) and index 2 (Olives)
		await fake.sendUserInteraction(userId, selectCustomId!, { values: ["0", "2"] });

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["Mushrooms", "Olives"]);
	});

	it("answers question via typed explicit reference to own message", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "env",
					question: "Which environment?",
					options: [{ label: "staging" }, { label: "production" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "deploy-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const qMsgId = sent.messageId;
		await waitForBridgeOpen(bridge, qMsgId);
		const editPromise = fake.waitForNextEdit(qMsgId);
		// User replies specifically to that message with "1" (staging)
		await fake.sendUserMessage(userId, "1", { replyToMessageId: qMsgId });
		await editPromise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["staging"]);

		// Message was edited to answered content
		const edited = fake.editedMessages.find((e) => e.messageId === qMsgId);
		expect(edited?.payload.content).toContain("✅");
		expect(edited?.payload.content).toContain("staging");
	});

	it("ignores typed explicit foreign reference even if newest open is ours", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Select mode",
					options: [{ label: "Fast" }, { label: "Safe" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "mode-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const ownMsgId = sent.messageId;
		await waitForBridgeOpen(bridge, ownMsgId);
		expect(bridge.open.has(ownMsgId)).toBe(true);

		// User replies with explicit reference to a foreign message from another process
		const foreignMessageId = "9999999999999999999";
		await fake.sendUserMessage(userId, "1", { replyToMessageId: foreignMessageId });

		// Our question must NOT be stolen: it remains open
		expect(bridge.open.has(ownMsgId)).toBe(true);
		expect(fake.editedMessages.length).toBe(0);

		// Now answer our question with the correct reference
		const editPromise = fake.waitForNextEdit(ownMsgId);
		await fake.sendUserMessage(userId, "2", { replyToMessageId: ownMsgId });
		await editPromise;

		const results = await handle.result;
		expect(results?.[0]?.selectedOptions).toEqual(["Safe"]);
	});

	it("routes plain reply to newest bot question when ours, ignores when foreign", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Continue execution?",
					options: [{ label: "Yes" }, { label: "No" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "exec-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const ownMsgId = sent.messageId;
		await waitForBridgeOpen(bridge, ownMsgId);
		// Simulate another process posting a newer bot question in the same DM channel
		fake.addBotMessage(
			fake.defaultDmChannelId,
			"❓ `omp · other-project`\nAnother question?",
			{ components: [] },
		);

		// User sends plain reply "1" with no reference.
		// Bridge checks recent messages, sees newest bot ❓ is the foreign message (not in open).
		await fake.sendUserMessage(userId, "1");

		// Bridge must NOT steal the plain reply: our question remains open
		expect(bridge.open.has(ownMsgId)).toBe(true);

		// If user explicitly references our message, it answers our question
		const editPromise = fake.waitForNextEdit(ownMsgId);
		await fake.sendUserMessage(userId, "1", { replyToMessageId: ownMsgId });
		await editPromise;

		const results = await handle.result;
		expect(results?.[0]?.selectedOptions).toEqual(["Yes"]);
	});

	it("prevents duplicate answers and double resolution on multiple clicks", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "single",
					question: "Pick one",
					options: [{ label: "Option A" }, { label: "Option B" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "dup-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		await waitForBridgeOpen(bridge, sent.messageId);
		// Another in-flight ask keeps this process listening for late clicks.
		await bridge.acquire();
		const actionRow = sent.payload.components?.[0] as
			| { components?: Array<{ custom_id?: string }> }
			| undefined;
		const customId = actionRow?.components?.[0]?.custom_id;
		expect(customId).toBeDefined();

		// First click answers the question
		const resp1Promise = fake.waitForNextInteractionResponse();
		await fake.sendUserInteraction(userId, customId!);
		await resp1Promise;

		const results = await handle.result;
		expect(results?.[0]?.selectedOptions).toEqual(["Option A"]);

		// Second click arrives after answer
		const resp2Promise = fake.waitForNextInteractionResponse();
		await fake.sendUserInteraction(userId, customId!);
		const resp2 = await resp2Promise;

		// Closed askKey path responds with null ACK (type 6) without throwing
		expect(fake.interactionResponses.length).toBe(2);
		expect(resp2.payload).toBeNull();
		bridge.release();
	});

	it("cancels delayed send before timer fires", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "delayed",
					question: "Should never send",
					options: [{ label: "Never" }],
				},
			],
		};

		// 150ms delay
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 150,
			project: "delay-proj",
			onError: () => {},
		});

		// Close immediately while in delay
		handle.close("terminal");

		const result = await handle.result;
		expect(result).toBeUndefined();
		expect(fake.sentMessages.length).toBe(0);
		expect(bridge.connected).toBe(false);
	});

	it("closes in-flight question with terminal reason", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Answer in terminal",
					options: [{ label: "Opt" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "term-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const msgId = sent.messageId;

		const editPromise = fake.waitForNextEdit(msgId);
		// Close because answered in terminal
		handle.close("terminal");
		await editPromise;

		const result = await handle.result;
		expect(result).toBeUndefined();

		// Message in Discord was edited with ⌛ and "Answered in terminal."
		const edited = fake.editedMessages.filter((e) => e.messageId === msgId).at(-1);
		expect(edited?.payload.content).toContain("⌛");
		expect(edited?.payload.content).toContain("Answered in terminal.");
		expect(bridge.open.size).toBe(0);
	});

	it("closes in-flight question with cancelled reason", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Will be cancelled",
					options: [{ label: "Opt" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "cancel-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const msgId = sent.messageId;

		const editPromise = fake.waitForNextEdit(msgId);
		handle.close("cancelled");
		await editPromise;

		const result = await handle.result;
		expect(result).toBeUndefined();
		const edited = fake.editedMessages.filter((e) => e.messageId === msgId).at(-1);
		expect(edited?.payload.content).toContain("✖");
		expect(edited?.payload.content).toContain("Cancelled.");
	});

	it("resolves undefined with user-facing hint on DiscordApiError 50007", async () => {
		const fake = createFakeDiscord();
		fake.sendError = new DiscordApiError(403, 50007, "Cannot send messages to this user");
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const errors: Error[] = [];
		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Fail send",
					options: [{ label: "None" }],
				},
			],
		};

		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "err-proj",
			onError: (err) => errors.push(err),
		});

		const result = await handle.result;
		expect(result).toBeUndefined();
		expect(errors.length).toBe(1);
		expect(errors[0]?.message).toBe(
			"Discord bot cannot DM you: share a server with the bot and allow DMs from that server's members.",
		);
	});

	it("resolves undefined on gateway fatal error", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const errors: Error[] = [];
		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Waiting for answer...",
					options: [{ label: "A" }, { label: "B" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "fatal-proj",
			onError: (err) => errors.push(err),
		});

		const sent = await sendPromise;
		expect(fake.sentMessages.length).toBe(1);
		await waitForBridgeOpen(bridge, sent.messageId);
		// Emit fatal error from gateway
		await fake.latestGateway?.emitFatal(
			new Error("Discord gateway closed 4004: Authentication failed"),
		);

		const result = await handle.result;
		expect(result).toBeUndefined();
		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(errors[0]?.message).toContain("4004");
	});

	it("performs catch-up after reconnect via recent(after) oldest-first", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "q1",
					question: "Question one?",
					options: [{ label: "One" }],
				},
				{
					id: "q2",
					question: "Question two?",
					options: [{ label: "Two" }],
				},
			],
		};

		const send1Promise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "reconnect-proj",
			onError: () => {},
		});

		const sent1 = await send1Promise;
		const q1MsgId = sent1.messageId;
		await waitForBridgeOpen(bridge, q1MsgId);
		// User answers Q1 via explicit reference message
		const send2Promise = fake.waitForNextSend();
		await fake.sendUserMessage(userId, "1", { replyToMessageId: q1MsgId });

		// Q2 is posted
		const sent2 = await send2Promise;
		expect(fake.sentMessages.length).toBe(2);
		const q2MsgId = sent2.messageId;
		await waitForBridgeOpen(bridge, q2MsgId);
		// Simulate user sending answer message while gateway is reconnecting (not delivered via gateway event yet)
		const userMsg = fake.addBotMessage(
			fake.defaultDmChannelId,
			"1", // answer to Q2
			{ botUserId: userId, botUsername: "TestUser" },
		);
		// Override author bot flag to false
		userMsg.author.bot = false;
		userMsg.message_reference = { message_id: q2MsgId };

		// Gateway fires second READY (reconnect)
		const edit2Promise = fake.waitForNextEdit(q2MsgId);
		await fake.latestGateway?.emitReady();
		await edit2Promise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results).toHaveLength(2);
		expect(results?.[0]?.selectedOptions).toEqual(["One"]);
		expect(results?.[1]?.selectedOptions).toEqual(["Two"]);
	});

	it("shuts down all open questions cleanly via shutdownAll", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		await bridge.acquire();
		expect(bridge.connected).toBe(true);

		let resolvedAns: unknown = undefined;
		const oq1 = {
			askKey: "key1",
			qIndex: 0,
			question: { id: "q1", question: "Q1?", options: [{ label: "A" }] },
			content: "❓ Question 1",
			components: [],
			resolve: (ans: unknown) => {
				resolvedAns = ans;
			},
		};
		const oq2 = {
			askKey: "key2",
			qIndex: 0,
			question: { id: "q2", question: "Q2?", options: [{ label: "B" }] },
			content: "❓ Question 2",
			components: [],
			resolve: () => {},
		};

		const msg1 = await bridge.postQuestion(oq1);
		const msg2 = await bridge.postQuestion(oq2);

		expect(bridge.open.size).toBe(2);

		await bridge.shutdownAll("shutdown");

		expect(bridge.open.size).toBe(0);
		expect(bridge.connected).toBe(false);

		// Both messages edited to closed content with omp session ended
		const edited1 = fake.editedMessages.find((e) => e.messageId === msg1);
		const edited2 = fake.editedMessages.find((e) => e.messageId === msg2);
		expect(edited1?.payload.content).toContain("✖");
		expect(edited1?.payload.content).toContain("omp session ended.");
		expect(edited2?.payload.content).toContain("✖");
		expect(edited2?.payload.content).toContain("omp session ended.");

		expect(resolvedAns).toBeUndefined();
	});

	it("sets catchup cursor on first-ever posted question so typed gap reply arrives via READY", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "first_q",
					question: "First question ever?",
					options: [{ label: "Apple" }, { label: "Banana" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "cursor-seed-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const qMsgId = sent.messageId;
		await waitForBridgeOpen(bridge, qMsgId);

		// Prior to any user message in the session, simulate user typing answer "1"
		// while gateway is disconnected / reconnecting.
		const gapUserMsg = fake.addBotMessage(
			fake.defaultDmChannelId,
			"1",
			{ botUserId: userId, botUsername: "TestUser" },
		);
		gapUserMsg.author.bot = false;

		// Gateway fires READY (reconnect)
		const editPromise = fake.waitForNextEdit(qMsgId);
		await fake.latestGateway?.emitReady();
		await editPromise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["Apple"]);
		expect(bridge.open.size).toBe(0);
		await bridge.shutdownAll("shutdown");
	});

	it("never answers current question with stale reply predating question", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		// Before any active question exists, user types "1" in the DM channel (stale leftover message)
		const staleUserMsg = fake.addBotMessage(
			fake.defaultDmChannelId,
			"1",
			{ botUserId: userId, botUsername: "TestUser" },
		);
		staleUserMsg.author.bot = false;

		const params: AskParams = {
			questions: [
				{
					id: "fresh_q",
					question: "Fresh question?",
					options: [{ label: "Option A" }, { label: "Option B" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "stale-reply-proj",
			onError: () => {},
		});

		const sent = await sendPromise;
		const qMsgId = sent.messageId;
		await waitForBridgeOpen(bridge, qMsgId);

		// Verify question snowflake is newer than the stale message
		expect(BigInt(qMsgId) > BigInt(staleUserMsg.id)).toBe(true);

		// Simulate the stale message being delivered / dispatched while the fresh question is open
		await fake.latestGateway?.emitMessage({
			id: staleUserMsg.id,
			channel_id: fake.defaultDmChannelId,
			content: staleUserMsg.content,
			author: {
				id: userId,
				username: "TestUser",
				bot: false,
			},
		});

		// Stale message MUST NOT answer the question: question remains open in bridge
		expect(bridge.open.has(qMsgId)).toBe(true);
		expect(fake.editedMessages.length).toBe(0);

		// Now send a fresh valid reply sent AFTER the question was posted
		const editPromise = fake.waitForNextEdit(qMsgId);
		await fake.sendUserMessage(userId, "2");
		await editPromise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["Option B"]);
		expect(bridge.open.size).toBe(0);
		await bridge.shutdownAll("shutdown");
	});

	it("does not answer question 2 via delayed routing of reply sent before question 2 existed", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const params: AskParams = {
			questions: [
				{
					id: "q1",
					question: "Question 1?",
					options: [{ label: "Tea" }, { label: "Coffee" }],
				},
				{
					id: "q2",
					question: "Question 2?",
					options: [{ label: "Yes" }, { label: "No" }],
				},
			],
		};

		const send1Promise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "two-replies-proj",
			onError: () => {},
		});

		const sent1 = await send1Promise;
		const q1MsgId = sent1.messageId;
		await waitForBridgeOpen(bridge, q1MsgId);

		// While Q1 is being edited (answered), simulate user typing a second reply ("2")
		// BEFORE Q2 is posted by the bot.
		let reply2GwData: GatewayMessageCreateData | undefined;
		fake.onEdit = (_channelId, messageId) => {
			if (messageId === q1MsgId && !reply2GwData) {
				const msg = fake.addBotMessage(
					fake.defaultDmChannelId,
					"2",
					{ botUserId: userId, botUsername: "TestUser" },
				);
				msg.author.bot = false;
				reply2GwData = {
					id: msg.id,
					channel_id: msg.channel_id,
					content: msg.content,
					author: { id: userId, username: "TestUser", bot: false },
				};
			}
		};

		const send2Promise = fake.waitForNextSend();
		await fake.sendUserMessage(userId, "1"); // Answers Q1
		const sent2 = await send2Promise;
		const q2MsgId = sent2.messageId;
		await waitForBridgeOpen(bridge, q2MsgId);

		expect(reply2GwData).toBeDefined();
		expect(BigInt(reply2GwData!.id) < BigInt(q2MsgId)).toBe(true);

		// Deliver reply2 via delayed gateway message dispatch while Q2 is open
		await fake.latestGateway?.emitMessage(reply2GwData!);

		// Reply 2 predated Q2, so it must NOT answer Q2: Q2 remains open
		expect(bridge.open.has(q2MsgId)).toBe(true);
		expect(fake.editedMessages.filter((e) => e.messageId === q2MsgId).length).toBe(0);

		// Fresh user answer sent AFTER Q2 was posted
		const edit2Promise = fake.waitForNextEdit(q2MsgId);
		await fake.sendUserMessage(userId, "1");
		await edit2Promise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["Tea"]);
		expect(results?.[1]?.selectedOptions).toEqual(["Yes"]);
		expect(bridge.open.size).toBe(0);
		await bridge.shutdownAll("shutdown");
	});

	it("does not cancel in-flight next question when answered-message edit or stale no-op ACK fails", async () => {
		const fake = createFakeDiscord();
		const logger = createFakeLogger();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId, { logger }));

		let reportedError: Error | undefined;
		const params: AskParams = {
			questions: [
				{
					id: "q1",
					question: "Question 1?",
					options: [{ label: "One" }],
				},
				{
					id: "q2",
					question: "Question 2?",
					options: [{ label: "Two" }],
				},
			],
		};

		const send1Promise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge,
			params,
			delayMs: 0,
			project: "no-cancel-proj",
			onError: (err) => {
				reportedError = err;
			},
		});

		const sent1 = await send1Promise;
		const q1MsgId = sent1.messageId;
		await waitForBridgeOpen(bridge, q1MsgId);

		// Simulate Q1 answered-message edit failure
		fake.editError = new DiscordApiError(500, undefined, "Internal Server Error");
		const send2Promise = fake.waitForNextSend();
		await fake.sendUserMessage(userId, "1");
		fake.editError = null;

		// Q2 must be posted normally despite Q1 edit failure
		const sent2 = await send2Promise;
		const q2MsgId = sent2.messageId;
		await waitForBridgeOpen(bridge, q2MsgId);
		expect(bridge.open.has(q2MsgId)).toBe(true);
		expect(reportedError).toBeUndefined();

		// While Q2 is in flight, simulate a stale button interaction for an old closed ask
		// whose no-op ACK fails with an API error (e.g. 10062 Unknown interaction)
		bridge.rememberClosedAsk("stale_closed_key");
		fake.onRespondInteraction = () => {
			throw new DiscordApiError(404, 10062, "Unknown interaction");
		};
		await fake.sendUserInteraction(userId, "lac:stale_closed_key:0:0");
		delete fake.onRespondInteraction;

		// Stale ACK failure must NOT cancel Q2
		expect(bridge.open.has(q2MsgId)).toBe(true);
		expect(reportedError).toBeUndefined();

		// User answers Q2 successfully
		const edit2Promise = fake.waitForNextEdit(q2MsgId);
		await fake.sendUserMessage(userId, "1");
		await edit2Promise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["One"]);
		expect(results?.[1]?.selectedOptions).toEqual(["Two"]);
		expect(reportedError).toBeUndefined();
		expect(bridge.open.size).toBe(0);
		await bridge.shutdownAll("shutdown");
	});

	it("returns usable fresh bridge for same key after shutdownAll and preserves singleton isolation", async () => {
		const fake = createFakeDiscord();
		const options = fake.createBridgeOptions(userId);

		const bridge1 = getBridge(options);
		expect(bridge1).toBeDefined();
		expect(getBridge(options)).toBe(bridge1);
		expect(getCurrentBridge()).toBe(bridge1);

		// Shut down bridge1
		await bridge1.shutdownAll("shutdown");
		expect(bridge1.connected).toBe(false);
		expect(getCurrentBridge()).toBeUndefined();

		// getBridge with the same key returns a fresh, usable bridge instance
		const bridge2 = getBridge(options);
		expect(bridge2).not.toBe(bridge1);
		expect(bridge2.connected).toBe(false);
		expect(getCurrentBridge()).toBe(bridge2);

		// Verify bridge2 is fully operational in a remote ask flow
		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Fresh bridge question?",
					options: [{ label: "Confirmed" }],
				},
			],
		};

		const sendPromise = fake.waitForNextSend();
		const handle = startRemoteAsk({
			bridge: bridge2,
			params,
			delayMs: 0,
			project: "fresh-bridge-test",
			onError: () => {},
		});

		const sent = await sendPromise;
		await waitForBridgeOpen(bridge2, sent.messageId);
		expect(bridge2.connected).toBe(true);

		const editPromise = fake.waitForNextEdit(sent.messageId);
		await fake.sendUserMessage(userId, "1");
		await editPromise;

		const results = await handle.result;
		expect(results).toBeDefined();
		expect(results?.[0]?.selectedOptions).toEqual(["Confirmed"]);
		expect(bridge2.open.size).toBe(0);

		// Verify that if a replacement bridge exists, shutting down an older instance does not clear the new singleton
		const bridge3 = getBridge({ ...options, userId: "other_user_id" });
		expect(getCurrentBridge()).toBe(bridge3);
		await bridge2.shutdownAll("shutdown");
		expect(getCurrentBridge()).toBe(bridge3);

		// Clean up
		await bridge3.shutdownAll("shutdown");
		expect(getCurrentBridge()).toBeUndefined();
	});
});
