import { describe, expect, it } from "bun:test";
import {
	type AskParams,
	type AskQuestion,
	type QuestionAnswer,
	answerFromComponent,
	answeredContent,
	closedContent,
	formatAnswers,
	parseReply,
	renderQuestion,
} from "../src/ask-format";
import type { ToolResult } from "../src/host";

const SUFFIX = "\n(Answered remotely via Discord DM.)";

function single(options: string[] = ["Alpha", "Beta", "Gamma"], extra: Partial<AskQuestion> = {}): AskQuestion {
	return { id: "q1", question: "Pick one?", options: options.map(label => ({ label })), ...extra };
}

function multi(options: string[] = ["Alpha", "Beta", "Gamma"], extra: Partial<AskQuestion> = {}): AskQuestion {
	return { id: "q1", question: "Pick some?", multi: true, options: options.map(label => ({ label })), ...extra };
}

function manyOptions(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `Option ${i + 1}`);
}

function textOf(result: ToolResult): string {
	expect(result.content).toHaveLength(1);
	const first = result.content[0]!;
	expect(first.type).toBe("text");
	if (first.type === "text" && "text" in first && typeof first.text === "string") {
		return first.text;
	}
	throw new Error(`Expected text block, got ${first.type}`);
}

function answer(q: AskQuestion, selectedOptions: string[], customInput?: string): QuestionAnswer {
	return {
		id: q.id,
		question: q.question,
		options: q.options.map(o => o.label),
		multi: q.multi ?? false,
		selectedOptions,
		...(customInput === undefined ? {} : { customInput }),
	};
}

// Structural view of the rendered Discord payload. The renderer's own component types are not
// required by these assertions, so the test states the Discord wire shape it expects.
interface WireOption {
	label: string;
	value: string;
	description?: string;
}
interface WireComponent {
	type: number;
	custom_id: string;
	style: number;
	label: string;
	placeholder: string;
	min_values: number;
	max_values: number;
	options: WireOption[];
}
interface WireRow {
	type: number;
	components: WireComponent[];
}
function rows(components: unknown): WireRow[] {
	// Reason: components are validated field-by-field by the assertions below.
	return components as unknown as WireRow[];
}

