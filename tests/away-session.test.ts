import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AwaySessionController,
	extractAssistantText,
	formatSessionName,
	type BridgeLike,
	type TimerFactory,
} from "../src/away-session.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import type { DiscordConversation } from "../src/discord/bridge.ts";
import type {
	HostApi,
	HostContext,
	HostLogger,
	HostSendUserMessageOptions,
	HostToolDefinition,
	ToolInfoLite,
} from "../src/host.ts";

class TestClock implements TimerFactory {
	private now = 0;
	private nextId = 1;
	private timers = new Map<number, { due: number; callback: () => void }>();

	setTimeout(callback: () => void, ms: number): number {
		const id = this.nextId++;
		this.timers.set(id, { due: this.now + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") {
			this.timers.delete(handle);
		}
	}

	tick(ms: number): void {
		this.now += ms;
		let ranAny = true;
		while (ranAny) {
			ranAny = false;
			let earliestId: number | undefined;
			let earliestDue = Number.POSITIVE_INFINITY;
			for (const [id, t] of this.timers.entries()) {
				if (t.due <= this.now && t.due < earliestDue) {
					earliestDue = t.due;
					earliestId = id;
				}
			}
			if (earliestId !== undefined) {
				const t = this.timers.get(earliestId);
				if (t) {
					this.timers.delete(earliestId);
					t.callback();
					ranAny = true;
				}
			}
		}
	}

	get activeTimerCount(): number {
		return this.timers.size;
	}

	clear(): void {
		this.timers.clear();
	}
}

class MockDiscordConversation implements DiscordConversation {
	public sent: string[] = [];
	public closed = false;
	public sendGate?: Promise<void> | undefined;

	constructor(
		private readonly bridge: MockDiscordBridge,
		public readonly onPrompt: (text: string) => void,
	) {}

	async send(content: string): Promise<void> {
		if (this.closed) {
			throw new Error("Cannot send: conversation is closed");
		}
		this.sent.push(content);
		if (this.sendGate) {
			await this.sendGate;
		}
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.bridge.closedConversations.push(this);
			if (this.bridge.activeConversation === this) {
				this.bridge.activeConversation = undefined;
			}
		}
	}
}

class MockDiscordBridge implements BridgeLike {
	public activeConversation: MockDiscordConversation | undefined = undefined;
	public closedConversations: MockDiscordConversation[] = [];
	public errorHandlers = new Set<(err: Error) => void>();
	public openConversationCount = 0;
	public openGate?: Promise<void> | undefined;

	async openConversation(onPrompt: (text: string) => void): Promise<DiscordConversation> {
		this.openConversationCount++;
		if (this.openGate) {
			await this.openGate;
		}
		const conv = new MockDiscordConversation(this, onPrompt);
		this.activeConversation = conv;
		return conv;
	}

	onError(callback: (error: Error) => void): () => void {
		this.errorHandlers.add(callback);
		return () => {
			this.errorHandlers.delete(callback);
		};
	}

	emitError(err: Error): void {
		for (const handler of this.errorHandlers) {
			handler(err);
		}
	}
}

interface TestHarness {
	clock: TestClock;
	bridge: MockDiscordBridge;
	agentDir: string;
	pi: HostApi;
	ctx: HostContext & {
		notifications: Array<{ message: string; type?: string }>;
		statuses: Map<string, string | undefined>;
		sentUserMessages: Array<{ text: string; options?: HostSendUserMessageOptions }>;
		idle: boolean;
		pendingMessages: boolean;
		runningJobs: unknown[];
	};
	sessionName?: string | undefined;
	sessionId: string;
}

