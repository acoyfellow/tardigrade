import { Array as Arr, Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { ToolBlock } from "../../../shared/protocol";
import { Message } from "../message";
import { type Model, OpenFile } from "../model";
import { kilobytes } from "./transcript";

type H = HtmlBuilder<Message>;

const LIVE_FILE_TAIL = 1800;

const heading = (h: H, label: string, aside: string): Html =>
	h.div(
		[h.Class("flex items-baseline justify-between px-4 pt-6 pb-2")],
		[h.h2([h.Class("text-[13px] font-semibold")], [label]), h.span([h.Class("text-[12px] text-faint")], [aside])],
	);

const writingNow = (model: Model): Option.Option<ToolBlock> =>
	Option.flatMap(model.live, (live) =>
		Option.filter(Option.fromNullishOr(live.blocks.at(-1)), (block): block is ToolBlock => Predicate.isTagged(block, "Tool") && block.name === "write_file" && Option.isNone(block.result)),
	);

const liveFile = (h: H, block: ToolBlock): Html =>
	h.div(
		[h.Class("mx-3 mb-2 overflow-hidden rounded-md border border-line-strong bg-bg")],
		[
			h.div(
				[h.Class("flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]")],
				[
					h.span([h.Class("size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-ink"), h.AriaHidden(true)], []),
					h.span([h.Class("font-mono")], [block.path === "" ? "file" : block.path]),
					h.span([h.Class("text-faint")], ["writing"]),
					h.span([h.Class("ml-auto text-faint")], [kilobytes(block.draft.length)]),
				],
			),
			h.pre([h.Class("max-h-64 overflow-auto p-3 font-mono text-[12px] whitespace-pre-wrap text-dim")], [block.draft.slice(-LIVE_FILE_TAIL)]),
		],
	);

const viewerBody = (model: Model, path: string): Option.Option<string> =>
	OpenFile.match(model.openFile, {
		Closed: () => Option.none(),
		Loading: (open) => (open.path === path ? Option.some("loading…") : Option.none()),
		Loaded: (open) => (open.path === path ? Option.some(open.body) : Option.none()),
	});

const fileRow = (h: H, model: Model, path: string): ReadonlyArray<Html> => {
	const body = viewerBody(model, path);

	return [
		h.button(
			[
				h.Type("button"),
				h.Class(`block w-full truncate px-4 py-1.5 text-left font-mono text-[12px] hover:bg-raised ${Option.isSome(body) ? "bg-raised font-medium" : ""}`),
				h.AriaExpanded(Option.isSome(body)),
				h.OnClick(Message.ClickedFile({ path })),
			],
			[path],
		),
		...Option.match(body, {
			onNone: () => [],
			onSome: (text) => [h.pre([h.Class("mx-3 my-1 max-h-80 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[12px] whitespace-pre-wrap text-dim")], [text])],
		}),
	];
};

const commitRow = (h: H, commit: Model["commits"][number]): Html =>
	h.div(
		[h.Class("grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-1.5 text-[13px]")],
		[
			h.code([h.Class("font-mono text-[12px] text-faint")], [commit.oid.slice(0, 7)]),
			h.span([h.Class("truncate")], [commit.message]),
			h.span([h.Class("font-mono text-[12px] text-faint")], [new Date(commit.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })]),
		],
	);

const none = (h: H, text: string): Html => h.div([h.Class("px-4 py-1.5 text-[13px] text-faint")], [text]);

export const filesPanel = (h: H, model: Model): Html => {
	const writing = writingNow(model);
	const commitCount = model.commits.length;

	return h.aside(
		[
			h.Class(
				`${model.filesPanelOpen ? "fixed inset-0 top-14 z-10 block" : "hidden"} overflow-y-auto border-l border-line bg-panel md:static md:block`,
			),
			h.AriaLabel("Files and history"),
		],
		[
			heading(h, "Files", ""),
			...Option.match(writing, { onNone: () => [], onSome: (block) => [liveFile(h, block)] }),
			...(Arr.isReadonlyArrayEmpty(model.files) ? (Option.isNone(writing) ? [none(h, "No files yet.")] : []) : model.files.flatMap((path) => fileRow(h, model, path))),
			heading(h, "Commits", commitCount === 0 ? "" : String(commitCount)),
			...(commitCount === 0 ? [none(h, "Nothing committed yet.")] : model.commits.map((commit) => commitRow(h, commit))),
		],
	);
};
