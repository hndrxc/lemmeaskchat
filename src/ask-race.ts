import { basename } from "node:path";
import type { AskParams, QuestionAnswer } from "./ask-format.ts";
import { formatAnswers } from "./ask-format.ts";
import { loadConfig, remotePlan } from "./config.ts";
import { getBridge } from "./discord/bridge.ts";
import type { HostContext, HostLogger, ToolResult, ToolUpdateCallback } from "./host.ts";
import type { RemoteBridge } from "./remote-ask.ts";
import { startRemoteAsk } from "./remote-ask.ts";

export interface CreateAskExecuteOptions {
	agentDir: string;
	logger: HostLogger;
	bridgeFactory?: typeof getBridge | undefined;
}

export type AskExecuteFunction = (
	toolCallId: string,
	params: AskParams,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateCallback | undefined,
	ctx: HostContext,
) => Promise<ToolResult>;

export interface RaceAskOptions {
	params: AskParams;
	signal?: AbortSignal | undefined;
	onUpdate?: ToolUpdateCallback | undefined;
	ctx: HostContext;
	bridge: RemoteBridge;
	delayMs: number;
	project: string;
	onError?: ((error: Error) => void) | undefined;
}

export function createAskExecute({
	agentDir,
	logger,
	bridgeFactory = getBridge,
}: CreateAskExecuteOptions): AskExecuteFunction {
	return async (_toolCallId, params, signal, onUpdate, ctx) => {
		if (!ctx.invokeTool) {
			throw new Error("lemmeaskchat: native ask tool unavailable for delegation");
		}

		const cfg = loadConfig(agentDir);
		const plan = remotePlan(cfg);

		if (!plan.send) {
			const invokeOptions: { onUpdate?: ToolUpdateCallback } = {};
			if (onUpdate !== undefined) {
				invokeOptions.onUpdate = onUpdate;
			}
			return ctx.invokeTool(params as unknown as Record<string, unknown>, invokeOptions);
		}

		const bridge = bridgeFactory({
			token: cfg.discordBotToken!,
			userId: cfg.discordUserId!,
			logger,
		});

		const project = ctx.cwd ? basename(ctx.cwd) : "omp";

		return raceAsk({
			params,
			signal,
			onUpdate,
			ctx,
			bridge,
			delayMs: plan.delayMs,
			project,
			onError: (err) => {
				try {
					ctx.ui?.notify?.(`lemmeaskchat: ${err.message}`, "warning");
				} catch {
					// ignore notification failure
				}
			},
		});
	};
}

export async function raceAsk(options: RaceAskOptions): Promise<ToolResult> {
	const { params, signal, onUpdate, ctx, bridge, delayMs, project, onError } = options;

	if (!ctx.invokeTool) {
		throw new Error("lemmeaskchat: native ask tool unavailable for delegation");
	}

	const remoteWon = new AbortController();
	let nativeSignal: AbortSignal;
	let cleanupSignals = (): void => {};

	if (!signal) {
		nativeSignal = remoteWon.signal;
	} else if (typeof AbortSignal.any === "function") {
		try {
			nativeSignal = AbortSignal.any([signal, remoteWon.signal]);
		} catch {
			const combined = new AbortController();
			if (signal.aborted) {
				combined.abort(signal.reason);
			} else if (remoteWon.signal.aborted) {
				combined.abort(remoteWon.signal.reason);
			} else {
				const onOuter = () => combined.abort(signal.reason);
				const onRemote = () => combined.abort(remoteWon.signal.reason);
				signal.addEventListener("abort", onOuter, { once: true });
				remoteWon.signal.addEventListener("abort", onRemote, { once: true });
				cleanupSignals = () => {
					signal.removeEventListener("abort", onOuter);
					remoteWon.signal.removeEventListener("abort", onRemote);
				};
			}
			nativeSignal = combined.signal;
		}
	} else {
		const combined = new AbortController();
		if (signal.aborted) {
			combined.abort(signal.reason);
		} else if (remoteWon.signal.aborted) {
			combined.abort(remoteWon.signal.reason);
		} else {
			const onOuter = () => combined.abort(signal.reason);
			const onRemote = () => combined.abort(remoteWon.signal.reason);
			signal.addEventListener("abort", onOuter, { once: true });
			remoteWon.signal.addEventListener("abort", onRemote, { once: true });
			cleanupSignals = () => {
				signal.removeEventListener("abort", onOuter);
				remoteWon.signal.removeEventListener("abort", onRemote);
			};
		}
		nativeSignal = combined.signal;
	}

	let won: QuestionAnswer[] | undefined;

	const remote = startRemoteAsk({
		bridge,
		params,
		delayMs,
		project,
		onError: (err) => {
			try {
				onError?.(err);
			} catch {
				// ignore
			}
		},
	});

	remote.result
		.then((answers) => {
			if (answers) {
				won = answers;
				remoteWon.abort();
			}
		})
		.catch(() => {
			// Handled via onError in startRemoteAsk; prevent unhandled rejection
		});

	const invokeOptions: { signal: AbortSignal; onUpdate?: ToolUpdateCallback } = {
		signal: nativeSignal,
	};
	if (onUpdate !== undefined) {
		invokeOptions.onUpdate = onUpdate;
	}

	try {
		try {
			const result = await ctx.invokeTool(
				params as unknown as Record<string, unknown>,
				invokeOptions,
			);
			remote.close("terminal");
			return result;
		} catch (err) {
			if (won) {
				return formatAnswers(params, won);
			}
			remote.close("cancelled");
			throw err;
		}
	} finally {
		cleanupSignals();
	}
}