describe("parseReply", () => {
	it("maps a single number to that option (single-select)", () => {
		const a = parseReply(single(), "2");
		expect(a?.selectedOptions).toEqual(["Beta"]);
		expect(a?.customInput).toBeUndefined();
		expect(a?.id).toBe("q1");
		expect(a?.multi).toBe(false);
		expect(a?.options).toEqual(["Alpha", "Beta", "Gamma"]);
	});

	it("maps a single number to that option (multi-select)", () => {
		const a = parseReply(multi(), "3");
		expect(a?.selectedOptions).toEqual(["Gamma"]);
		expect(a?.multi).toBe(true);
	});

	it("accepts the first and last valid numbers", () => {
		expect(parseReply(single(), "1")?.selectedOptions).toEqual(["Alpha"]);
		expect(parseReply(single(), "3")?.selectedOptions).toEqual(["Gamma"]);
	});

	it("treats out-of-range numbers as custom input", () => {
		for (const text of ["0", "4"]) {
			const a = parseReply(single(), text);
			expect(a?.selectedOptions).toEqual([]);
			expect(a?.customInput).toBe(text);
		}
		for (const text of ["0", "4"]) {
			const a = parseReply(multi(), text);
			expect(a?.selectedOptions).toEqual([]);
			expect(a?.customInput).toBe(text);
		}
	});

	it("treats a list with any out-of-range number as custom input on multi-select", () => {
		const a = parseReply(multi(), "1, 4");
		expect(a?.selectedOptions).toEqual([]);
		expect(a?.customInput).toBe("1, 4");
	});

	it("selects several numbers in option order, deduplicated, on multi-select", () => {
		expect(parseReply(multi(), "1, 3")?.selectedOptions).toEqual(["Alpha", "Gamma"]);
		expect(parseReply(multi(), "1,3")?.selectedOptions).toEqual(["Alpha", "Gamma"]);
		expect(parseReply(multi(), "3,1")?.selectedOptions).toEqual(["Alpha", "Gamma"]);
		expect(parseReply(multi(), "3, 1, 3, 1")?.selectedOptions).toEqual(["Alpha", "Gamma"]);
		expect(parseReply(multi(), "2 , 1")?.selectedOptions).toEqual(["Alpha", "Beta"]);
		expect(parseReply(multi(), "1 3")?.selectedOptions).toEqual(["Alpha", "Gamma"]);
		expect(parseReply(multi(), "1, 3")?.customInput).toBeUndefined();
	});

	it("treats multiple numbers on single-select as custom input", () => {
		for (const text of ["1,3", "1, 3", "1 3"]) {
			const a = parseReply(single(), text);
			expect(a?.selectedOptions).toEqual([]);
			expect(a?.customInput).toBe(text);
		}
	});

	it("accepts none (any case) on multi-select as an empty selection", () => {
		for (const text of ["none", "NONE", "None", "  nOnE  "]) {
			const a = parseReply(multi(), text);
			expect(a?.selectedOptions).toEqual([]);
			expect(a?.customInput).toBeUndefined();
			expect(a?.multi).toBe(true);
		}
	});

	it("treats none on single-select as custom input", () => {
		const a = parseReply(single(), "none");
		expect(a?.selectedOptions).toEqual([]);
		expect(a?.customInput).toBe("none");
	});

	it("matches option labels case-insensitively", () => {
		expect(parseReply(single(), "beta")?.selectedOptions).toEqual(["Beta"]);
		expect(parseReply(single(), "GAMMA")?.selectedOptions).toEqual(["Gamma"]);
		expect(parseReply(single(), "  aLpHa ")?.selectedOptions).toEqual(["Alpha"]);
		expect(parseReply(single(), "beta")?.customInput).toBeUndefined();
		expect(parseReply(multi(), "gamma")?.selectedOptions).toEqual(["Gamma"]);
	});

	it("returns undefined for empty or whitespace-only text", () => {
		expect(parseReply(single(), "")).toBeUndefined();
		expect(parseReply(single(), "   ")).toBeUndefined();
		expect(parseReply(single(), "\n\t \n")).toBeUndefined();
		expect(parseReply(multi(), "  ")).toBeUndefined();
	});

	it("passes other text through as trimmed custom input", () => {
		const a = parseReply(single(), "  something else entirely  ");
		expect(a?.selectedOptions).toEqual([]);
		expect(a?.customInput).toBe("something else entirely");
	});

	it("keeps multi-line custom input intact", () => {
		const a = parseReply(single(), "line one\nline two");
		expect(a?.selectedOptions).toEqual([]);
		expect(a?.customInput).toBe("line one\nline two");
	});

	it("does not treat partially numeric text as a selection", () => {
		for (const text of ["1.", "1,", "2nd", "1,a", "-1", "1;2"]) {
			const a = parseReply(multi(), text);
			expect(a?.selectedOptions).toEqual([]);
			expect(a?.customInput).toBe(text);
		}
	});

	it("prefers a numeric selection over a numeric-looking label only when in range", () => {
		const q = single(["10", "20"]);
		expect(parseReply(q, "1")?.selectedOptions).toEqual(["10"]);
		expect(parseReply(q, "20")?.selectedOptions).toEqual(["20"]);
		expect(parseReply(q, "3")?.customInput).toBe("3");
	});
});

