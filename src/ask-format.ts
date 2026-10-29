import type { ToolResult } from "./host.ts";

// =============================================================================
// Ask Types (mirroring @oh-my-pi/pi-coding-agent native ask schema)
// =============================================================================

export interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: AskOption[];
	multi?: boolean;
	recommended?: number;
}

export interface AskParams {
	questions: AskQuestion[];
}

export interface QuestionAnswer {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string | undefined;
}

export interface SingleQuestionDetails {
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string | undefined;
}

export interface MultiQuestionDetails {
	results: QuestionAnswer[];
}

// =============================================================================
// Discord Component Types
// =============================================================================

export interface DiscordButtonComponent {
	type: 2;
	style: number; // 1 = Primary, 2 = Secondary
	label: string;
	custom_id: string;
	disabled?: boolean;
}

export interface DiscordSelectOption {
	label: string;
	value: string;
	description?: string;
	default?: boolean;
}

export interface DiscordSelectComponent {
	type: 3;
	custom_id: string;
	placeholder?: string;
	min_values?: number;
	max_values?: number;
	options: DiscordSelectOption[];
	disabled?: boolean;
}

export type DiscordActionRowComponent = DiscordButtonComponent | DiscordSelectComponent;

export interface DiscordActionRow {
	type: 1;
	components: DiscordActionRowComponent[];
}

export type DiscordTopLevelComponent = DiscordActionRow;

// =============================================================================
// Render & Closure Types
// =============================================================================

export interface RenderQuestionParams {
	askKey: string;
	qIndex: number;
	total: number;
	question: AskQuestion;
	project: string;
}

export interface RenderQuestionResult {
	content: string;
	components: DiscordActionRow[];
}

export type CloseReason = "terminal" | "cancelled" | "shutdown";

// =============================================================================
// Helper Functions
// =============================================================================

function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

function withSuffix(base: string, suffix: string, max: number = 2000): string {
	if (base.length + suffix.length <= max) {
		return `${base}${suffix}`;
	}
	const safeSuffix = suffix.length > max ? truncate(suffix, max) : suffix;
	const available = Math.max(0, max - safeSuffix.length);
	return `${truncate(base, available)}${safeSuffix}`;
}

// =============================================================================
// Formatters (ported from native ask.ts:480-530 without timeout/note branches)
// =============================================================================

export function formatQuestionResult(result: QuestionAnswer): string {
	const custom = result.customInput === undefined ? undefined : `"${result.customInput}"`;
	if (result.selectedOptions.length === 0) {
		if (custom !== undefined) return `${result.id}: ${custom}`;
		return result.multi ? `${result.id}: []` : `${result.id}: (cancelled)`;
	}
	const picked = result.multi ? `[${result.selectedOptions.join(", ")}]` : result.selectedOptions[0];
	const answer = custom === undefined ? picked : `${picked} + ${custom}`;
	return `${result.id}: ${answer}`;
}

export function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: string | undefined;
	multi: boolean;
}): string {
	const responseParts: string[] = [];
	if (result.selectedOptions.length > 0) {
		const selectedText = result.multi
			? `User selected: ${result.selectedOptions.join(", ")}`
			: `User selected: ${result.selectedOptions[0]}`;
		responseParts.push(selectedText);
	}
	if (result.customInput !== undefined) {
		responseParts.push(
			result.customInput.includes("\n")
				? `User provided custom input:\n${result.customInput
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User provided custom input: ${result.customInput}`,
		);
	}
	if (responseParts.length > 0) return responseParts.join("\n");
	return result.multi ? "User did not select any options" : "User cancelled the selection";
}

