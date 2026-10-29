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

export interface HostContext {
	ui: HostUIContext;
	hasUI: boolean;
	cwd: string;
	agent: HostAgentIdentity;
	invokeTool?<TDetails = unknown, TParams = unknown>(
		params: TParams,
		options?: { signal?: AbortSignal; onUpdate?: ToolUpdateCallback<TDetails> },
	): Promise<ToolResult<TDetails>>;
	[key: string]: unknown;
}

export interface HostCommandContext extends HostContext {
	[key: string]: unknown;
}

export type HostEventHandler<E = unknown> = (event: E, ctx: HostContext) => Promise<void> | void;

export interface HostApi {
	on(event: string, handler: HostEventHandler<any>): void;
	registerTool<TParams = unknown, TDetails = unknown>(tool: HostToolDefinition<TParams, TDetails>): void;
	registerCommand(name: string, options: HostCommandOptions): void;
	getAllTools(): ToolInfoLite[];
	logger: HostLogger;
	pi: {
		getAgentDir(): string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}
