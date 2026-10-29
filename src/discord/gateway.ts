import type { HostLogger } from "../host";

export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

export const FATAL_CLOSE_CODES = new Set<number>([4004, 4010, 4011, 4012, 4013, 4014]);

export type GatewayEventListener = (event: unknown) => void;

export interface GatewaySocketLike {
	send(data: string): void;
	close(code?: number | undefined, reason?: string | undefined): void;
	readyState?: number | undefined;
	onopen?: ((event: unknown) => void) | null | undefined;
	onmessage?: ((event: { data: unknown }) => void) | null | undefined;
	onerror?: ((event: unknown) => void) | null | undefined;
	onclose?: ((event: { code: number; reason: string; wasClean?: boolean | undefined }) => void) | null | undefined;
	addEventListener?(type: string, listener: GatewayEventListener): void;
	removeEventListener?(type: string, listener: GatewayEventListener): void;
}

export type GatewayWebSocketFactory =
	| (new (url: string, protocols?: string | string[] | undefined) => GatewaySocketLike)
	| ((url: string, protocols?: string | string[] | undefined) => GatewaySocketLike);

export interface GatewayReadyData {
	user: {
		id: string;
		username?: string | undefined;
		discriminator?: string | undefined;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface GatewayMessageCreateData {
	id: string;
	channel_id: string;
	content: string;
	author: {
		id: string;
		username?: string | undefined;
		bot?: boolean | undefined;
		[key: string]: unknown;
	};
	message_reference?: {
		message_id?: string | undefined;
		channel_id?: string | undefined;
		guild_id?: string | undefined;
		[key: string]: unknown;
	} | undefined;
	[key: string]: unknown;
}

export interface GatewayInteractionCreateData {
	id: string;
	token: string;
	type: number;
	user?: {
		id: string;
		username?: string | undefined;
		[key: string]: unknown;
	} | undefined;
	member?: {
		user?: {
			id: string;
			username?: string | undefined;
			[key: string]: unknown;
		} | undefined;
		[key: string]: unknown;
	} | undefined;
	data?: {
		custom_id?: string | undefined;
		component_type?: number | undefined;
		values?: string[] | undefined;
		[key: string]: unknown;
	} | undefined;
	[key: string]: unknown;
}

export interface GatewayHelloData {
	heartbeat_interval: number;
	[key: string]: unknown;
}

export interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number | null | undefined;
	t?: string | null | undefined;
}

export interface GatewayOptions {
	WebSocketImpl?: GatewayWebSocketFactory | undefined;
	onReady: (botUserId: string) => void | Promise<void>;
	onMessage: (data: GatewayMessageCreateData) => void | Promise<void>;
	onInteraction: (data: GatewayInteractionCreateData) => void | Promise<void>;
	onFatal: (error: Error) => void | Promise<void>;
	logger?: HostLogger | undefined;
}

export type TimerHandle = { unref?: (() => void) | undefined } | number;

function createSocket(
	impl: GatewayWebSocketFactory,
	url: string,
): GatewaySocketLike {
	try {
		return new (impl as new (url: string) => GatewaySocketLike)(url);
	} catch (err: unknown) {
		if (typeof impl === "function") {
			try {
				return (impl as (url: string) => GatewaySocketLike)(url);
			} catch {
				throw err;
			}
		}
		throw err;
	}
}

function isHelloData(data: unknown): data is GatewayHelloData {
	return Boolean(
		data &&
		typeof data === "object" &&
		"heartbeat_interval" in data &&
		typeof data.heartbeat_interval === "number",
	);
}

function getBotUserId(data: unknown): string | undefined {
	if (
		data &&
		typeof data === "object" &&
		"user" in data &&
		data.user &&
		typeof data.user === "object" &&
		"id" in data.user &&
		typeof data.user.id === "string"
	) {
		return data.user.id;
	}
	return undefined;
}

export class Gateway {
	private readonly token: string;
	private readonly options: GatewayOptions;
	private readonly webSocketFactory: GatewayWebSocketFactory | undefined;
	private readonly logger?: HostLogger | undefined;