export function formatAnswers(
	params: AskParams,
	answers: QuestionAnswer[],
): ToolResult<SingleQuestionDetails | MultiQuestionDetails> {
	const isSingle = (params.questions.length === 1 || params.questions.length === 0) && answers.length === 1;

	if (isSingle) {
		const first = answers[0]!;
		const text = `${formatSingleQuestionResponse(first)}\n(Answered remotely via Discord DM.)`;
		const details: SingleQuestionDetails = {
			question: first.question,
			options: first.options,
			multi: first.multi,
			selectedOptions: first.selectedOptions,
			customInput: first.customInput,
		};
		return {
			content: [{ type: "text", text }],
			details,
		};
	}

	const lines = answers.map(formatQuestionResult).join("\n");
	const text = `User answers:\n${lines}\n(Answered remotely via Discord DM.)`;
	const details: MultiQuestionDetails = { results: answers };
	return {
		content: [{ type: "text", text }],
		details,
	};
}

// =============================================================================
// Question Rendering
// =============================================================================

export function renderQuestion(params: RenderQuestionParams): RenderQuestionResult {
	const { askKey, qIndex, total, question, project } = params;
	const isMulti = question.multi ?? false;

	const progress = total > 1 ? ` (${qIndex + 1}/${total})` : "";
	const titleLine = `❓ \`omp · ${project}\`${progress}`;

	const headerPrefix = question.header ? `**${question.header}** ` : "";
	const questionText = truncate(question.question, 1200);
	const questionLine = `${headerPrefix}${questionText}`;

	const optionLines = question.options.map((option, i) => {
		const descSuffix = option.description ? ` — ${option.description}` : "";
		return truncate(`${i + 1}. ${option.label}${descSuffix}`, 180);
	});

	const footer = isMulti
		? `Pick in the menu, or reply with numbers like 1,3 (or "none"), or your own text.`
		: `Tap a button, or reply with a number or your own text.`;

	const lines = [titleLine, questionLine, ...optionLines, footer];
	let content = lines.join("\n");
	if (content.length > 2000) {
		content = content.slice(0, 1999) + "…";
	}

	const components: DiscordActionRow[] = [];

	if (question.options.length >= 1 && question.options.length <= 25) {
		if (isMulti) {
			const selectComponent: DiscordSelectComponent = {
				type: 3,
				custom_id: `lac:${askKey}:${qIndex}:sel`,
				placeholder: "Select options",
				min_values: 0,
				max_values: question.options.length,
				options: question.options.map((option, i) => ({
					label: truncate(option.label, 100),
					value: String(i),
					...(option.description ? { description: truncate(option.description, 100) } : {}),
				})),
			};
			components.push({ type: 1, components: [selectComponent] });
		} else {
			for (let i = 0; i < question.options.length; i += 5) {
				const slice = question.options.slice(i, i + 5);
				const buttons: DiscordButtonComponent[] = slice.map((option, offset) => {
					const index = i + offset;
					return {
						type: 2,
						style: index === question.recommended ? 1 : 2,
						label: truncate(`${index + 1}. ${option.label}`, 80),
						custom_id: `lac:${askKey}:${qIndex}:${index}`,
					};
				});
				components.push({ type: 1, components: buttons });
			}
		}
	}

	return { content, components };
}

// =============================================================================
// Reply Parsing
// =============================================================================