describe("answerFromComponent", () => {
	it("maps a button tail to the option label", () => {
		const a = answerFromComponent(single(), "1");
		expect(a?.selectedOptions).toEqual(["Beta"]);
		expect(a?.id).toBe("q1");
		expect(a?.multi).toBe(false);
		expect(answerFromComponent(single(), "0")?.selectedOptions).toEqual(["Alpha"]);
		expect(answerFromComponent(single(), "2")?.selectedOptions).toEqual(["Gamma"]);
	});

	it("maps select values to labels sorted by index and deduplicated", () => {
		expect(answerFromComponent(multi(), "sel", ["2", "0"])?.selectedOptions).toEqual(["Alpha", "Gamma"]);
		expect(answerFromComponent(multi(), "sel", ["1", "1"])?.selectedOptions).toEqual(["Beta"]);
		expect(answerFromComponent(multi(), "sel", ["1"])?.multi).toBe(true);
	});

	it("allows an empty select selection", () => {
		expect(answerFromComponent(multi(), "sel", [])?.selectedOptions).toEqual([]);
	});

	it("rejects invalid indices", () => {
		expect(answerFromComponent(single(), "3")).toBeUndefined();
		expect(answerFromComponent(single(), "99")).toBeUndefined();
		expect(answerFromComponent(single(), "-1")).toBeUndefined();
		expect(answerFromComponent(single(), "abc")).toBeUndefined();
		expect(answerFromComponent(single(), "")).toBeUndefined();
		expect(answerFromComponent(multi(), "sel", ["0", "3"])).toBeUndefined();
		expect(answerFromComponent(multi(), "sel", ["x"])).toBeUndefined();
	});
});

describe("formatAnswers (single question)", () => {
	it("formats a single-select choice like native ask plus the remote suffix", () => {
		const q = single(["A", "B"]);
		const params: AskParams = { questions: [q] };
		const result = formatAnswers(params, [answer(q, ["A"])]);
		expect(textOf(result)).toBe(`User selected: A${SUFFIX}`);
		expect(result.details).toEqual({
			question: q.question,
			options: ["A", "B"],
			multi: false,
			selectedOptions: ["A"],
			customInput: undefined,
		});
		expect(result.details).toMatchObject({ selectedOptions: ["A"] });
	});

	it("formats a multi-select choice with comma-joined labels", () => {
		const q = multi(["A", "B", "C"]);
		const result = formatAnswers({ questions: [q] }, [answer(q, ["A", "C"])]);
		expect(textOf(result)).toBe(`User selected: A, C${SUFFIX}`);
		expect(result.details).toEqual({
			question: q.question,
			options: ["A", "B", "C"],
			multi: true,
			selectedOptions: ["A", "C"],
			customInput: undefined,
		});
	});

	it("formats single-line custom input", () => {
		const q = single(["A", "B"]);
		const result = formatAnswers({ questions: [q] }, [answer(q, [], "something else")]);
		expect(textOf(result)).toBe(`User provided custom input: something else${SUFFIX}`);
		expect(result.details).toEqual({
			question: q.question,
			options: ["A", "B"],
			multi: false,
			selectedOptions: [],
			customInput: "something else",
		});
	});

	it("indents multi-line custom input by two spaces per line", () => {
		const q = single(["A", "B"]);
		const result = formatAnswers({ questions: [q] }, [answer(q, [], "first\nsecond\n\nfourth")]);
		expect(textOf(result)).toBe(`User provided custom input:\n  first\n  second\n  \n  fourth${SUFFIX}`);
	});

	it("joins a selection and custom input on separate lines", () => {
		const q = single(["A", "B"]);
		const result = formatAnswers({ questions: [q] }, [answer(q, ["B"], "plus this")]);
		expect(textOf(result)).toBe(`User selected: B\nUser provided custom input: plus this${SUFFIX}`);
	});

	it("reports no selection on single-select as cancelled", () => {
		const q = single(["A", "B"]);
		const result = formatAnswers({ questions: [q] }, [answer(q, [])]);
		expect(textOf(result)).toBe(`User cancelled the selection${SUFFIX}`);
	});

	it("reports no selection on multi-select as none selected", () => {
		const q = multi(["A", "B"]);
		const result = formatAnswers({ questions: [q] }, [answer(q, [])]);
		expect(textOf(result)).toBe(`User did not select any options${SUFFIX}`);
		expect(result.details).toMatchObject({ selectedOptions: [] });
	});
});