function createHarness(): TestHarness {
	const clock = new TestClock();
	const bridge = new MockDiscordBridge();
	const agentDir = mkdtempSync(join(tmpdir(), "away-test-"));

	let sessionName: string | undefined;
	let sessionId = "abc12345-6789-test";

	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const sentUserMessages: Array<{ text: string; options?: HostSendUserMessageOptions }> = [];

	const ctx: HostContext & {
		notifications: Array<{ message: string; type?: string }>;
		statuses: Map<string, string | undefined>;
		sentUserMessages: Array<{ text: string; options?: HostSendUserMessageOptions }>;
		idle: boolean;
		pendingMessages: boolean;
		runningJobs: unknown[];
	} = {
		notifications,
		statuses,
		sentUserMessages,
		idle: true,
		pendingMessages: false,
		runningJobs: [],
		hasUI: true,
		cwd: "/home/carter/projects/my-repo",
		agent: { kind: "main" },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => sessionName,
		},
		isIdle: () => ctx.idle,
		hasPendingMessages: () => ctx.pendingMessages,
		getAsyncJobSnapshot: () => ({ running: ctx.runningJobs }),
		ui: {
			notify(message: string, type?: "info" | "warning" | "error") {
				notifications.push(type !== undefined ? { message, type } : { message });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
			async input() {
				return undefined;
			},
		},
	};

	const logger: HostLogger = {
		warn: () => {},
		debug: () => {},
		info: () => {},
		error: () => {},
	};

	const pi: HostApi = {
		on: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		getAllTools: () => [],
		logger,
		getSessionName: () => sessionName,
		sendUserMessage: (content: string, options?: HostSendUserMessageOptions) => {
			sentUserMessages.push(options !== undefined ? { text: content, options } : { text: content });
		},
		pi: {
			getAgentDir: () => agentDir,
		},
	};

	return {
		clock,
		bridge,
		agentDir,
		pi,
		ctx,
		get sessionName() {
			return sessionName;
		},
		set sessionName(val: string | undefined) {
			sessionName = val;
		},
		get sessionId() {
			return sessionId;
		},
		set sessionId(val: string) {
			sessionId = val;
		},
	};
}