export function parseReply(question: AskQuestion, text: string): QuestionAnswer | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;

	const isMulti = question.multi ?? false;
	const optionLabels = question.options.map(o => o.label);

	// Multi-select: "none" (case-insensitive) -> selectedOptions: []
	if (isMulti && trimmed.toLowerCase() === "none") {
		return {
			id: question.id,
			question: question.question,
			options: optionLabels,
			multi: true,
			selectedOptions: [],
		};
	}

	// Numeric reply check:
	// matches /^\d+(\s*[,\s]\s*\d+)*$/ and every number is in 1..options.length
	if (/^\d+(\s*[,\s]\s*\d+)*$/.test(trimmed)) {
		const numbers = (trimmed.match(/\d+/g) ?? []).map(s => Number.parseInt(s, 10));
		const allInRange = numbers.length > 0 && numbers.every(n => n >= 1 && n <= question.options.length);

		if (allInRange) {
			if (isMulti) {
				// Multi-select deduplicates in option order
				const selectedSet = new Set(numbers);
				const selectedOptions = question.options
					.map((opt, idx) => (selectedSet.has(idx + 1) ? opt.label : undefined))
					.filter((label): label is string => label !== undefined);

				return {
					id: question.id,
					question: question.question,
					options: optionLabels,
					multi: true,
					selectedOptions,
				};
			}

			// Single-select requires exactly one number
			if (numbers.length === 1) {
				const picked = question.options[numbers[0]! - 1]!.label;
				return {
					id: question.id,
					question: question.question,
					options: optionLabels,
					multi: false,
					selectedOptions: [picked],
				};
			}
			// Multi numbers on single-select fall through to anything else
		}
	}

	// Equals an option label (case-insensitive)
	const matchingOption = question.options.find(
		opt => opt.label.trim().toLowerCase() === trimmed.toLowerCase(),
	);
	if (matchingOption !== undefined) {
		return {
			id: question.id,
			question: question.question,
			options: optionLabels,
			multi: isMulti,
			selectedOptions: [matchingOption.label],
		};
	}

	// Anything else -> customInput: text with selectedOptions: []
	return {
		id: question.id,
		question: question.question,
		options: optionLabels,
		multi: isMulti,
		selectedOptions: [],
		customInput: trimmed,
	};
}

// =============================================================================
// Component Interactions & Message Transformations
// =============================================================================

export function answerFromComponent(
	question: AskQuestion,
	customIdTail: string,
	values?: string[],
): QuestionAnswer | undefined {
	const optionLabels = question.options.map(o => o.label);
	const isMulti = question.multi ?? false;

	if (customIdTail === "sel") {
		const rawValues = values ?? [];
		const indices: number[] = [];
		for (const val of rawValues) {
			if (!/^\d+$/.test(val)) return undefined;
			const idx = Number.parseInt(val, 10);
			if (idx < 0 || idx >= question.options.length) return undefined;
			indices.push(idx);
		}

		// Deduplicate and sort by index
		const sortedUnique = Array.from(new Set(indices)).sort((a, b) => a - b);
		const selectedOptions = sortedUnique.map(i => question.options[i]!.label);

		return {
			id: question.id,
			question: question.question,
			options: optionLabels,
			multi: isMulti,
			selectedOptions,
		};
	}

	if (/^\d+$/.test(customIdTail)) {
		const idx = Number.parseInt(customIdTail, 10);
		if (idx < 0 || idx >= question.options.length) return undefined;

		return {
			id: question.id,
			question: question.question,
			options: optionLabels,
			multi: isMulti,
			selectedOptions: [question.options[idx]!.label],
		};
	}

	return undefined;
}

export function answeredContent(openContent: string, answer: QuestionAnswer): string {
	let answerText: string;
	if (answer.selectedOptions.length > 0) {
		answerText = answer.selectedOptions.join(", ");
	} else if (answer.customInput !== undefined) {
		answerText = `"${answer.customInput}"`;
	} else {
		answerText = "(none)";
	}

	const boundedAnswer = truncate(answerText, 1000);
	const suffix = `\n**Answer:** ${boundedAnswer}`;
	const base = openContent.replace(/^❓/, "✅");
	return withSuffix(base, suffix);
}

export function closedContent(openContent: string, reason: CloseReason): string {
	let emoji: string;
	let suffix: string;

	switch (reason) {
		case "terminal":
			emoji = "⌛";
			suffix = "\n_Answered in terminal._";
			break;
		case "cancelled":
			emoji = "✖";
			suffix = "\n_Cancelled._";
			break;
		case "shutdown":
			emoji = "✖";
			suffix = "\n_omp session ended._";
			break;
	}

	const base = openContent.replace(/^❓/, emoji);
	return withSuffix(base, suffix);
}
