import { Array as Arr, Match, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Block, ToolBlock } from "../../../shared/protocol";
import { Message } from "../message";
import { Event, EXAMPLES, type Model, type PlacedEvent } from "../model";

type H = HtmlBuilder<Message>;

const LIVE_THOUGHT_TAIL = 700;

const tail = (text: string, size: number): string => (text.length > size ? `…${text.slice(-size)}` : text);

export const kilobytes = (size: number): string => (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`);

const bubble = (h: H, text: string, mine: boolean): Html =>
	h.div(
		[h.Class(mine ? "flex justify-end" : "flex")],
		[
			h.div(
				[
					h.Class(
						mine
							? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-accent-line bg-accent-soft px-4 py-2.5"
							: "max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-line bg-panel px-4 py-2.5",
					),
				],
				[text],
			),
		],
	);

const thought = (h: H, model: Model, key: string, text: string, live: boolean): Html => {
	const open = live || model.openThoughts.includes(key);

	return h.div(
		[h.Class("cursor-pointer select-none text-[13px] text-faint"), ...(live ? [] : [h.OnClick(Message.ToggledThought({ key }))])],
		[
			live ? "Thinking" : "Thought",
			...(open
				? [h.pre([h.Class("mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 font-mono text-xs text-dim")], [live ? tail(text, LIVE_THOUGHT_TAIL) : text])]
				: []),
		],
	);
};

const toolDot = (block: ToolBlock, live: boolean): string =>
	Option.match(block.result, {
		onNone: () => (live ? "bg-warn animate-pulse-fast" : "bg-faint"),
		onSome: ({ isError }) => (isError ? "bg-bad" : "bg-ok"),
	});

const pendingOutcome = (block: ToolBlock, live: boolean): string => {
	if (!live) return "no result: cut off, ran again";

	return block.draft === "" ? "…" : kilobytes(block.draft.length);
};

const toolRow = (h: H, block: ToolBlock, live: boolean): Html => {
	const outcome = Option.match(block.result, {
		onNone: () => pendingOutcome(block, live),
		onSome: ({ line }) => line,
	});

	return h.div(
		[h.Class("flex items-baseline gap-2 font-mono text-[13px] text-dim")],
		[
			h.i([h.Class(`inline-block size-1.5 flex-none translate-y-[-1px] rounded-full ${toolDot(block, live)}`)], []),
			h.span([h.Class("text-ink")], [block.name]),
			h.span([h.Class("truncate text-faint")], [block.path]),
			h.span([h.Class("ml-auto max-w-[45%] truncate text-faint"), h.Title(outcome)], [outcome]),
		],
	);
};

const blockView = (h: H, model: Model, block: Block, key: string, live: boolean): Html =>
	Match.value(block).pipe(
		Match.tagsExhaustive({
			UserText: ({ text }) => bubble(h, text, true),
			Reply: ({ text }) => bubble(h, text, false),
			Thought: ({ text }) => thought(h, model, key, text, live),
			Tool: (tool) => toolRow(h, tool, live),
		}),
	);

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const eventView = (h: H, { event }: PlacedEvent): Html =>
	Event.match(event, {
		Killed: ({ wasBusy }) =>
			h.div(
				[h.Class("rounded-xl border border-bad-line bg-bad-soft px-4 py-2.5 text-sm text-bad")],
				[`Killed. The Durable Object was aborted${wasBusy ? " in the middle of the task." : "."}`],
			),
		Back: ({ afterMs, lives, resumed }) =>
			h.div(
				[h.Class("rounded-xl border border-accent-line bg-accent-soft px-4 py-2.5 text-sm text-accent")],
				[`Back after ${seconds(afterMs)}s.${resumed ? ` Life #${lives}, resuming where it left off.` : " Nothing was running, so nothing to resume."}`],
			),
		Failed: ({ reason }) => h.div([h.Class("rounded-xl border border-bad-line px-4 py-2.5 text-sm text-bad")], [reason]),
	});

const emptyState = (h: H): Html =>
	h.div(
		[h.Class("mx-auto flex max-w-xl flex-col items-center pt-16 text-center")],
		[
			h.img([h.Src("/img/tardigrade.png"), h.Alt(""), h.Width("48"), h.Height("48"), h.Class("rounded-xl")]),
			h.h2([h.Class("mt-4 text-2xl font-semibold tracking-tight")], ["Give it a task, then kill it"]),
			h.p(
				[h.Class("mt-2 text-dim")],
				["Every step is checkpointed in a Durable Object and every file is a git commit, so a dead agent picks up where it stopped."],
			),
			h.ol(
				[h.Class("mt-6 grid w-full grid-cols-3 gap-2 text-left text-sm text-dim")],
				[
					["Ask", " for something that takes a few steps."],
					["Kill it", " while it is working."],
					["Watch", " it come back and finish."],
				].map(([verb, rest], index) =>
					h.li(
						[h.Class("rounded-xl border border-line bg-panel p-3")],
						[h.div([h.Class("text-xs text-accent")], [String(index + 1)]), h.b([h.Class("text-ink")], [verb ?? ""]), rest ?? ""],
					),
				),
			),
			h.div(
				[h.Class("mt-6 flex w-full flex-col gap-2")],
				EXAMPLES.map((example) =>
					h.button(
						[
							h.Type("button"),
							h.Class("flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-3 text-left hover:border-accent-line hover:bg-raised"),
							h.OnClick(Message.ClickedExample({ text: example })),
						],
						[example, h.span([h.Class("text-faint")], ["→"])],
					),
				),
			),
		],
	);

export const transcript = (h: H, model: Model): Html => {
	const liveBlocks = Option.match(model.live, { onNone: () => [], onSome: (live) => live.blocks });

	if (Arr.isReadonlyArrayEmpty(model.blocks) && Arr.isReadonlyArrayEmpty(model.events) && Arr.isReadonlyArrayEmpty(liveBlocks)) return emptyState(h);

	const settled = model.blocks.flatMap((block, index) => [
		...model.events.filter((placed) => placed.afterBlock === index).map((placed) => eventView(h, placed)),
		blockView(h, model, block, String(index), false),
	]);

	const trailing = model.events.filter((placed) => placed.afterBlock >= model.blocks.length).map((placed) => eventView(h, placed));
	const streaming = liveBlocks.map((block, index) => blockView(h, model, block, `live.${index}`, true));

	return h.div([h.Class("mx-auto flex max-w-[740px] flex-col gap-3.5")], [...settled, ...trailing, ...streaming]);
};