	private ws: GatewaySocketLike | null = null;
	private stopped = false;
	private lastSeq: number | null = null;
	private heartbeatInterval: number | null = null;
	private heartbeatTimer: TimerHandle | null = null;
	private reconnectTimer: TimerHandle | null = null;
	private ackReceived = true;
	private backoffMs = 1000;
	private cleanupSocket: (() => void) | null = null;

	constructor(token: string, options: GatewayOptions) {
		this.token = token;
		this.options = options;
		this.logger = options.logger;

		const defaultWebSocket =
			typeof WebSocket !== "undefined"
				? (WebSocket as unknown as GatewayWebSocketFactory)
				: undefined;

		this.webSocketFactory = options.WebSocketImpl ?? defaultWebSocket;
	}

	start(): void {
		if (this.ws && !this.stopped) {
			return;
		}
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.clearTimers();
		this.cleanupSocket?.();
		this.cleanupSocket = null;
		if (this.ws) {
			const socket = this.ws;
			this.ws = null;
			try {
				socket.close(1000, "Normal Closure");
			} catch (err: unknown) {
				this.logger?.debug("Gateway error during stop close", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	private connect(): void {
		if (this.stopped) {
			return;
		}
		this.clearTimers();
		this.lastSeq = null;

		if (!this.webSocketFactory) {
			const err = new Error("WebSocket implementation is not available");
			this.logger?.warn(err.message);
			this.safeInvokeFatal(err);
			return;
		}

		let ws: GatewaySocketLike;
		try {
			ws = createSocket(this.webSocketFactory, GATEWAY_URL);
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.logger?.warn("Gateway failed to create WebSocket", { error: error.message });
			const delay = this.backoffMs;
			this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
			this.scheduleConnect(delay);
			return;
		}

		this.ws = ws;

		let openHandled = false;
		const handleOpen = () => {
			if (this.stopped || this.ws !== ws) return;
			if (openHandled) return;
			openHandled = true;
			this.safeCallback("onopen", () => {
				if (this.stopped || this.ws !== ws) return;
				this.logger?.debug("Gateway websocket opened");
			});
		};

		let lastHandledMessageEvent: unknown = null;
		const handleMessage = (event: { data: unknown }) => {
			if (this.stopped || this.ws !== ws) return;
			if (event && event === lastHandledMessageEvent) return;
			lastHandledMessageEvent = event;
			this.safeCallback("onmessage", () => {
				if (this.stopped || this.ws !== ws) return;
				this.handleRawMessage(ws, event?.data);
			});
		};

		let lastHandledErrorEvent: unknown = null;
		const handleError = (event: unknown) => {
			if (this.stopped || this.ws !== ws) return;
			if (event && event === lastHandledErrorEvent) return;
			lastHandledErrorEvent = event;
			this.safeCallback("onerror", () => {
				if (this.stopped || this.ws !== ws) return;
				this.logger?.warn("Gateway websocket error", {
					error: event instanceof Error ? event.message : String(event),
				});
			});
		};

		let lastHandledCloseEvent: unknown = null;
		const handleClose = (event: { code?: number | undefined; reason?: string | undefined }) => {
			if (this.stopped || this.ws !== ws) return;
			if (event && event === lastHandledCloseEvent) return;
			lastHandledCloseEvent = event;
			this.safeCallback("onclose", () => {
				if (this.stopped || this.ws !== ws) return;
				this.handleClose(ws, event?.code ?? 1000, event?.reason ?? "");
			});
		};

		ws.onopen = handleOpen;
		ws.onmessage = handleMessage;
		ws.onerror = handleError;
		ws.onclose = handleClose;

		if (typeof ws.addEventListener === "function") {
			try {
				ws.addEventListener("open", handleOpen);
				ws.addEventListener("message", handleMessage as GatewayEventListener);
				ws.addEventListener("error", handleError);
				ws.addEventListener("close", handleClose as GatewayEventListener);
			} catch (err: unknown) {
				this.logger?.debug("Gateway failed to addEventListener", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		this.cleanupSocket = () => {
			ws.onopen = null;
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			if (typeof ws.removeEventListener === "function") {
				try {
					ws.removeEventListener("open", handleOpen);
					ws.removeEventListener("message", handleMessage as GatewayEventListener);
					ws.removeEventListener("error", handleError);
					ws.removeEventListener("close", handleClose as GatewayEventListener);
				} catch (err: unknown) {
					this.logger?.debug("Gateway failed to removeEventListener", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		};
	}

	private handleRawMessage(socket: GatewaySocketLike, rawData: unknown): void {
		if (this.stopped || this.ws !== socket) {
			return;
		}
		let text: string;
		if (typeof rawData === "string") {
			text = rawData;
		} else if (rawData instanceof Uint8Array) {
			text = new TextDecoder().decode(rawData);
		} else if (rawData && typeof rawData === "object" && "toString" in rawData && typeof rawData.toString === "function") {
			text = rawData.toString();
		} else {
			this.logger?.warn("Gateway received non-string message", {
				type: typeof rawData,
			});
			return;
		}

		let payload: GatewayPayload;
		try {
			payload = JSON.parse(text) as GatewayPayload;
		} catch (err: unknown) {
			this.logger?.warn("Gateway received invalid JSON message", {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		this.handlePayload(socket, payload);
	}

	private handlePayload(socket: GatewaySocketLike, payload: GatewayPayload): void {
		if (this.stopped || this.ws !== socket) {
			return;
		}
		switch (payload.op) {
			case 0: // Dispatch
				if (typeof payload.s === "number") {
					this.lastSeq = payload.s;
				}
				this.handleDispatch(payload.t ?? undefined, payload.d);
				break;
			case 1: // Heartbeat
				this.sendHeartbeat();
				break;
			case 7: // Reconnect
				this.logger?.debug("Gateway received op 7 Reconnect");
				this.reconnect(0, 4000, "Op 7 Reconnect");
				break;
			case 9: { // Invalid Session
				this.logger?.warn("Gateway received op 9 Invalid Session");
				const delay = 1000 + Math.floor(Math.random() * 4000);
				this.reconnect(delay, 4000, "Op 9 Invalid Session");
				break;
			}
			case 10: // Hello
				if (isHelloData(payload.d)) {
					this.handleHello(socket, payload.d);
				} else {
					this.logger?.warn("Gateway received Hello with invalid data", { d: payload.d });
				}
				break;
			case 11: // Heartbeat ACK
				this.ackReceived = true;
				break;
			default:
				this.logger?.debug(`Gateway received unhandled opcode ${payload.op}`);
				break;
		}
	}

	private handleDispatch(event: string | undefined, data: unknown): void {
		if (!event) return;
		switch (event) {
			case "READY": {
				this.backoffMs = 1000;
				const botUserId = getBotUserId(data);
				if (botUserId) {
					this.safeInvoke("onReady", () => this.options.onReady(botUserId));
				} else {
					this.logger?.warn("Gateway received READY without user.id", { data });
				}
				break;
			}
			case "MESSAGE_CREATE": {
				const messageData = data as GatewayMessageCreateData;
				this.safeInvoke("onMessage", () => this.options.onMessage(messageData));
				break;
			}
			case "INTERACTION_CREATE": {
				const interactionData = data as GatewayInteractionCreateData;
				this.safeInvoke("onInteraction", () => this.options.onInteraction(interactionData));
				break;
			}
			default:
				break;
		}
	}

	private handleHello(socket: GatewaySocketLike, data: GatewayHelloData): void {
		if (this.stopped || this.ws !== socket) {
			return;
		}
		const interval = data.heartbeat_interval;
		if (interval <= 0) {
			this.logger?.warn("Gateway received non-positive heartbeat_interval in Hello", { interval });
			return;
		}

		this.heartbeatInterval = interval;
		this.ackReceived = true;
		this.clearHeartbeat();

		const initialDelay = Math.floor(interval * Math.random());
		const timer = setTimeout(() => {
			this.safeCallback("initialHeartbeat", () => {
				if (this.stopped || this.ws !== socket) {
					return;
				}
				this.sendHeartbeat();
				this.ackReceived = false;
				this.startHeartbeatLoop(socket, interval);
			});
		}, initialDelay);
		timer.unref?.();
		this.heartbeatTimer = timer;

		this.sendIdentify();
	}

	private startHeartbeatLoop(socket: GatewaySocketLike, interval: number): void {
		const timer = setTimeout(() => {
			this.safeCallback("heartbeatTick", () => {
				if (this.stopped || this.ws !== socket) {
					return;
				}
				if (!this.ackReceived) {
					this.logger?.warn("Gateway heartbeat ACK timed out; closing with 4000 and reconnecting");
					this.reconnect(0, 4000, "Heartbeat ACK timeout");
					return;
				}
				this.ackReceived = false;
				this.sendHeartbeat();
				this.startHeartbeatLoop(socket, interval);
			});
		}, interval);
		timer.unref?.();
		this.heartbeatTimer = timer;
	}

	private sendHeartbeat(): void {
		this.send({
			op: 1,
			d: this.lastSeq,
		});
	}

	private sendIdentify(): void {
		this.send({
			op: 2,
			d: {
				token: this.token,
				intents: 4096,
				properties: {
					os: typeof process !== "undefined" ? process.platform : "unknown",
					browser: "lemmeaskchat",
					device: "lemmeaskchat",
				},
			},
		});
	}

	private send(payload: unknown): void {
		if (!this.ws || this.stopped) {
			return;
		}
		if (typeof this.ws.readyState === "number" && this.ws.readyState !== 1) {
			return;
		}
		try {
			this.ws.send(JSON.stringify(payload));
		} catch (err: unknown) {
			this.logger?.warn("Gateway send error", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleClose(socket: GatewaySocketLike, code: number, reason: string): void {
		if (this.stopped || this.ws !== socket) {
			return;
		}
		this.clearHeartbeat();
		this.cleanupSocket?.();
		this.cleanupSocket = null;
		this.ws = null;

		if (FATAL_CLOSE_CODES.has(code)) {
			this.logger?.warn(`Discord gateway closed with fatal code ${code}: ${reason}`);
			this.safeInvokeFatal(new Error(`Discord gateway closed ${code}: ${reason}`));
			return;
		}

		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
		this.logger?.debug(`Discord gateway closed with code ${code}: ${reason}; reconnecting in ${delay}ms`);
		this.scheduleConnect(delay);
	}

	private reconnect(delayMs: number, closeCode?: number, closeReason?: string): void {
		if (this.stopped) {
			return;
		}
		this.clearTimers();
		this.cleanupSocket?.();
		this.cleanupSocket = null;
		if (this.ws) {
			const socket = this.ws;
			this.ws = null;
			try {
				socket.close(closeCode, closeReason);
			} catch (err: unknown) {
				this.logger?.debug("Gateway error closing socket during reconnect", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (delayMs <= 0) {
			this.connect();
		} else {
			this.scheduleConnect(delayMs);
		}
	}

	private scheduleConnect(delayMs: number): void {
		if (this.stopped) {
			return;
		}
		this.clearReconnect();
		const timer = setTimeout(() => {
			this.safeCallback("reconnect", () => {
				this.connect();
			});
		}, delayMs);
		timer.unref?.();
		this.reconnectTimer = timer;
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearTimeout(this.heartbeatTimer as unknown as number);
			this.heartbeatTimer = null;
		}
	}

	private clearReconnect(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer as unknown as number);
			this.reconnectTimer = null;
		}
	}

	private clearTimers(): void {
		this.clearHeartbeat();
		this.clearReconnect();
	}

	private safeCallback(name: string, fn: () => void): void {
		if (this.stopped) {
			return;
		}
		try {
			fn();
		} catch (err: unknown) {
			this.logger?.warn(`Gateway error in ${name}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private safeInvoke<T>(name: string, fn: () => T | Promise<T>): void {
		try {
			const result = fn();
			if (result && typeof (result as Promise<unknown>).then === "function") {
				(result as Promise<unknown>).catch((err: unknown) => {
					this.logger?.warn(`Gateway unhandled promise in ${name}`, {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		} catch (err: unknown) {
			this.logger?.warn(`Gateway error in ${name}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private safeInvokeFatal(err: Error): void {
		try {
			const result = this.options.onFatal(err);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				(result as Promise<unknown>).catch((fatalErr: unknown) => {
					this.logger?.warn("Gateway error in onFatal callback", {
						error: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
					});
				});
			}
		} catch (fatalErr: unknown) {
			this.logger?.warn("Gateway error in onFatal callback", {
				error: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
			});
		}
	}
}