describe("formatAnswers (several questions)", () => {
	const q1 = single(["A", "B"], { id: "first" });
	const q2 = multi(["X", "Y", "Z"], { id: "second" });
	const q3 = single(["P", "Q"], { id: "third" });
	const q4 = multi(["M", "N"], { id: "fourth" });
	const q5 = single(["R", "S"], { id: "fifth" });
	const q6 = multi(["U", "V"], { id: "sixth" });

	it("lists one line per question under a User answers header with the suffix", () => {
		const answers = [
			answer(q1, ["A"]),
			answer(q2, ["X", "Z"]),
			answer(q3, [], "my own"),
			answer(q4, []),
			answer(q5, []),
			answer(q6, ["V"], "extra"),
		];
		const params: AskParams = { questions: [q1, q2, q3, q4, q5, q6] };
		const result = formatAnswers(params, answers);
		expect(textOf(result)).toBe(
			[
				"User answers:",
				"first: A",
				"second: [X, Z]",
				'third: "my own"',
				"fourth: []",
				"fifth: (cancelled)",
				'sixth: [V] + "extra"',
			].join("\n") + SUFFIX,
		);
		expect(result.details).toEqual({ results: answers });
	});

	it("combines a single-select pick with custom input using a plus sign", () => {
		const answers = [answer(q1, ["B"], "but also"), answer(q3, ["P"])];
		const result = formatAnswers({ questions: [q1, q3] }, answers);
		expect(textOf(result)).toBe(`User answers:\nfirst: B + "but also"\nthird: P${SUFFIX}`);
		expect(result.details).toEqual({ results: answers });
	});
});

