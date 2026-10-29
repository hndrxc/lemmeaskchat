import { randomUUID } from "node:crypto";
import {
	type AskParams,
	type AskQuestion,
	type QuestionAnswer,
	closedContent,
	renderQuestion,
} from "./ask-format.ts";
import type { DiscordBridge, OpenQuestion } from "./discord/bridge.ts";

export type RemoteBridge = Pick<
	DiscordBridge,
	"acquire" | "release" | "postQuestion" | "closeQuestion" | "rememberClosedAsk" | "onError"
>;

export interface StartRemoteAskOptions {
	bridge: RemoteBridge;
	params: AskParams;
	delayMs: number;
	project: string;
	onError: (error: Error) => void;
}

export interface RemoteAskHandle {
	result: Promise<QuestionAnswer[] | undefined>;
	close(reason: "terminal" | "cancelled"): void;
}

export type TimerHandle = { unref?: (() => void) | undefined } | number;

const HINT_50007 =
	"Discord bot cannot DM you: share a server with the bot and allow DMs from that server's members.";

function normalizeError(err: unknown): Error {
	if (err && typeof err === "object") {
		const anyErr = err as Record<string, unknown>;
		if (anyErr.code === 50007 || anyErr.code === "50007") {
			return new Error(HINT_50007);
		}
		if (typeof anyErr.message === "string" && anyErr.message.includes("50007")) {
			return new Error(HINT_50007);
		}
	}
	if (err instanceof Error) {
		return err;
	}
	return new Error(String(err));
}

export function startRemoteAsk(options: StartRemoteAskOptions): RemoteAskHandle {
	const { bridge, params, delayMs, project, onError } = options;
	const askKey = randomUUID().slice(0, 8);

	let resolveResult!: (value: QuestionAnswer[] | undefined) => void;
	const result = new Promise<QuestionAnswer[] | undefined>((resolve) => {
		resolveResult = resolve;
	});

	let isClosed = false;
	let closedReason: "terminal" | "cancelled" = "cancelled";

	let timer: TimerHandle | undefined;
	let unsubscribeError: (() => void) | undefined;

	let acquired = false;
	let isAcquiring = false;
	let isPosting = false;

	let currentMessageId: string | undefined;
	let currentContent: string | undefined;

	let cancelCurrentQuestion: (() => void) | undefined;

	let notifiedError = false;
	function notifyErrorOnce(err: unknown): void {
		if (notifiedError) return;
		notifiedError = true;
		try {
			onError(normalizeError(err));
		} catch {
			// Ignore any errors thrown by user's onError handler
		}
	}

	function close(reason: "terminal" | "cancelled"): void {
		if (isClosed) return;
		isClosed = true;
		closedReason = reason;

		if (timer !== undefined) {
			clearTimeout(timer as never);
			timer = undefined;
		}

		if (unsubscribeError) {
			try {
				unsubscribeError();
			} catch {
				// ignore
			}
			unsubscribeError = undefined;
		}

		const msgId = currentMessageId;
		const content = currentContent;
		currentMessageId = undefined;
		currentContent = undefined;

		if (msgId && content) {
			try {
				void bridge.closeQuestion(msgId, closedContent(content, reason)).catch(() => {});
			} catch {
				// ignore
			}
		}

		if (cancelCurrentQuestion) {
			cancelCurrentQuestion();
			cancelCurrentQuestion = undefined;
		}

		try {
			bridge.rememberClosedAsk(askKey);
		} catch {
			// ignore
		}

		if (acquired && !isPosting) {
			acquired = false;
			try {
				bridge.release();
			} catch {
				// ignore
			}
		}

		resolveResult(undefined);
	}

	function fail(err: unknown): void {
		if (isClosed) return;
		notifyErrorOnce(err);
		close("cancelled");
	}

	if (typeof bridge.onError === "function") {
		try {
			unsubscribeError = bridge.onError((err: Error) => {
				fail(err);
			});
		} catch {
			// ignore
		}
	}

	async function runFlow(): Promise<void> {
		if (isClosed) return;

		try {
			isAcquiring = true;
			try {
				await bridge.acquire();
				acquired = true;
			} catch (err) {
				if (isClosed) {
					return;
				}
				throw err;
			} finally {
				isAcquiring = false;
			}

			if (isClosed) {
				if (acquired) {
					acquired = false;
					try {
						bridge.release();
					} catch {
						// ignore
					}
				}
				return;
			}

			const answers: QuestionAnswer[] = [];

			for (let qIndex = 0; qIndex < params.questions.length; qIndex++) {
				if (isClosed) return;

				const question = params.questions[qIndex];
				if (!question) continue;

				const total = params.questions.length;
				const rendered = renderQuestion({
					askKey,
					qIndex,
					total,
					question,
					project,
				});

				let resolveAnswer!: (answer: QuestionAnswer) => void;
				const answerPromise = new Promise<QuestionAnswer>((res) => {
					resolveAnswer = res;
				});

				const openQuestion: OpenQuestion = {
					askKey,
					qIndex,
					question,
					content: rendered.content,
					components: rendered.components,
					resolve: (ans: QuestionAnswer) => {
						resolveAnswer(ans);
					},
				};

				let messageId: string;
				isPosting = true;
				try {
					messageId = await bridge.postQuestion(openQuestion);
				} catch (err) {
					if (isClosed) {
						if (acquired) {
							acquired = false;
							try {
								bridge.release();
							} catch {
								// ignore
							}
						}
						return;
					}
					throw err;
				} finally {
					isPosting = false;
				}

				if (isClosed) {
					try {
						await bridge.closeQuestion(
							messageId,
							closedContent(rendered.content, closedReason),
						).catch(() => {});
					} catch {
						// ignore
					}
					if (acquired) {
						acquired = false;
						try {
							bridge.release();
						} catch {
							// ignore
						}
					}
					return;
				}

				currentMessageId = messageId;
				currentContent = rendered.content;

				const answer = await new Promise<QuestionAnswer | undefined>(
					(resolveWait) => {
						cancelCurrentQuestion = () => resolveWait(undefined);
						answerPromise.then((ans) => {
							cancelCurrentQuestion = undefined;
							resolveWait(ans);
						});
					},
				);

				currentMessageId = undefined;
				currentContent = undefined;

				if (isClosed || !answer) {
					return;
				}

				answers.push(answer);
			}

			if (isClosed) return;

			isClosed = true;

			if (unsubscribeError) {
				try {
					unsubscribeError();
				} catch {
					// ignore
				}
				unsubscribeError = undefined;
			}

			try {
				bridge.rememberClosedAsk(askKey);
			} catch {
				// ignore
			}

			if (acquired) {
				acquired = false;
				try {
					bridge.release();
				} catch {
					// ignore
				}
			}

			resolveResult(answers);
		} catch (err) {
			fail(err);
		}
	}

	const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
	timer = setTimeout(() => {
		timer = undefined;
		try {
			void runFlow();
		} catch (err) {
			fail(err);
		}
	}, safeDelayMs);

	timer.unref?.();

	return {
		result,
		close,
	};
}