describe("AwaySessionController lifecycle & conversations", () => {
	let h: TestHarness;
	const createdDirs: string[] = [];

	beforeEach(() => {
		h = createHarness();
		createdDirs.push(h.agentDir);
		saveConfig(h.agentDir, {
			discordBotToken: "test-bot-token-1234",
			discordUserId: "test-user-id-5678",
			awayTimeoutSeconds: 900,
		});
	});

	afterEach(() => {
		h.clock.clear();
		for (const dir of createdDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup error
			}
		}
	});

	describe("repeated completion-reply loop", () => {
		it("maintains conversation through multiple turns and quote replies", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(controller.isAway).toBe(true);
			expect(h.bridge.openConversationCount).toBe(1);
			expect(h.bridge.activeConversation?.sent).toEqual([
				"Session “my-repo (abc12345)” is now away — awaiting response.",
			]);

			// Turn 1 starts
			controller.onAgentStart();
			expect(controller.isBusy()).toBe(true);

			// Turn 1 completes
			await controller.onAgentEnd({
				messages: [
					{ role: "user", content: "Tell me a joke" },
					{ role: "assistant", content: "Why did the chicken cross the road?" },
				],
			});

			expect(h.bridge.activeConversation?.sent.length).toBe(2);
			expect(h.bridge.activeConversation?.sent[1]).toBe(
				"Session “my-repo (abc12345)” has finished — awaiting response.\n\nWhy did the chicken cross the road?",
			);

			// User replies from Discord DM (quote reply)
			const conv = h.bridge.activeConversation!;
			conv.onPrompt("To get to the other side!");

			// Prompt accepted: delivered to host runner
			expect(h.ctx.sentUserMessages.length).toBe(1);
			expect(h.ctx.sentUserMessages[0]).toEqual({
				text: "To get to the other side!",
			});

			// Turn 2 starts: new model prompt start cancels expiry while running
			controller.onAgentStart();
			expect(controller.isBusy()).toBe(true);
			h.clock.tick(1_000_000);
			expect(controller.isAway).toBe(true);
			// Turn 2 completes
			await controller.onAgentEnd({
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Classic answer!" }],
					},
				],
			});

			expect(h.bridge.activeConversation?.sent.length).toBe(3);
			expect(h.bridge.activeConversation?.sent[2]).toBe(
				"Session “my-repo (abc12345)” has finished — awaiting response.\n\nClassic answer!",
			);

			// User replies while task is busy
			controller.onAgentStart();
			conv.onPrompt("Another question while busy");
			expect(h.ctx.sentUserMessages.length).toBe(2);
			expect(h.ctx.sentUserMessages[1]).toEqual({
				text: "Another question while busy",
				options: { deliverAs: "followUp" },
			});
		});
	});

	describe("current session name and fallback formatting", () => {
		it("uses explicit session name when available and updates on rename", async () => {
			h.sessionName = "Feature Implementation";
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(h.bridge.activeConversation?.sent[0]).toBe(
				"Session “Feature Implementation” is now away — awaiting response.",
			);

			// Rename session between turns
			h.sessionName = "Refactored Feature";

			controller.onAgentStart();
			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Done refactoring." }],
			});

			expect(h.bridge.activeConversation?.sent[1]).toBe(
				"Session “Refactored Feature” has finished — awaiting response.\n\nDone refactoring.",
			);
		});

		it("falls back to repository basename and short session id", async () => {
			h.sessionName = undefined;
			h.sessionId = "7f8e9d0c-1122-3344";
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(h.bridge.activeConversation?.sent[0]).toBe(
				"Session “my-repo (7f8e9d0c)” is now away — awaiting response.",
			);
		});

		it("handles short session ids gracefully", () => {
			const name = formatSessionName(h.pi, {
				...h.ctx,
				sessionManager: { getSessionId: () => "tiny" },
			});
			expect(name).toBe("my-repo (tiny)");
		});
	});

	describe("delayed agent_end idle transition", () => {
		it("schedules bounded post-settle checks when host isIdle reports false at agent_end", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);

			// Simulate host runner unwinding: ctx.isIdle() is false at agent_end
			controller.onAgentStart();
			h.ctx.idle = false;

			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Result" }],
			});

			// Announcement sent, but idle check scheduled, not final 900s timer
			expect(h.bridge.activeConversation?.sent.length).toBe(2);

			// Runner settles after 50ms
			h.ctx.idle = true;
			h.clock.tick(50);

			// Now idle timer is armed for 900s
			expect(controller.isAway).toBe(true);

			// Advancing 900s triggers idle expiration
			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
			expect(loadConfig(h.agentDir).away).toBe(false);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(h.ctx.notifications.some((n) => n.message.includes("expired"))).toBe(true);
		});
	});

	describe("active run beyond timeout", () => {
		it("never times out while an agent run is actively executing", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			controller.onAgentStart();

			// Run continues for 2000s (> 900s timeout)
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);
			expect(h.bridge.activeConversation?.closed).toBe(false);

			// When run completes, timer arms fresh
			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Long task completed" }],
			});

			expect(controller.isAway).toBe(true);
			h.clock.tick(899_000);
			expect(controller.isAway).toBe(true);
			h.clock.tick(2_000);
			expect(controller.isAway).toBe(false);
		});
	});

	describe("activity suppression: pending asks, jobs, queued followups, and continuations", () => {
		it("suppresses timer while ask tool is active", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			controller.setAskActive(true);
			expect(controller.isBusy()).toBe(true);

			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Asking question..." }],
			});

			// Advance beyond configured idle duration while ask is active: mode remains enabled
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);

			// Ask completes, activity settles
			controller.setAskActive(false);
			expect(controller.isBusy()).toBe(false);

			// Settle check fires, arms full idle window, then expires
			h.clock.tick(1_000);
			expect(controller.isAway).toBe(true);
			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
		});

		it("suppresses timer when context has pending messages", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			h.ctx.pendingMessages = true;

			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Batch 1" }],
			});

			// Advance beyond configured idle duration while messages pending: mode remains enabled
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);

			// Pending messages settle
			h.ctx.pendingMessages = false;

			// Settle check fires, arms full idle window, then expires
			h.clock.tick(1_000);
			expect(controller.isAway).toBe(true);
			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
		});

		it("sends final text but suppresses timer when background async jobs are running", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			h.ctx.runningJobs = [{ id: "job-1", status: "running" }];

			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Started background job" }],
			});

			// Final event with suppressed non-waking background job still sends final text
			expect(h.bridge.activeConversation?.sent.length).toBe(2);
			expect(h.bridge.activeConversation?.sent[1]).toContain("Started background job");

			// Expiry waits until all background jobs finish
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);

			// Background jobs complete, runner becomes idle, full idle window begins
			h.ctx.runningJobs = [];
			h.clock.tick(1_000);
			expect(controller.isAway).toBe(true);

			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
		});

		it("skips completion and timer when willContinue or awaitingAsyncWork is true until final completion", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);

			await controller.onAgentEnd({
				willContinue: true,
				messages: [{ role: "assistant", content: "Partial result" }],
			});
			expect(h.bridge.activeConversation?.sent.length).toBe(1);

			// Advance beyond configured idle duration while continuation is pending: mode remains enabled
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);

			await controller.onAgentEnd({
				awaitingAsyncWork: true,
				messages: [{ role: "assistant", content: "Waiting result" }],
			});
			expect(h.bridge.activeConversation?.sent.length).toBe(1);

			// Mode still remains enabled beyond idle duration
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);

			// Next final completion delivers output and starts the normal idle expiration window
			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Final result" }],
			});
			expect(h.bridge.activeConversation?.sent.length).toBe(2);
			expect(h.bridge.activeConversation?.sent[1]).toContain("Final result");

			// Idle window expires after full duration
			h.clock.tick(899_000);
			expect(controller.isAway).toBe(true);
			h.clock.tick(2_000);
			expect(controller.isAway).toBe(false);
		});
	});

	describe("output delivery delay and cancellation races", () => {
		it("does not arm timer if new run starts while completion delivery is in flight", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			const conv = h.bridge.activeConversation!;

			// Hook send to simulate delay using Promise.withResolvers
			const { promise: sendGate, resolve: releaseSend } = Promise.withResolvers<void>();
			conv.sendGate = sendGate;

			const endPromise = controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Delayed send" }],
			});

			// While send is pending, a new agent run starts
			controller.onAgentStart();

			// Resolve the send
			releaseSend();
			await endPromise;

			// Because new run started during send, idle timer is NOT armed; expiry suppressed while running
			h.clock.tick(2_000_000);
			expect(controller.isAway).toBe(true);
		});

		it("closes conversation immediately if turned off while openConversation is in flight", async () => {
			const { promise: openGate, resolve: releaseOpen } = Promise.withResolvers<void>();
			h.bridge.openGate = openGate;
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			const setAwayPromise = controller.setAway(true, h.ctx);
			// Immediately turn off before open completes
			await controller.setAway(false, h.ctx);
			releaseOpen();
			await setAwayPromise;
			expect(controller.isAway).toBe(false);
			expect(h.bridge.closedConversations.length).toBe(1);
		});

		it("turning off or expiring away mode never aborts the model run", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			controller.onAgentStart();

			// Turn off away mode mid-run
			await controller.setAway(false, h.ctx);
			expect(controller.isAway).toBe(false);
			expect(controller.activeConversation).toBeUndefined();

			// Agent finishes cleanly without error
			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Completed without abort" }],
			});
		});
	});

	describe("session switch", () => {
		it("invalidates old conversation and opens new conversation on switch", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			const firstConv = h.bridge.activeConversation!;

			// Switch session
			h.sessionId = "new-session-9999";
			h.sessionName = "Switched Branch Session";
			await controller.onSessionSwitch(h.ctx);

			expect(firstConv.closed).toBe(true);
			expect(h.bridge.activeConversation).not.toBe(firstConv);
			expect(h.bridge.activeConversation?.sent[0]).toBe(
				"Session “Switched Branch Session” is now away — awaiting response.",
			);
		});
	});

	describe("configuration and bridge fatal errors", () => {
		it("fails cleanly when activating away mode without credentials", async () => {
			saveConfig(h.agentDir, {
				discordBotToken: "",
				discordUserId: "",
			});

			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(controller.isAway).toBe(false);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(h.ctx.notifications.some((n) => n.message.includes("not configured"))).toBe(true);
		});

		it("disables away mode and cleans up when bridge reports fatal error", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(controller.isAway).toBe(true);

			// Bridge encounters fatal 4004 (invalid token)
			h.bridge.emitError(new Error("4004 Authentication Failed"));

			expect(controller.isAway).toBe(false);
			expect(controller.activeConversation).toBeUndefined();
			expect(loadConfig(h.agentDir).away).toBe(false);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(
				h.ctx.notifications.some(
					(n) => n.message.includes("4004") && n.type === "error",
				),
			).toBe(true);
		});
	});

	describe("timeout configuration changes", () => {
		it("re-arms active idle timer when timeout duration changes", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);

			// Advance 200s
			h.clock.tick(200_000);
			expect(controller.isAway).toBe(true);

			// User updates timeout to 300s
			saveConfig(h.agentDir, { awayTimeoutSeconds: 300 });
			controller.resetTimeout();

			// 299s -> still away
			h.clock.tick(299_000);
			expect(controller.isAway).toBe(true);

			// 2s more -> 301s -> expires
			h.clock.tick(2_000);
			expect(controller.isAway).toBe(false);
		});
	});

	describe("subagent and headless session exclusion", () => {
		it("ignores subagents for all lifecycle events", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			const subCtx: HostContext = {
				...h.ctx,
				agent: { kind: "sub" },
			};

			saveConfig(h.agentDir, { away: true });
			await controller.onSessionStart(subCtx);
			expect(controller.isAway).toBe(false);

			await controller.onSessionSwitch(subCtx);
			expect(controller.isAway).toBe(false);

			controller.onSessionShutdown(subCtx);
			expect(controller.isAway).toBe(false);
		});

		it("ignores sessions without UI", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			const noUiCtx: HostContext = {
				...h.ctx,
				hasUI: false,
			};

			saveConfig(h.agentDir, { away: true });
			await controller.onSessionStart(noUiCtx);
			expect(controller.isAway).toBe(false);
		});
	});

	describe("activation generation resilience across model start and stale rejections", () => {
		it("survives agent starts during pending openConversation and sends eventual completion", async () => {
			const { promise: openGate, resolve: releaseOpen } = Promise.withResolvers<void>();
			h.bridge.openGate = openGate;

			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			const setAwayPromise = controller.setAway(true, h.ctx);

			// Model starts while openConversation is still pending in bridge
			controller.onAgentStart();
			expect(controller.isBusy()).toBe(true);

			// Bridge completes opening conversation
			releaseOpen();
			await setAwayPromise;

			// Controller must remain away and connected
			expect(controller.isAway).toBe(true);
			expect(controller.activeConversation).toBeDefined();
			// Since model was running when activation connected, sent running announcement
			expect(h.bridge.activeConversation?.sent).toEqual([
				"Session “my-repo (abc12345)” is now away (task running).",
			]);

			// Model completes
			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Eventual completion result" }],
			});

			// Completion notification sent to conversation
			expect(h.bridge.activeConversation?.sent.length).toBe(2);
			expect(h.bridge.activeConversation?.sent[1]).toContain("Eventual completion result");

			// Idle timer armed for 900s
			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
		});

		it("does not allow stale rejected openConversation to disable a newer activation", async () => {
			const { promise: failGate, reject: rejectOpen } = Promise.withResolvers<void>();
			let attempt = 0;
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => {
					attempt++;
					if (attempt === 1) {
						return {
							...h.bridge,
							openConversation: async () => {
								await failGate;
								throw new Error("Bridge connection timeout");
							},
						};
					}
					return h.bridge;
				},
				timerFactory: h.clock,
			});

			// Activation 1 begins and hangs
			const firstSetAwayPromise = controller.setAway(true, h.ctx);

			// User turns off then on again before activation 1 resolves
			await controller.setAway(false, h.ctx);
			const secondSetAwayPromise = controller.setAway(true, h.ctx);
			await secondSetAwayPromise;
			expect(controller.isAway).toBe(true);

			// Now activation 1 fails late
			rejectOpen(new Error("Bridge connection timeout"));
			try {
				await firstSetAwayPromise;
			} catch {
				// Old promise rejected
			}

			// New activation MUST remain active; stale catch must not set away = false or wipe status
			expect(controller.isAway).toBe(true);
			expect(loadConfig(h.agentDir).away).toBe(true);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBe("away → Discord");
		});

		it("does not allow stale rejected openConversation to disable active session on switch", async () => {
			const { promise: failGate, reject: rejectOpen } = Promise.withResolvers<void>();
			let attempt = 0;
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => {
					attempt++;
					if (attempt === 1) {
						return {
							...h.bridge,
							openConversation: async () => {
								await failGate;
								throw new Error("Stale open error");
							},
						};
					}
					return h.bridge;
				},
				timerFactory: h.clock,
			});

			// Activation 1 in session A
			const firstPromise = controller.setAway(true, h.ctx);

			// Switch to session B while open is pending
			h.sessionId = "session-b-9999";
			await controller.onSessionSwitch(h.ctx);
			expect(controller.isAway).toBe(true);

			// Stale open in session A rejects
			rejectOpen(new Error("Stale open error"));
			try {
				await firstPromise;
			} catch {
				// expected
			}

			// Controller must remain away in session B
			expect(controller.isAway).toBe(true);
			expect(loadConfig(h.agentDir).away).toBe(true);
		});
	});

	describe("extended settle backoff and busy idle recovery", () => {
		it("continues settle checks beyond 6 attempts and arms idle window once idle", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);

			controller.onAgentStart();
			h.ctx.idle = false;

			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Result" }],
			});

			// Simulate runner unwinding taking > 6 checks
			// Checks 0..5 (6 attempts) at 50ms = 300ms
			for (let i = 0; i < 6; i++) {
				h.clock.tick(50);
				expect(controller.isAway).toBe(true);
			}

			// Host still not idle after 6 attempts
			expect(h.ctx.idle).toBe(false);

			// Backoff checks continue: 100ms, 200ms
			h.clock.tick(100);
			h.clock.tick(200);
			expect(controller.isAway).toBe(true);

			// Now host runner settles and becomes idle
			h.ctx.idle = true;
			// Tick next backoff interval (up to capped 1000ms)
			h.clock.tick(1000);

			// Settle check has now armed the full 900s idle timer
			expect(controller.isAway).toBe(true);

			// 899s -> still away
			h.clock.tick(899_000);
			expect(controller.isAway).toBe(true);

			// 2s more -> 901s -> expires
			h.clock.tick(2_000);
			expect(controller.isAway).toBe(false);
			expect(loadConfig(h.agentDir).away).toBe(false);
		});

		it("does not permanently discard idle timer when firing while busy with background job, recovering once idle", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(controller.isAway).toBe(true);

			// After 890s, a background async job starts
			h.clock.tick(890_000);
			h.ctx.runningJobs = [{ id: "bg-task", status: "running" }];

			// Idle timeout fires at 900s while busy with background job
			h.clock.tick(10_000);
			// Away mode must NOT expire
			expect(controller.isAway).toBe(true);

			// Background job continues for another 500s
			h.clock.tick(500_000);
			expect(controller.isAway).toBe(true);

			// Background job finishes
			h.ctx.runningJobs = [];

			// Post-busy settle check detects runner is now idle and arms full idle window
			h.clock.tick(1_000);
			expect(controller.isAway).toBe(true);

			// Advances full 900s window after recovery
			h.clock.tick(899_000);
			expect(controller.isAway).toBe(true);
			h.clock.tick(2_000);
			expect(controller.isAway).toBe(false);
		});
	});

	describe("prompt handling and runtime method availability", () => {
		it("times out if prompt is accepted while idle but no subsequent agent_start occurs", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			const conv = h.bridge.activeConversation!;

			// Prompt arrives from user
			conv.onPrompt("Do some work");
			expect(h.ctx.sentUserMessages.length).toBe(1);

			// Host runner does NOT call onAgentStart (e.g. prompt queued or no run starts)
			// Arranged future idle check must ensure timeout still fires
			h.clock.tick(1_000);
			expect(controller.isAway).toBe(true);

			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
			expect(loadConfig(h.agentDir).away).toBe(false);
		});

		it("explicitly disables away mode and notifies error if sendUserMessage is unavailable", async () => {
			const piWithoutSend: HostApi = {
				...h.pi,
			};
			delete piWithoutSend.sendUserMessage;

			const controller = new AwaySessionController(piWithoutSend, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			expect(controller.isAway).toBe(true);

			const conv = h.bridge.activeConversation!;
			conv.onPrompt("Hello");

			// Must not silently ignore: fails closed, disables away mode, notifies error
			expect(controller.isAway).toBe(false);
			expect(controller.activeConversation).toBeUndefined();
			expect(loadConfig(h.agentDir).away).toBe(false);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(
				h.ctx.notifications.some(
					(n) => n.type === "error" && n.message.toLowerCase().includes("sendusermessage"),
				),
			).toBe(true);
		});
	});

	describe("latest assistant only in completion message", () => {
		it("does not quote prior intermediate assistant text when latest assistant is empty or thinking-only", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			controller.onAgentStart();

			await controller.onAgentEnd({
				messages: [
					{ role: "user", content: "Inspect database" },
					{ role: "assistant", content: "I am going to check the DB schema." },
					{ role: "tool", content: "table users (id int, name text)" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", text: "Analyzing columns..." },
							{ type: "tool_use", name: "query" },
						],
					},
				],
			});

			expect(h.bridge.activeConversation?.sent.length).toBe(2);
			const completion = h.bridge.activeConversation?.sent[1];
			// Must NOT contain the intermediate message "I am going to check the DB schema."
			expect(completion).not.toContain("I am going to check the DB schema.");
			expect(completion).toBe("Session “my-repo (abc12345)” has finished — awaiting response.");
		});
	});

	describe("completion delivery failure handling", () => {
		it("fails closed and disables away mode cleanly when completion send fails", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			const conv = h.bridge.activeConversation!;

			// Make send fail on completion
			conv.send = async () => {
				throw new Error("Discord API 500: Internal Server Error");
			};

			controller.onAgentStart();
			await controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Finished job" }],
			});

			// Must fail closed: away mode disabled, conversation closed, error notified
			expect(controller.isAway).toBe(false);
			expect(controller.activeConversation).toBeUndefined();
			expect(loadConfig(h.agentDir).away).toBe(false);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBeUndefined();
			expect(
				h.ctx.notifications.some(
					(n) => n.type === "error" && n.message.includes("500"),
				),
			).toBe(true);
		});

		it("does not allow stale failed completion delivery to disable a newer activation", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);
			const firstConv = h.bridge.activeConversation!;

			// Hook send to hang then reject
			const { promise: failGate, reject: releaseFail } = Promise.withResolvers<void>();
			firstConv.sendGate = failGate;

			controller.onAgentStart();
			const endPromise = controller.onAgentEnd({
				messages: [{ role: "assistant", content: "Turn 1" }],
			});

			// Switch to a new session before send finishes
			h.sessionId = "new-active-session";
			await controller.onSessionSwitch(h.ctx);
			expect(controller.isAway).toBe(true);

			// Now the slow send from old activation fails
			releaseFail(new Error("Network timeout during send"));
			try {
				await endPromise;
			} catch {
				// expected
			}

			// Newer activation MUST NOT be disabled by stale delivery error
			expect(controller.isAway).toBe(true);
			expect(loadConfig(h.agentDir).away).toBe(true);
			expect(h.ctx.statuses.get("lemmeaskchat")).toBe("away → Discord");
		});
	});

	describe("session switch state isolation", () => {
		it("resets old session running and ask flags on session switch to prevent carrying busy state into new idle session", async () => {
			const controller = new AwaySessionController(h.pi, {
				bridgeFactory: () => h.bridge,
				timerFactory: h.clock,
			});

			await controller.setAway(true, h.ctx);

			// Old session was running and ask was active
			controller.onAgentStart();
			controller.setAskActive(true);
			expect(controller.isBusy()).toBe(true);

			// Switch session to a new idle session
			h.sessionId = "switched-clean-session";
			await controller.onSessionSwitch(h.ctx);

			// In new session, busy state from old session is reset
			expect(controller.isBusy()).toBe(false);

			// New session arms idle timer
			h.clock.tick(900_000);
			expect(controller.isAway).toBe(false);
		});
	});

	describe("extractAssistantText helper", () => {
		it("extracts text string from latest assistant message", () => {
			const text = extractAssistantText([
				{ role: "user", content: "Question" },
				{ role: "assistant", content: "Direct string response" },
			]);
			expect(text).toBe("Direct string response");
		});

		it("extracts text blocks and skips thinking or tool use blocks", () => {
			const text = extractAssistantText([
				{
					role: "assistant",
					content: [
						{ type: "thinking", text: "Thinking about it..." },
						{ type: "text", text: "Here is the " },
						{ type: "tool_use", name: "bash" },
						{ type: "text", text: "solution." },
					],
				},
			]);
			expect(text).toBe("Here is the solution.");
		});

		it("returns empty string when no assistant text found", () => {
			expect(extractAssistantText([])).toBe("");
			expect(extractAssistantText(undefined)).toBe("");
			expect(
				extractAssistantText([
					{ role: "assistant", content: [{ type: "tool_call", name: "ask" }] },
				]),
			).toBe("");
		});

		it("does not reuse prior assistant text when latest assistant has only thinking or tool use", () => {
			const text = extractAssistantText([
				{ role: "assistant", content: "Prior response from turn 1" },
				{ role: "user", content: "Follow up query" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", text: "Thinking silently..." },
						{ type: "tool_use", name: "bash" },
					],
				},
			]);
			expect(text).toBe("");
		});

		it("returns empty string when latest assistant has empty content or whitespace", () => {
			const text = extractAssistantText([
				{ role: "assistant", content: "Prior text" },
				{ role: "assistant", content: "   " },
			]);
			expect(text).toBe("");
		});
	});
});
