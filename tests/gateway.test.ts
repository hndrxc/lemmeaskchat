import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	GATEWAY_URL,
	Gateway,
	type GatewayEventListener,
	type GatewayInteractionCreateData,
	type GatewayMessageCreateData,
	type GatewayOptions,
	type GatewayPayload,
	type GatewaySocketLike,
	type TimerHandle,
} from "../src/discord/gateway";
import type { HostLogger } from "../src/host";

interface IdentifyPayloadData {
	token?: string | undefined;
	intents?: number | undefined;
	properties?: {
		os?: string | undefined;
		browser?: string | undefined;
		device?: string | undefined;
	} | undefined;
}

interface ScheduledTimer {
	id: number;
	due: number;
	fn: () => void;
	unref?: () => ScheduledTimer;
	ref?: () => ScheduledTimer;
}

class FakeClock {
	private now = 0;
	private nextId = 1;
	private timers = new Map<number, ScheduledTimer>();
	private originalSetTimeout?: typeof globalThis.setTimeout | undefined;
	private originalClearTimeout?: typeof globalThis.clearTimeout | undefined;
	private originalRandom?: typeof Math.random | undefined;

	install(fixedRandom = 0.5): void {
		this.now = 0;
		this.nextId = 1;
		this.timers.clear();
		this.originalSetTimeout = globalThis.setTimeout;
		this.originalClearTimeout = globalThis.clearTimeout;
		this.originalRandom = Math.random;

		Math.random = () => fixedRandom;

		globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			const id = this.nextId++;
			const delay = typeof timeout === "number" && timeout >= 0 ? timeout : 0;
			const due = this.now + delay;
			const fn =
				typeof handler === "function"
					? () => {
							(handler as (...a: unknown[]) => void)(...args);
						}
					: () => {};

			const timer: ScheduledTimer = {
				id,
				due,
				fn,
				unref() {
					return timer;
				},
				ref() {
					return timer;
				},
			};

			this.timers.set(id, timer);
			return timer as unknown as TimerHandle;
		}) as unknown as typeof setTimeout;

		globalThis.clearTimeout = ((timerId?: unknown) => {
			if (timerId === null || timerId === undefined) return;
			if (typeof timerId === "number") {
				this.timers.delete(timerId);
				return;
			}
			if (typeof timerId === "object" && "id" in timerId) {
				const idVal = timerId.id;
				if (typeof idVal === "number") {
					this.timers.delete(idVal);
				}
			}
		}) as unknown as typeof clearTimeout;
	}

	restore(): void {
		if (this.originalSetTimeout !== undefined) {
			globalThis.setTimeout = this.originalSetTimeout;
			this.originalSetTimeout = undefined;
		}
		if (this.originalClearTimeout !== undefined) {
			globalThis.clearTimeout = this.originalClearTimeout;
			this.originalClearTimeout = undefined;
		}
		if (this.originalRandom !== undefined) {
			Math.random = this.originalRandom;
			this.originalRandom = undefined;
		}
		this.timers.clear();
	}

	tick(ms: number): void {
		this.now += Math.max(0, ms);
		while (true) {
			let earliestId: number | null = null;
			let earliestDue = Infinity;
			for (const [id, timer] of this.timers.entries()) {
				if (timer.due <= this.now && timer.due < earliestDue) {
					earliestDue = timer.due;
					earliestId = id;
				}
			}
			if (earliestId === null) break;
			const timer = this.timers.get(earliestId);
			this.timers.delete(earliestId);
			timer?.fn();
		}
	}

	get activeTimersCount(): number {
		return this.timers.size;
	}
}

class FakeWebSocket implements GatewaySocketLike {
	readonly url: string;
	readonly protocols?: string | string[] | undefined;
	readyState: number = 1; // WebSocket.OPEN
	sent: string[] = [];
	closedWith?: { code: number; reason: string } | undefined;

