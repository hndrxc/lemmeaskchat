import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AskParams,
	MultiQuestionDetails,
	QuestionAnswer,
	SingleQuestionDetails,
} from "../src/ask-format.ts";
import { createAskExecute, raceAsk } from "../src/ask-race.ts";
import { DiscordBridge } from "../src/discord/bridge.ts";
import { DiscordApiError } from "../src/discord/rest.ts";
import type { HostContext, ToolResult, ToolUpdateCallback } from "../src/host.ts";
import {
	createFakeDiscord,
	createFakeLogger,
	waitForBridgeOpen,
	waitForCondition,
} from "./fake-discord.ts";

/**
 * Creates a fake invokeTool implementation that listens to signal.abort and
 * rejects with an AbortError if cancelled before execution settles.
 */
function createAbortableInvokeTool(
	executeFn: (
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdateCallback<any> | undefined,
	) => Promise<ToolResult>,
): NonNullable<HostContext["invokeTool"]> {
	return <TDetails, TParams>(
		_params: TParams,
		options?: { signal?: AbortSignal; onUpdate?: ToolUpdateCallback<TDetails> },
	): Promise<ToolResult<TDetails>> => {
		const signal = options?.signal;
		if (signal?.aborted) {
			const err = new Error("Ask input was cancelled");
			err.name = "AbortError";
			return Promise.reject(err);
		}

		const { promise, resolve, reject } = Promise.withResolvers<ToolResult<TDetails>>();
		let settled = false;

		const onAbort = () => {
			if (settled) return;
			settled = true;
			const err = new Error("Ask input was cancelled");
			err.name = "AbortError";
			reject(err);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		executeFn(signal, options?.onUpdate as ToolUpdateCallback<any> | undefined)
			.then((res) => {
				if (!settled) {
					settled = true;
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve(res as ToolResult<TDetails>);
				}
			})
			.catch((err) => {
				if (!settled) {
					settled = true;
					if (signal) signal.removeEventListener("abort", onAbort);
					reject(err);
				}
			});

		return promise;
	};
}

function createHangingInvokeTool(onAbortCallback?: () => void): NonNullable<HostContext["invokeTool"]> {
	return createAbortableInvokeTool((signal) => {
		const { promise } = Promise.withResolvers<ToolResult>();
		if (onAbortCallback && signal) {
			signal.addEventListener("abort", onAbortCallback, { once: true });
		}
		return promise;
	});
}

// Deliberate platform clock integration helper: exercises the exact 50ms race plan
// where native resolves at 10ms before the 50ms remote delay timer expires.
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Safe array index access helper that narrows under noUncheckedIndexedAccess.
 */
function at<T>(items: readonly T[] | undefined, index: number): T {
	const item = items?.[index];
	if (item === undefined) {
		throw new Error(`Expected array item at index ${index} to be defined`);
	}
	return item;
}

interface FakeHostContextOptions {
	cwd?: string | undefined;
	invokeTool?: HostContext["invokeTool"] | undefined;
	onNotify?: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
}

function createFakeHostContext(options: FakeHostContextOptions = {}): HostContext & {
	notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
} {
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const ui = {
		notify(message: string, type?: "info" | "warning" | "error") {
			if (type !== undefined) {
				notifications.push({ message, type });
			} else {
				notifications.push({ message });
			}
			options.onNotify?.(message, type);
		},
		setStatus(_key: string, _text: string | undefined) {},
		input: async () => undefined,
	};

	const ctx: HostContext & {
		notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
	} = {
		cwd: options.cwd ?? "/workspace/test-project",
		hasUI: true,
		agent: { kind: "main" },
		notifications,
		ui,
		...(options.invokeTool !== undefined ? { invokeTool: options.invokeTool } : {}),
	};
	return ctx;
}

describe("ask-race (step 6 approved tests a-h)", () => {
	const userId = "user_test_123456";

	it("approved (a): remote answer aborts native signal and returns exact text and details", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		let nativeSignalAborted = false;
		const invokeTool = createHangingInvokeTool(() => {
			nativeSignalAborted = true;
		});

		const params: AskParams = {
			questions: [
				{
					id: "choice",
					question: "Select option",
					options: [{ label: "A" }, { label: "B" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const racePromise = raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
		});

		// Wait for message to be sent and open in bridge
		const sent = await fake.waitForNextOpen(bridge);
		expect(sent.payload.content).toContain("Select option");

		// Send button click for option "A" (button index 0)
		const customId = `lac:${sent.openQuestion.askKey}:0:0`;
		await fake.sendUserInteraction(userId, customId);

		const result = await racePromise;

		// Native signal was aborted by remote answer
		expect(nativeSignalAborted).toBe(true);

		// Returns exact text with remote suffix
		expect(result.content).toHaveLength(1);
		expect(at(result.content, 0).type).toBe("text");
		expect(at(result.content, 0).text).toBe("User selected: A\n(Answered remotely via Discord DM.)");

		// Details reproduce native shape
		expect(result.details).toBeDefined();
		const details = result.details as SingleQuestionDetails;
		expect(details.selectedOptions).toEqual(["A"]);
		expect(details.question).toBe("Select option");
		expect(details.options).toEqual(["A", "B"]);
		expect(details.multi).toBe(false);
		expect(details.customInput).toBeUndefined();
	});

	it("approved (b): native resolves first, retains identity, edits message with ⌛, late click receives no-op ACK", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		// Retain gateway reference so gateway stays running after terminal close
		// for testing late button click handling
		await bridge.acquire();

		const nativeResult: ToolResult = {
			content: [{ type: "text", text: "User selected: Terminal Choice" }],
			details: { selectedOptions: ["Terminal Choice"] },
		};

		const { promise: nativeGate, resolve: resolveNative } = Promise.withResolvers<void>();
		const invokeTool = createAbortableInvokeTool(async () => {
			await nativeGate;
			return nativeResult;
		});

		const params: AskParams = {
			questions: [
				{
					id: "terminal_q",
					question: "Terminal question",
					options: [{ label: "Yes" }, { label: "No" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const racePromise = raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
		});

		// Wait for question to be open in bridge
		const sent = await fake.waitForNextOpen(bridge);
		const askKey = sent.openQuestion.askKey;

		// Register edit waiter before native resolves to capture the close edit
		const editPromise = fake.waitForNextEdit(sent.messageId);

		// Resolve native first
		resolveNative();

		const result = await racePromise;

		// Identity: exact native result returned unchanged
		expect(result).toBe(nativeResult);

		// Question message in Discord was edited with ⌛ closure
		const edit = await editPromise;
		expect(edit.payload.content?.startsWith("⌛")).toBe(true);
		expect(edit.payload.content).toContain("_Answered in terminal._");

		// Late interaction click arrives after close("terminal")
		const lateCustomId = `lac:${askKey}:0:0`;
		const responsePromise = fake.waitForNextInteractionResponse();
		await fake.sendUserInteraction(userId, lateCustomId);
		const ack = await responsePromise;

		// Receives no-op ACK ({ type: 6 }, payload: null in FakeDiscord)
		expect(ack.payload).toBeNull();

		bridge.release();
	});

	it("approved (c): delayMs 50 with native resolving at 10ms never sends Discord message", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const nativeResult: ToolResult = {
			content: [{ type: "text", text: "Quick terminal answer" }],
		};

		// Integration test deliberately exercising platform clock against delayMs 50ms race
		const invokeTool = createAbortableInvokeTool(async () => {
			await delay(10);
			return nativeResult;
		});

		const params: AskParams = {
			questions: [
				{
					id: "fast_q",
					question: "Fast question",
					options: [{ label: "One" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const result = await raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 50,
			project: "test-project",
		});

		expect(result).toBe(nativeResult);

		// Wait past 50ms delay window to ensure send timer was properly cleared
		await delay(60);

		// send was never called
		expect(fake.sentMessages.length).toBe(0);
	});

	it("approved (d): outer signal abort rethrows error and edits message with ✖", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const outerController = new AbortController();
		const invokeTool = createHangingInvokeTool();

		const params: AskParams = {
			questions: [
				{
					id: "cancel_q",
					question: "Question to cancel",
					options: [{ label: "Option" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const racePromise = raceAsk({
			params,
			signal: outerController.signal,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
		});

		// Wait for message to be open in bridge
		const sent = await fake.waitForNextOpen(bridge);

		// Register edit waiter before outer abort to capture the cancellation edit
		const editPromise = fake.waitForNextEdit(sent.messageId);

		// Outer abort fires (e.g. Esc in terminal)
		outerController.abort();

		// raceAsk rethrows the cancellation error
		await expect(racePromise).rejects.toThrow("Ask input was cancelled");

		// Question message in Discord was edited with ✖ closure
		const edit = await editPromise;
		expect(edit.payload.content?.startsWith("✖")).toBe(true);
		expect(edit.payload.content).toContain("_Cancelled._");
	});

	it("approved (e): foreign explicit reference is ignored and our question remains open until answered", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const invokeTool = createHangingInvokeTool();

		const params: AskParams = {
			questions: [
				{
					id: "routed_q",
					question: "Which one?",
					options: [{ label: "First" }, { label: "Second" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const racePromise = raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
		});

		const sent = await fake.waitForNextOpen(bridge);

		// User sends message referencing another process's message ID
		await fake.sendUserMessage(userId, "1", {
			replyToMessageId: "foreign_process_msg_8888",
		});

		// Explicit reference to foreign ID was ignored: our question is still open in bridge
		expect(bridge.open.has(sent.messageId)).toBe(true);

		// Now user sends reply referencing our question
		await fake.sendUserMessage(userId, "1", {
			replyToMessageId: sent.messageId,
		});

		const result = await racePromise;
		expect(at(result.content, 0).text).toContain("User selected: First");
		expect(bridge.open.has(sent.messageId)).toBe(false);
	});

	it("approved (f): plain typed reply routes to newest bot question when it belongs to us", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const invokeTool = createHangingInvokeTool();

		const params: AskParams = {
			questions: [
				{
					id: "plain_reply_q",
					question: "Pick choice",
					options: [{ label: "Alpha" }, { label: "Beta" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const racePromise = raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
		});

		const sent = await fake.waitForNextOpen(bridge);

		// User sends plain message without message_reference
		await fake.sendUserMessage(userId, "2");

		const result = await racePromise;
		expect(at(result.content, 0).text).toContain("User selected: Beta");
		expect(at(result.content, 0).text).toContain("(Answered remotely via Discord DM.)");
		expect(bridge.open.has(sent.messageId)).toBe(false);
	});

	it("approved (g): two questions are sent sequentially and question 2 is posted only after question 1 is answered", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		const invokeTool = createHangingInvokeTool();

		const params: AskParams = {
			questions: [
				{
					id: "framework",
					question: "Which framework do you prefer?",
					options: [{ label: "React" }, { label: "Vue" }],
				},
				{
					id: "language",
					question: "Which language do you prefer?",
					options: [{ label: "TypeScript" }, { label: "JavaScript" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const racePromise = raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
		});

		// Question 1 is posted
		const sent1 = await fake.waitForNextOpen(bridge);
		expect(sent1.payload.content).toContain("Which framework do you prefer?");
		expect(fake.sentMessages.length).toBe(1);

		// Subscribe to question 2 open before answering question 1
		const q2OpenPromise = fake.waitForNextOpen(bridge);

		// Answer question 1 with option "React" (index 0)
		const q1CustomId = `lac:${sent1.openQuestion.askKey}:0:0`;
		await fake.sendUserInteraction(userId, q1CustomId);

		// Question 2 is now posted
		const sent2 = await q2OpenPromise;
		expect(sent2.payload.content).toContain("Which language do you prefer?");
		expect(fake.sentMessages.length).toBe(2);

		// Answer question 2 with option "TypeScript" (index 0)
		const q2CustomId = `lac:${sent2.openQuestion.askKey}:1:0`;
		await fake.sendUserInteraction(userId, q2CustomId);

		const result = await racePromise;

		// Formatted output contains both answers and remote suffix
		expect(at(result.content, 0).text).toContain("framework: React");
		expect(at(result.content, 0).text).toContain("language: TypeScript");
		expect(at(result.content, 0).text).toContain("(Answered remotely via Discord DM.)");

		const details = result.details as MultiQuestionDetails;
		expect(details.results).toHaveLength(2);
		expect(at(details.results, 0).selectedOptions).toEqual(["React"]);
		expect(at(details.results, 1).selectedOptions).toEqual(["TypeScript"]);
	});

	it("approved (h): 50007 send failure passes hint to onError while native result is retained", async () => {
		const fake = createFakeDiscord();
		const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

		// Inject Discord API error 50007 (Cannot send messages to this user)
		fake.sendError = new DiscordApiError(403, 50007, "Cannot send messages to this user");

		const nativeResult: ToolResult = {
			content: [{ type: "text", text: "Native fallback answer" }],
			details: { selectedOptions: ["Native fallback answer"] },
		};

		const { promise: errorHandledPromise, resolve: resolveErrorHandled } =
			Promise.withResolvers<void>();

		const invokeTool = createAbortableInvokeTool(async () => {
			await errorHandledPromise;
			return nativeResult;
		});

		let capturedError: Error | undefined;
		const params: AskParams = {
			questions: [
				{
					id: "hint_q",
					question: "Question with hint error",
					options: [{ label: "Choice" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool });
		const result = await raceAsk({
			params,
			ctx,
			bridge,
			delayMs: 0,
			project: "test-project",
			onError: (err) => {
				capturedError = err;
				resolveErrorHandled();
			},
		});

		// Native result is retained
		expect(result).toBe(nativeResult);

		// onError receives the friendly server-sharing hint
		expect(capturedError).toBeDefined();
		expect(capturedError?.message).toBe(
			"Discord bot cannot DM you: share a server with the bot and allow DMs from that server's members.",
		);
	});

	it("createAskExecute: throws when ctx.invokeTool is absent", async () => {
		const logger = createFakeLogger();
		const execute = createAskExecute({ agentDir: "/tmp/fake-dir", logger });

		const params: AskParams = {
			questions: [
				{
					id: "q",
					question: "Test question",
					options: [{ label: "A" }],
				},
			],
		};

		const ctx = createFakeHostContext({ invokeTool: undefined });
		await expect(
			execute("tool_call_1", params, undefined, undefined, ctx),
		).rejects.toThrow("lemmeaskchat: native ask tool unavailable for delegation");
	});

	it("createAskExecute: unconfigured delegates directly to native invokeTool without bridge", async () => {
		const logger = createFakeLogger();
		const emptyAgentDir = mkdtempSync(join(tmpdir(), "omp-unconfigured-"));

		try {
			const execute = createAskExecute({ agentDir: emptyAgentDir, logger });

			const nativeResult: ToolResult = {
				content: [{ type: "text", text: "Direct native answer" }],
			};

			let invokeToolCalled = false;
			const invokeTool = createAbortableInvokeTool(async () => {
				invokeToolCalled = true;
				return nativeResult;
			});

			const params: AskParams = {
				questions: [
					{
						id: "q",
						question: "Test question",
						options: [{ label: "A" }],
					},
				],
			};

			const ctx = createFakeHostContext({ invokeTool });
			const result = await execute("tool_call_2", params, undefined, undefined, ctx);

			expect(invokeToolCalled).toBe(true);
			expect(result).toBe(nativeResult);
		} finally {
			rmSync(emptyAgentDir, { recursive: true, force: true });
		}
	});

	it("createAskExecute: configured away delegates to raceAsk and notifies UI on error", async () => {
		const logger = createFakeLogger();
		const configuredAgentDir = mkdtempSync(join(tmpdir(), "omp-configured-"));

		try {
			const configDir = join(configuredAgentDir, "lemmeaskchat");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify({
					discordBotToken: "test_bot_token",
					discordUserId: userId,
					away: true,
					delaySeconds: 0,
				}),
			);

			const fake = createFakeDiscord();
			fake.sendError = new DiscordApiError(403, 50007, "Cannot send messages to this user");
			const bridge = new DiscordBridge(fake.createBridgeOptions(userId));

			const execute = createAskExecute({
				agentDir: configuredAgentDir,
				logger,
				bridgeFactory: () => bridge,
			});

			const nativeResult: ToolResult = {
				content: [{ type: "text", text: "Native answer under configured away" }],
			};

			const { promise: notifyReceivedPromise, resolve: resolveNotifyReceived } =
				Promise.withResolvers<void>();

			const invokeTool = createAbortableInvokeTool(async () => {
				await notifyReceivedPromise;
				return nativeResult;
			});

			const params: AskParams = {
				questions: [
					{
						id: "q",
						question: "Test question",
						options: [{ label: "A" }],
					},
				],
			};

			const ctx = createFakeHostContext({
				invokeTool,
				onNotify: () => {
					resolveNotifyReceived();
				},
			});

			const result = await execute("tool_call_3", params, undefined, undefined, ctx);

			expect(result).toBe(nativeResult);
			expect(ctx.notifications).toHaveLength(1);
			expect(at(ctx.notifications, 0).type).toBe("warning");
			expect(at(ctx.notifications, 0).message).toContain(
				"Discord bot cannot DM you: share a server with the bot and allow DMs from that server's members.",
			);
		} finally {
			rmSync(configuredAgentDir, { recursive: true, force: true });
		}
	});
});