describe("renderQuestion", () => {
	const base = { askKey: "abcd1234", qIndex: 0, total: 1, project: "myproj" };

	it("renders the open marker, project, header, question, options and single-select footer", () => {
		const q = single(["Alpha", "Beta"], {
			header: "Heads up",
			question: "Which one?",
			options: [{ label: "Alpha", description: "first" }, { label: "Beta" }],
		});
		const { content } = renderQuestion({ ...base, question: q });
		expect(content.startsWith("❓")).toBe(true);
		const lines = content.split("\n");
		expect(lines[0]).toMatch(/omp.*myproj/);
		expect(lines[0]).not.toContain("(1/1)");
		expect(content).toContain("**Heads up** Which one?");
		expect(content).toContain("1. Alpha — first");
		expect(content).toContain("2. Beta");
		expect(content).not.toContain("2. Beta —");
		expect(lines[lines.length - 1]).toBe("Tap a button, or reply with a number or your own text.");
	});

	it("shows the question counter only when there are several questions", () => {
		const q = single();
		const one = renderQuestion({ ...base, question: q }).content;
		const many = renderQuestion({ ...base, qIndex: 1, total: 3, question: q }).content;
		expect(one.split("\n")[0]).not.toMatch(/\(\d+\/\d+\)/);
		expect(many.split("\n")[0]).toContain("(2/3)");
	});

	it("uses the multi-select footer", () => {
		const { content } = renderQuestion({ ...base, question: multi() });
		const lines = content.split("\n");
		expect(lines[lines.length - 1]).toBe(
			'Pick in the menu, or reply with numbers like 1,3 (or "none"), or your own text.',
		);
	});

	it("truncates the question text to 1200 characters", () => {
		const q = single(["A", "B"], { question: "Q".repeat(3000) });
		const { content } = renderQuestion({ ...base, question: q });
		const run = content.match(/Q+/)![0];
		expect(run.length).toBeLessThanOrEqual(1200);
		expect(run.length).toBeGreaterThan(1100);
		expect(content.length).toBeLessThanOrEqual(2000);
	});

	it("truncates each option line to 180 characters", () => {
		const q = single(["A", "B"], {
			options: [{ label: "L".repeat(400), description: "D".repeat(400) }, { label: "B" }],
		});
		const { content } = renderQuestion({ ...base, question: q });
		const line = content.split("\n").find(l => l.startsWith("1. "))!;
		expect(line.length).toBeLessThanOrEqual(180);
		expect(line.length).toBeGreaterThan(100);
		expect(content).toContain("2. B");
	});

	it("hard-caps content at 2000 characters ending with an ellipsis", () => {
		const q = single(manyOptions(25), {
			options: manyOptions(25).map(label => ({ label: label + "x".repeat(300) })),
			question: "Q".repeat(1500),
		});
		const { content } = renderQuestion({ ...base, question: q });
		expect(content.length).toBe(2000);
		expect(content.endsWith("…")).toBe(true);
	});

	it("builds one button per option with numbered labels and custom ids", () => {
		const { components } = renderQuestion({ ...base, qIndex: 2, total: 3, question: single(["Alpha", "Beta", "Gamma"]) });
		const r = rows(components);
		expect(r).toHaveLength(1);
		expect(r[0]!.type).toBe(1);
		expect(r[0]!.components).toHaveLength(3);
		r[0]!.components.forEach((button, i) => {
			expect(button.type).toBe(2);
			expect(button.custom_id).toBe(`lac:abcd1234:2:${i}`);
			expect(button.style).toBe(2);
		});
		expect(r[0]!.components.map(b => b.label)).toEqual(["1. Alpha", "2. Beta", "3. Gamma"]);
	});

	it("highlights the recommended option with the primary style", () => {
		const { components } = renderQuestion({ ...base, question: single(["A", "B", "C"], { recommended: 1 }) });
		const styles = rows(components)[0]!.components.map(b => b.style);
		expect(styles).toEqual([2, 1, 2]);
	});

	it("highlights a recommended option at index 0", () => {
		const { components } = renderQuestion({ ...base, question: single(["A", "B"], { recommended: 0 }) });
		const styles = rows(components)[0]!.components.map(b => b.style);
		expect(styles).toEqual([1, 2]);
	});

	it("splits buttons into rows of at most five", () => {
		const { components } = renderQuestion({ ...base, question: single(manyOptions(7)) });
		const r = rows(components);
		expect(r.map(row => row.type)).toEqual([1, 1]);
		expect(r.map(row => row.components.length)).toEqual([5, 2]);
		expect(r[1]!.components[0]!.custom_id).toBe("lac:abcd1234:0:5");
	});

	it("fits exactly 25 options in five full rows", () => {
		const { components } = renderQuestion({ ...base, question: single(manyOptions(25)) });
		const r = rows(components);
		expect(r).toHaveLength(5);
		expect(r.every(row => row.components.length === 5)).toBe(true);
	});

	it("truncates long button labels to 80 characters", () => {
		const q = single(["short"], { options: [{ label: "W".repeat(300) }] });
		const { components } = renderQuestion({ ...base, question: q });
		const label = rows(components)[0]!.components[0]!.label;
		expect(label.startsWith("1. W")).toBe(true);
		expect(label.length).toBeLessThanOrEqual(80);
	});

	it("keeps every custom_id within 100 characters", () => {
		const { components } = renderQuestion({
			...base,
			askKey: "abcd1234",
			qIndex: 99,
			total: 100,
			question: single(manyOptions(25)),
		});
		for (const row of rows(components)) {
			for (const c of row.components) expect(c.custom_id.length).toBeLessThanOrEqual(100);
		}
	});

	it("builds a single select menu for multi-select questions", () => {
		const q = multi(["Alpha", "Beta", "Gamma"], {
			options: [{ label: "Alpha", description: "first" }, { label: "Beta" }, { label: "Gamma" }],
		});
		const { components } = renderQuestion({ ...base, qIndex: 1, total: 2, question: q });
		const r = rows(components);
		expect(r).toHaveLength(1);
		expect(r[0]!.type).toBe(1);
		expect(r[0]!.components).toHaveLength(1);
		const select = r[0]!.components[0]!;
		expect(select.type).toBe(3);
		expect(select.custom_id).toBe("lac:abcd1234:1:sel");
		expect(select.placeholder).toBe("Select options");
		expect(select.min_values).toBe(0);
		expect(select.max_values).toBe(3);
		expect(select.options.map(o => o.value)).toEqual(["0", "1", "2"]);
		expect(select.options.map(o => o.label)).toEqual(["Alpha", "Beta", "Gamma"]);
		expect(select.options[0]!.description).toBe("first");
		expect(select.options[1]!.description).toBeUndefined();
	});

	it("truncates select labels and descriptions to 100 characters", () => {
		const q = multi(["x"], { options: [{ label: "L".repeat(300), description: "D".repeat(300) }, { label: "B" }] });
		const { components } = renderQuestion({ ...base, question: q });
		const select = rows(components)[0]!.components[0]!;
		expect(select.options[0]!.label.length).toBeLessThanOrEqual(100);
		expect(select.options[0]!.description!.length).toBeLessThanOrEqual(100);
		expect(select.max_values).toBe(2);
	});

	it("allows a select with exactly 25 options", () => {
		const { components } = renderQuestion({ ...base, question: multi(manyOptions(25)) });
		const select = rows(components)[0]!.components[0]!;
		expect(select.options).toHaveLength(25);
		expect(select.max_values).toBe(25);
	});

	it("sends no components for more than 25 options, single or multi", () => {
		expect(renderQuestion({ ...base, question: single(manyOptions(26)) }).components).toEqual([]);
		expect(renderQuestion({ ...base, question: multi(manyOptions(26)) }).components).toEqual([]);
	});

	it("still lists all options in the text when there are no components", () => {
		const { content } = renderQuestion({ ...base, question: single(manyOptions(26)) });
		expect(content).toContain("1. Option 1");
		expect(content.length).toBeLessThanOrEqual(2000);
	});

	it("sends no components when there are no options", () => {
		const q: AskQuestion = { id: "q", question: "Free text?", options: [] };
		expect(renderQuestion({ ...base, question: q }).components).toEqual([]);
	});
});