	onopen?: ((event: unknown) => void) | null | undefined = null;
	onmessage?: ((event: { data: unknown }) => void) | null | undefined = null;
	onerror?: ((event: unknown) => void) | null | undefined = null;
	onclose?:
		| ((event: { code: number; reason: string; wasClean?: boolean | undefined }) => void)
		| null
		| undefined = null;

	private listeners = new Map<string, Set<GatewayEventListener>>();

	constructor(url: string, protocols?: string | string[] | undefined) {
		this.url = url;
		this.protocols = protocols;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		this.closedWith = { code, reason };
		this.readyState = 3; // WebSocket.CLOSED
	}

	addEventListener(type: string, listener: GatewayEventListener): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: GatewayEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	serverOpen(): void {
		this.readyState = 1;
		const event = {};
		this.onopen?.(event);
		for (const listener of this.listeners.get("open") ?? []) {
			listener(event);
		}
	}

	serverMessage(data: unknown): void {
		const payload = typeof data === "string" ? data : JSON.stringify(data);
		const event = { data: payload };
		this.onmessage?.(event);
		for (const listener of this.listeners.get("message") ?? []) {
			listener(event);
		}
	}

	serverClose(code = 1000, reason = ""): void {
		this.readyState = 3;
		const event = { code, reason, wasClean: code === 1000 };
		this.onclose?.(event);
		for (const listener of this.listeners.get("close") ?? []) {
			listener(event);
		}
	}

	serverError(err: unknown = new Error("WebSocket simulated connection error")): void {
		this.onerror?.(err);
		for (const listener of this.listeners.get("error") ?? []) {
			listener(err);
		}
	}

	sentPayloads<T = unknown>(): T[] {
		return this.sent.map((msg) => JSON.parse(msg) as T);
	}

	lastSentPayload<T = unknown>(): T | undefined {
		const last = this.sent[this.sent.length - 1];
		return last ? (JSON.parse(last) as T) : undefined;
	}
}

class FakeWebSocketManager {
	readonly sockets: FakeWebSocket[] = [];

	create = (url: string, protocols?: string | string[] | undefined): FakeWebSocket => {
		const ws = new FakeWebSocket(url, protocols);
		this.sockets.push(ws);
		return ws;
	};

	get current(): FakeWebSocket {
		const ws = this.sockets[this.sockets.length - 1];
		if (!ws) {
			throw new Error("No FakeWebSocket has been created yet");
		}
		return ws;
	}

	get count(): number {
		return this.sockets.length;
	}
}

interface RecordedLog {
	level: "warn" | "debug" | "info" | "error";
	message: string;
	context?: Record<string, unknown> | undefined;
}

interface MockLogger extends HostLogger {
	entries: RecordedLog[];
}

function createMockLogger(): MockLogger {
	const entries: RecordedLog[] = [];
	return {
		entries,
		warn(message: string, context?: Record<string, unknown>) {
			entries.push({ level: "warn", message, context });
		},
		debug(message: string, context?: Record<string, unknown>) {
			entries.push({ level: "debug", message, context });
		},
		info(message: string, context?: Record<string, unknown>) {
			entries.push({ level: "info", message, context });
		},
		error(message: string, context?: Record<string, unknown>) {
			entries.push({ level: "error", message, context });
		},
	};
}

interface TestGatewayHarness {
	gateway: Gateway;
	manager: FakeWebSocketManager;
	clock: FakeClock;
	logger: MockLogger;
	readyCalls: string[];
	messageCalls: GatewayMessageCreateData[];
	interactionCalls: GatewayInteractionCreateData[];
	fatalCalls: Error[];
}

