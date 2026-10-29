/**
 * Minimal structural host types for omp-lemmeaskchat.
 * Confirmed against @oh-my-pi/pi-coding-agent@18.12.4.
 * No runtime or compile-time dependency on @oh-my-pi packages.
 */

export interface ToolResultTextContent {
	type: "text";
	text: string;
}

export interface ToolResult<TDetails = unknown> {
	content: Array<ToolResultTextContent | { type: string; [key: string]: unknown }>;
	details?: TDetails;
	isError?: boolean;
}

export type ToolUpdateCallback<TDetails = unknown> = (partialResult: ToolResult<TDetails>) => void;

export interface ToolSourceInfoLite {
	source: "builtin" | "extension" | "mcp" | "sdk" | string;
	[key: string]: unknown;
}

export interface ToolInfoLite {
	name: string;
	description: string;
	parameters: unknown;
	sourceInfo?: ToolSourceInfoLite;
	[key: string]: unknown;
}

export interface HostToolDefinition<TParams = unknown, TDetails = unknown> {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	approval?: "read" | "write" | "exec";
	strict?: boolean;
	concurrency?: "exclusive" | "concurrent" | string;
	execute(
		toolCallId: string,
		params: TParams,
		signal: AbortSignal | undefined,
		onUpdate: ToolUpdateCallback<TDetails> | undefined,
		ctx: HostContext,
	): Promise<ToolResult<TDetails>>;
}

export interface HostCommandCompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface HostCommandOptions {
	description?: string;
	getArgumentCompletions?: (
		argumentPrefix: string,
	) => HostCommandCompletionItem[] | null | Promise<HostCommandCompletionItem[] | null>;
	handler(args: string, ctx: HostCommandContext): Promise<void> | void;
}

export interface HostLogger {
	warn(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
	info?(message: string, context?: Record<string, unknown>): void;
	error?(message: string, context?: Record<string, unknown>): void;
}

export interface HostUIContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface HostAgentIdentity {
	kind: "main" | "sub";
	[key: string]: unknown;
}

export interface HostSessionManager {
	getSessionId(): string;
	getSessionFile?(): string;
	[key: string]: unknown;
}

export interface HostContext {
	ui: HostUIContext;
	hasUI: boolean;
	cwd: string;
	agent: HostAgentIdentity;
	sessionManager?: HostSessionManager;
	isIdle?(): boolean;
	hasPendingMessages?(): boolean;
	getAsyncJobSnapshot?(): unknown;
	invokeTool?<TDetails = unknown, TParams = unknown>(
		params: TParams,
		options?: { signal?: AbortSignal; onUpdate?: ToolUpdateCallback<TDetails> },
	): Promise<ToolResult<TDetails>>;
	[key: string]: unknown;
}

export interface HostCommandContext extends HostContext {
	[key: string]: unknown;
}

export interface HostSendUserMessageOptions {
	deliverAs?: "steer" | "followUp" | "aside";
	[key: string]: unknown;
}

export interface HostAgentMessage {
	role?: string;
	content?: unknown;
	[key: string]: unknown;
}

export interface HostAgentEndEvent {
	type?: "agent_end";
	messages?: HostAgentMessage[];
	willContinue?: boolean;
	awaitingAsyncWork?: boolean;
	[key: string]: unknown;
}

export interface HostAgentStartEvent {
	type: "agent_start";
	[key: string]: unknown;
}

export interface HostSessionStartEvent {
	type: "session_start";
	[key: string]: unknown;
}

export interface HostSessionShutdownEvent {
	type: "session_shutdown";
	[key: string]: unknown;
}

export interface HostSessionSwitchEvent {
	type: "session_switch";
	reason?: "new" | "resume" | "fork";
	previousSessionFile?: string;
	[key: string]: unknown;
}

export type HostEventHandler<E = unknown> = (event: E, ctx: HostContext) => Promise<void> | void;

export interface HostApi {
	on(event: string, handler: HostEventHandler<unknown>): void;
	registerTool<TParams = unknown, TDetails = unknown>(tool: HostToolDefinition<TParams, TDetails>): void;
	registerCommand(name: string, options: HostCommandOptions): void;
	getAllTools(): ToolInfoLite[];
	logger: HostLogger;
	getSessionName?(): string | undefined;
	setSessionName?(name: string): Promise<void>;
	sendUserMessage?(content: string, options?: HostSendUserMessageOptions): void;
	pi: {
		getAgentDir(): string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}