describe("answeredContent and closedContent", () => {
	const q = single(["Alpha", "Beta"]);
	const open = renderQuestion({ askKey: "k", qIndex: 0, total: 1, question: q, project: "proj" }).content;

	it("swaps the marker to a check and appends the selected labels", () => {
		const out = answeredContent(open, answer(q, ["Beta"]));
		expect(out.startsWith("✅")).toBe(true);
		expect(out.slice(1)).toBe(open.slice(1) + "\n**Answer:** Beta");
	});

	it("joins multiple labels with a comma", () => {
		const m = multi(["A", "B", "C"]);
		const out = answeredContent(open, answer(m, ["A", "C"]));
		expect(out.endsWith("\n**Answer:** A, C")).toBe(true);
	});

	it("quotes custom input", () => {
		const out = answeredContent(open, answer(q, [], "my text"));
		expect(out.endsWith('\n**Answer:** "my text"')).toBe(true);
	});

	it("shows (none) for an empty answer", () => {
		const out = answeredContent(open, answer(multi(), []));
		expect(out.endsWith("\n**Answer:** (none)")).toBe(true);
	});

	it("marks terminal, cancelled and shutdown closures", () => {
		const terminal = closedContent(open, "terminal");
		expect(terminal.startsWith("⌛")).toBe(true);
		expect(terminal.endsWith("\n_Answered in terminal._")).toBe(true);
		expect(terminal.slice(1)).toBe(open.slice(1) + "\n_Answered in terminal._");

		const cancelled = closedContent(open, "cancelled");
		expect(cancelled.startsWith("✖")).toBe(true);
		expect(cancelled.endsWith("\n_Cancelled._")).toBe(true);

		const shutdown = closedContent(open, "shutdown");
		expect(shutdown.startsWith("✖")).toBe(true);
		expect(shutdown.endsWith("\n_omp session ended._")).toBe(true);
	});

	it("caps answeredContent at 2000 chars for long open content with long custom input", () => {
		const longQuestion = single(Array.from({ length: 10 }, (_, i) => `${i}: ${"O".repeat(100)}`), {
			question: "Q".repeat(1500),
		});
		const longOpen = renderQuestion({
			askKey: "key",
			qIndex: 0,
			total: 1,
			question: longQuestion,
			project: "proj".repeat(20),
		}).content;
		expect(longOpen.length).toBe(2000);

		const longCustom = "A".repeat(2500);
		const out = answeredContent(longOpen, answer(longQuestion, [], longCustom));

		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out.startsWith("✅")).toBe(true);
		expect(out).toContain('\n**Answer:** "AAAA');
		expect(out.endsWith("…")).toBe(true);
	});

	it("caps answeredContent at 2000 chars for long open content with 25 long multi-select labels", () => {
		const labels = Array.from({ length: 25 }, (_, i) => `Option ${i + 1} - ${"X".repeat(80)}`);
		const longMultiQuestion = multi(labels, {
			question: "Select all that apply:\n" + "M".repeat(1200),
		});
		const longOpen = renderQuestion({
			askKey: "key",
			qIndex: 0,
			total: 1,
			question: longMultiQuestion,
			project: "multi-project",
		}).content;
		expect(longOpen.length).toBe(2000);

		const out = answeredContent(longOpen, answer(longMultiQuestion, labels));

		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out.startsWith("✅")).toBe(true);
		expect(out).toContain("\n**Answer:** Option 1 - ");
		expect(out.endsWith("…")).toBe(true);
	});

	it("caps closedContent at 2000 chars preserving leading emoji and closure reason suffix", () => {
		const longQuestion = single(Array.from({ length: 10 }, (_, i) => `${i}: ${"O".repeat(100)}`), {
			question: "Q".repeat(2000),
		});
		const longOpen = renderQuestion({
			askKey: "key",
			qIndex: 0,
			total: 1,
			question: longQuestion,
			project: "proj",
		}).content;
		expect(longOpen.length).toBe(2000);

		const terminal = closedContent(longOpen, "terminal");
		expect(terminal.length).toBeLessThanOrEqual(2000);
		expect(terminal.startsWith("⌛")).toBe(true);
		expect(terminal.endsWith("\n_Answered in terminal._")).toBe(true);

		const cancelled = closedContent(longOpen, "cancelled");
		expect(cancelled.length).toBeLessThanOrEqual(2000);
		expect(cancelled.startsWith("✖")).toBe(true);
		expect(cancelled.endsWith("\n_Cancelled._")).toBe(true);

		const shutdown = closedContent(longOpen, "shutdown");
		expect(shutdown.length).toBeLessThanOrEqual(2000);
		expect(shutdown.startsWith("✖")).toBe(true);
		expect(shutdown.endsWith("\n_omp session ended._")).toBe(true);
	});

	it("caps raw 2000-char string input preserving emoji and suffix", () => {
		const rawOpen = "❓" + "X".repeat(1999);
		const out = answeredContent(rawOpen, answer(q, ["Beta"]));
		expect(out.length).toBeLessThanOrEqual(2000);
		expect(out.startsWith("✅")).toBe(true);
		expect(out.endsWith("\n**Answer:** Beta")).toBe(true);

		const closed = closedContent(rawOpen, "terminal");
		expect(closed.length).toBeLessThanOrEqual(2000);
		expect(closed.startsWith("⌛")).toBe(true);
		expect(closed.endsWith("\n_Answered in terminal._")).toBe(true);
	});
});