function createHarness(
	customOptions?: Partial<GatewayOptions>,
	token = "test-token-xyz",
	fixedRandom = 0.5,
): TestGatewayHarness {
	const manager = new FakeWebSocketManager();
	const clock = new FakeClock();
	clock.install(fixedRandom);

	const logger = createMockLogger();
	const readyCalls: string[] = [];
	const messageCalls: GatewayMessageCreateData[] = [];
	const interactionCalls: GatewayInteractionCreateData[] = [];
	const fatalCalls: Error[] = [];

	const options: GatewayOptions = {
		WebSocketImpl: manager.create,
		onReady: (botUserId: string) => {
			readyCalls.push(botUserId);
		},
		onMessage: (data: GatewayMessageCreateData) => {
			messageCalls.push(data);
		},
		onInteraction: (data: GatewayInteractionCreateData) => {
			interactionCalls.push(data);
		},
		onFatal: (err: Error) => {
			fatalCalls.push(err);
		},
		logger,
		...customOptions,
	};

	const gateway = new Gateway(token, options);

	return {
		gateway,
		manager,
		clock,
		logger,
		readyCalls,
		messageCalls,
		interactionCalls,
		fatalCalls,
	};
}

describe("Gateway transport", () => {
	let activeClock: FakeClock | null = null;

	beforeEach(() => {
		activeClock = null;
	});

	afterEach(() => {
		if (activeClock) {
			activeClock.restore();
			activeClock = null;
		}
	});

	describe("constructor, options, and socket seam", () => {
		it("calling start multiple times while active is idempotent", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			harness.gateway.start();
			harness.gateway.start();

			expect(harness.manager.count).toBe(1);
			harness.gateway.stop();
		});
	});

	describe("Hello (op 10) and Identify (op 2)", () => {
		it("sends Identify payload with intents 4096 immediately upon receiving Hello", () => {
			const harness = createHarness(undefined, "bot-auth-token-12345");
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			expect(ws.sent.length).toBe(0);

			ws.serverMessage({
				op: 10,
				d: {
					heartbeat_interval: 41250,
				},
			});

			// Identify must be sent synchronously during Hello processing
			expect(ws.sent.length).toBe(1);
			const identify = ws.lastSentPayload<GatewayPayload>();

			expect(identify).toBeDefined();
			expect(identify?.op).toBe(2);

			const data = identify?.d as IdentifyPayloadData | undefined;

			expect(data).toBeDefined();
			expect(data?.token).toBe("bot-auth-token-12345");
			expect(data?.intents).toBe(4096);
			expect(data?.properties?.browser).toBe("lemmeaskchat");
			expect(data?.properties?.device).toBe("lemmeaskchat");
			expect(data?.properties?.os).toBe(process.platform);
		});

		it("ignores Hello with invalid or missing heartbeat_interval without crashing", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.serverMessage({ op: 10, d: { heartbeat_interval: -1 } });
			expect(ws.sent.length).toBe(0);

			ws.serverMessage({ op: 10, d: {} });
			expect(ws.sent.length).toBe(0);
		});
	});

	describe("heartbeat and sequence tracking", () => {
		it("sends initial heartbeat with lastSeq null after randomized delay, then on every interval", () => {
			// Fixed random at 0.5 with interval 1000 => initialDelay = 500ms
			const harness = createHarness(undefined, "test-token", 0.5);
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			// Only Identify sent so far
			expect(ws.sent.length).toBe(1);

			// Advance clock past initialDelay (500ms)
			harness.clock.tick(500);

			expect(ws.sent.length).toBe(2);
			const initialHb = ws.lastSentPayload<GatewayPayload>();
			expect(initialHb?.op).toBe(1);
			expect(initialHb?.d).toBeNull();

			// Simulate ACK for the initial heartbeat
			ws.serverMessage({ op: 11 });

			// Advance by full heartbeat interval (1000ms)
			harness.clock.tick(1000);
			expect(ws.sent.length).toBe(3);
			const secondHb = ws.lastSentPayload<GatewayPayload>();
			expect(secondHb?.op).toBe(1);
			expect(secondHb?.d).toBeNull();
		});

		it("heartbeats carry the last received dispatch sequence number (s)", () => {
			const harness = createHarness(undefined, "test-token", 0.5);
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			// Receive dispatch with sequence 1
			ws.serverMessage({
				op: 0,
				s: 1,
				t: "MESSAGE_CREATE",
				d: {
					id: "msg-1",
					channel_id: "chan-1",
					content: "hello",
					author: { id: "user-1" },
				},
			});

			// Advance past initial delay (500ms)
			harness.clock.tick(500);

			const hb1 = ws.lastSentPayload<GatewayPayload>();
			expect(hb1?.op).toBe(1);
			expect(hb1?.d).toBe(1);

			ws.serverMessage({ op: 11 });

			// Receive higher dispatch sequence 42
			ws.serverMessage({
				op: 0,
				s: 42,
				t: "MESSAGE_CREATE",
				d: {
					id: "msg-2",
					channel_id: "chan-1",
					content: "second",
					author: { id: "user-1" },
				},
			});

			harness.clock.tick(1000);

			const hb2 = ws.lastSentPayload<GatewayPayload>();
			expect(hb2?.op).toBe(1);
			expect(hb2?.d).toBe(42);
		});

		it("responds immediately to server heartbeat request (op 1) with current sequence number", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.serverMessage({
				op: 0,
				s: 99,
				t: "READY",
				d: {
					user: { id: "bot-123" },
				},
			});

			// Server sends op 1
			ws.serverMessage({ op: 1 });

			expect(ws.sent.length).toBe(1);
			const hb = ws.lastSentPayload<GatewayPayload>();
			expect(hb?.op).toBe(1);
			expect(hb?.d).toBe(99);
		});
	});

	describe("missing ACK triggers reconnect", () => {
		it("closes current socket with code 4000 and reconnects when heartbeat ACK is missing", () => {
			// Fixed random at 0.5, interval 1000 => initialDelay 500ms
			const harness = createHarness(undefined, "test-token", 0.5);
			activeClock = harness.clock;

			harness.gateway.start();
			const ws1 = harness.manager.current;
			ws1.serverOpen();

			ws1.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			// Tick 500ms: initial heartbeat is sent
			harness.clock.tick(500);
			expect(ws1.sent.length).toBe(2); // identify + heartbeat

			// Intentionally do NOT send op 11 ACK from server!
			// Tick next interval (1000ms): ACK watchdog triggers reconnect
			harness.clock.tick(1000);

			// Old socket should have been closed with code 4000
			expect(ws1.closedWith).toEqual({
				code: 4000,
				reason: "Heartbeat ACK timeout",
			});

			// A new WebSocket connection must be created immediately
			expect(harness.manager.count).toBe(2);
			const ws2 = harness.manager.current;
			expect(ws2).not.toBe(ws1);
			expect(ws2.url).toBe(GATEWAY_URL);

			// Fatal errors must NOT have been called
			expect(harness.fatalCalls.length).toBe(0);
		});
	});

	describe("op 7 (Reconnect)", () => {
		it("closes current socket with code 4000 and reconnects immediately on op 7", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws1 = harness.manager.current;
			ws1.serverOpen();

			ws1.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			expect(harness.manager.count).toBe(1);

			// Server requests reconnect via op 7
			ws1.serverMessage({ op: 7 });

			expect(ws1.closedWith).toEqual({
				code: 4000,
				reason: "Op 7 Reconnect",
			});

			expect(harness.manager.count).toBe(2);
			const ws2 = harness.manager.current;
			expect(ws2).not.toBe(ws1);
			expect(ws2.url).toBe(GATEWAY_URL);
			expect(harness.fatalCalls.length).toBe(0);
		});
	});

	describe("op 9 (Invalid Session)", () => {
		it("closes socket and reconnects after a randomized 1-5s delay on op 9", () => {
			// Fixed random at 0.5 => delay = 1000 + Math.floor(0.5 * 4000) = 3000ms
			const harness = createHarness(undefined, "test-token", 0.5);
			activeClock = harness.clock;

			harness.gateway.start();
			const ws1 = harness.manager.current;
			ws1.serverOpen();

			ws1.serverMessage({ op: 9, d: false });

			expect(ws1.closedWith).toEqual({
				code: 4000,
				reason: "Op 9 Invalid Session",
			});

			// Reconnect is delayed, not instantaneous
			expect(harness.manager.count).toBe(1);

			// Advancing by 2000ms is not enough
			harness.clock.tick(2000);
			expect(harness.manager.count).toBe(1);

			// Advancing past 3000ms total executes reconnect
			harness.clock.tick(1000);
			expect(harness.manager.count).toBe(2);
			expect(harness.manager.current).not.toBe(ws1);
		});
	});

	describe("fatal close codes (4004, 4010, 4011, 4012, 4013, 4014)", () => {
		it("calls onFatal with no reconnect when socket closes with code 4004", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.serverClose(4004, "Authentication failed");

			expect(harness.fatalCalls.length).toBe(1);
			expect(harness.fatalCalls[0]?.message).toMatch(/Discord gateway closed 4004: Authentication failed/);

			// Advance clock: no reconnection attempts must happen
			harness.clock.tick(60_000);
			expect(harness.manager.count).toBe(1);
			expect(harness.clock.activeTimersCount).toBe(0);
		});

	});

	describe("non-fatal close codes and exponential backoff", () => {
		it("schedules reconnect with backoff on non-fatal close and resets backoff on READY", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws1 = harness.manager.current;
			ws1.serverOpen();

			// Non-fatal abnormal close code 1006
			ws1.serverClose(1006, "Connection dropped");

			expect(harness.fatalCalls.length).toBe(0);
			// Reconnect scheduled for initial backoff of 1000ms
			expect(harness.manager.count).toBe(1);

			harness.clock.tick(999);
			expect(harness.manager.count).toBe(1);

			harness.clock.tick(1);
			expect(harness.manager.count).toBe(2);

			const ws2 = harness.manager.current;
			ws2.serverOpen();

			// Second drop without READY: backoff doubles to 2000ms
			ws2.serverClose(1006, "Connection dropped again");
			harness.clock.tick(1000);
			expect(harness.manager.count).toBe(2);

			harness.clock.tick(1000);
			expect(harness.manager.count).toBe(3);

			const ws3 = harness.manager.current;
			ws3.serverOpen();

			// Send READY dispatch on ws3 to reset backoff
			ws3.serverMessage({
				op: 0,
				t: "READY",
				d: {
					user: { id: "bot-user-reset" },
				},
			});

			expect(harness.readyCalls).toEqual(["bot-user-reset"]);

			// Another drop: backoff should be reset to 1000ms, not 4000ms
			ws3.serverClose(1006, "Drop after ready");
			harness.clock.tick(1000);
			expect(harness.manager.count).toBe(4);
		});
	});

	describe("stop() lifecycle", () => {
		it("closes active socket with code 1000, clears timers, and does not reconnect", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			expect(harness.clock.activeTimersCount).toBeGreaterThan(0);

			harness.gateway.stop();

			expect(ws.closedWith).toEqual({
				code: 1000,
				reason: "Normal Closure",
			});
			expect(harness.clock.activeTimersCount).toBe(0);

			// Advancing clock does not trigger reconnect
			harness.clock.tick(60_000);
			expect(harness.manager.count).toBe(1);
			expect(harness.fatalCalls.length).toBe(0);
		});

		it("ignores subsequent socket events after stop() is called", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			harness.gateway.stop();

			// Fire simulated server close after stop
			ws.serverClose(1006, "Late close");
			harness.clock.tick(60_000);

			expect(harness.manager.count).toBe(1);
		});

		it("can start cleanly again after being stopped", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			expect(harness.manager.count).toBe(1);

			harness.gateway.stop();
			expect(harness.manager.count).toBe(1);

			harness.gateway.start();
			expect(harness.manager.count).toBe(2);
			harness.gateway.stop();
		});
	});

	describe("callbacks error guarding and robustness (no crash)", () => {
		it("catches synchronous and asynchronous errors in onReady without crashing", async () => {
			let errorThrown = false;
			const harness = createHarness({
				onReady: () => {
					errorThrown = true;
					throw new Error("Synchronous onReady crash");
				},
			});
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			expect(() => {
				ws.serverMessage({
					op: 0,
					t: "READY",
					d: { user: { id: "bot-err" } },
				});
			}).not.toThrow();

			expect(errorThrown).toBe(true);
			// Observable lifecycle: gateway session remains active and can receive Hello/send Identify
			ws.serverMessage({ op: 10, d: { heartbeat_interval: 1000 } });
			expect(ws.sent.length).toBe(1);
			harness.gateway.stop();
			expect(ws.closedWith?.code).toBe(1000);

			// Also test rejected promise
			let asyncThrown = false;
			const harnessAsync = createHarness({
				onReady: async () => {
					asyncThrown = true;
					throw new Error("Asynchronous onReady rejection");
				},
			});

			harnessAsync.gateway.start();
			const wsAsync = harnessAsync.manager.current;
			wsAsync.serverOpen();

			expect(() => {
				wsAsync.serverMessage({
					op: 0,
					t: "READY",
					d: { user: { id: "bot-async-err" } },
				});
			}).not.toThrow();

			await Promise.resolve();
			expect(asyncThrown).toBe(true);
			harnessAsync.gateway.stop();
			expect(wsAsync.closedWith?.code).toBe(1000);
			harnessAsync.clock.restore();
		});

		it("catches synchronous and asynchronous errors in onMessage and onInteraction without crashing", async () => {
			let messageThrown = false;
			let interactionThrown = false;
			const harness = createHarness({
				onMessage: () => {
					messageThrown = true;
					throw new Error("Synchronous onMessage crash");
				},
				onInteraction: async () => {
					interactionThrown = true;
					throw new Error("Asynchronous onInteraction rejection");
				},
			});
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			expect(() => {
				ws.serverMessage({
					op: 0,
					t: "MESSAGE_CREATE",
					d: { id: "1", channel_id: "c", content: "x", author: { id: "u" } },
				});
			}).not.toThrow();
			expect(messageThrown).toBe(true);

			expect(() => {
				ws.serverMessage({
					op: 0,
					t: "INTERACTION_CREATE",
					d: { id: "1", token: "t", type: 3 },
				});
			}).not.toThrow();

			await Promise.resolve();
			expect(interactionThrown).toBe(true);

			// Observable lifecycle: gateway remains functional and tracks the active socket
			expect(harness.manager.current).toBe(ws);
			harness.gateway.stop();
			expect(ws.closedWith?.code).toBe(1000);
		});

		it("catches errors in onFatal callback without crashing", async () => {
			let fatalThrown = false;
			const harness = createHarness({
				onFatal: () => {
					fatalThrown = true;
					throw new Error("Exploding onFatal");
				},
			});
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			expect(() => {
				ws.serverClose(4004, "Authentication failed");
			}).not.toThrow();
			expect(fatalThrown).toBe(true);

			// Observable lifecycle: socket closed, no reconnect scheduled, timers cleared
			expect(harness.manager.count).toBe(1);
			expect(harness.clock.activeTimersCount).toBe(0);
		});

		it("safely handles non-string and malformed JSON payloads", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			// Malformed JSON string
			expect(() => {
				ws.serverMessage("not valid { json");
			}).not.toThrow();

			// Binary Uint8Array message (should be decoded and parsed)
			const binaryHello = new TextEncoder().encode(
				JSON.stringify({
					op: 10,
					d: { heartbeat_interval: 1000 },
				}),
			);

			expect(() => {
				ws.onmessage?.({ data: binaryHello });
			}).not.toThrow();

			expect(ws.sent.length).toBe(1); // Identify sent
			harness.gateway.stop();
		});

		it("safely handles socket.send exceptions without crashing", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws = harness.manager.current;
			ws.serverOpen();

			ws.send = () => {
				throw new Error("Simulated socket write failure");
			};

			expect(() => {
				ws.serverMessage({
					op: 10,
					d: { heartbeat_interval: 1000 },
				});
			}).not.toThrow();

			// Observable lifecycle: gateway did not crash, remains active
			expect(harness.manager.current).toBe(ws);
			harness.gateway.stop();
			expect(ws.closedWith?.code).toBe(1000);
		});
	});

	describe("stale socket event isolation after reconnect", () => {
		it("ignores late close and late message from replaced socket after op 7 reconnect", () => {
			const harness = createHarness();
			activeClock = harness.clock;

			harness.gateway.start();
			const ws1 = harness.manager.current;
			ws1.serverOpen();

			ws1.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			expect(harness.manager.count).toBe(1);

			// Server requests reconnect via op 7
			ws1.serverMessage({ op: 7 });

			// Old socket should have been closed with code 4000
			expect(ws1.closedWith).toEqual({
				code: 4000,
				reason: "Op 7 Reconnect",
			});

			// A new WebSocket connection must be created immediately
			expect(harness.manager.count).toBe(2);
			const ws2 = harness.manager.current;
			expect(ws2).not.toBe(ws1);

			// Regression: in native WebSockets, closing ws1 emits a late close event.
			// Existing fake close doesn't emit event, so emit explicitly.
			ws1.serverClose(4000, "Op 7 Reconnect");

			// Also simulate late message from ws1
			ws1.serverMessage({
				op: 0,
				t: "MESSAGE_CREATE",
				d: {
					id: "stale-msg",
					channel_id: "chan-stale",
					content: "stale content",
					author: { id: "user-stale" },
				},
			});

			// ws1 late events must not alter socket2, create extra connections, or deliver messages
			expect(harness.manager.count).toBe(2);
			expect(harness.messageCalls.length).toBe(0);

			// Advance clock: verify no reconnect timer was scheduled by ws1 late close
			harness.clock.tick(60_000);
			expect(harness.manager.count).toBe(2);

			// Active socket 2 receives Hello and sends Identify
			ws2.serverOpen();
			ws2.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});
			expect(ws2.sent.length).toBe(1);
			const identify = ws2.lastSentPayload<GatewayPayload>();
			expect(identify?.op).toBe(2);

			// Native stop must close active socket (ws2)
			harness.gateway.stop();
			expect(ws2.closedWith).toEqual({
				code: 1000,
				reason: "Normal Closure",
			});
		});

		it("ignores late close and late message from replaced socket after heartbeat ACK timeout", () => {
			const harness = createHarness(undefined, "test-token", 0.5);
			activeClock = harness.clock;

			harness.gateway.start();
			const ws1 = harness.manager.current;
			ws1.serverOpen();

			ws1.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});

			// Advance past initial delay (500ms): heartbeat sent
			harness.clock.tick(500);
			expect(ws1.sent.length).toBe(2);

			// Missing ACK triggers reconnect at 1000ms
			harness.clock.tick(1000);

			expect(ws1.closedWith).toEqual({
				code: 4000,
				reason: "Heartbeat ACK timeout",
			});

			expect(harness.manager.count).toBe(2);
			const ws2 = harness.manager.current;
			expect(ws2).not.toBe(ws1);

			// ws1 explicitly emits late close event and late message
			ws1.serverClose(4000, "Heartbeat ACK timeout");
			ws1.serverMessage({
				op: 0,
				t: "MESSAGE_CREATE",
				d: {
					id: "stale-ack-msg",
					channel_id: "chan-stale",
					content: "stale ack content",
					author: { id: "user-stale" },
				},
			});

			// No extra connection and no message dispatch
			expect(harness.manager.count).toBe(2);
			expect(harness.messageCalls.length).toBe(0);

			// Advance clock: no spurious reconnection
			harness.clock.tick(60_000);
			expect(harness.manager.count).toBe(2);

			// Active socket 2 receives Hello and sends Identify
			ws2.serverOpen();
			ws2.serverMessage({
				op: 10,
				d: { heartbeat_interval: 1000 },
			});
			expect(ws2.sent.length).toBe(1);

			// Native stop must close active socket (ws2)
			harness.gateway.stop();
			expect(ws2.closedWith).toEqual({
				code: 1000,
				reason: "Normal Closure",
			});
		});
	});
});
