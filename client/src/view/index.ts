import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { Message } from "../message";
import { type Model, Phase } from "../model";
import { activityRow, elapsedSeconds } from "./activity";
import { filesPanel } from "./files";
import { transcript } from "./transcript";

type H = HtmlBuilder<Message>;

const statusLabel = (model: Model): { readonly label: string; readonly dot: string; readonly tone: string } =>
	Phase.match(model.phase, {
		Connecting: () => ({ label: "connecting", dot: "bg-faint", tone: "text-dim border-line" }),
		Idle: () => ({ label: "idle", dot: "bg-ok", tone: "text-dim border-line" }),
		Working: () => ({ label: "working", dot: "bg-warn animate-pulse-fast", tone: "text-dim border-line" }),
		Dead: () => ({ label: "dead", dot: "bg-bad", tone: "text-bad border-bad-line" }),
		Reviving: () => ({ label: "coming back", dot: "bg-accent animate-pulse-fast", tone: "text-accent border-accent-line" }),
	});

const isDown = (model: Model): boolean => Phase.isAnyOf(["Dead", "Reviving"])(model.phase);

const button = (h: H, label: string | Html, message: Message, tone: string, disabled = false): Html =>
	h.button(
		[h.Type("button"), h.Disabled(disabled), h.Class(`h-[30px] rounded-lg border px-3 text-[13px] disabled:cursor-default disabled:opacity-40 ${tone}`), h.OnClick(message)],
		[label],
	);

const header = (h: H, model: Model): Html => {
	const status = statusLabel(model);

	return h.header(
		[h.Class("flex items-center gap-4 border-b border-line px-6 py-3")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-3")],
				[
					h.img([h.Src("/img/tardigrade.png"), h.Alt(""), h.Width("32"), h.Height("32"), h.Class("rounded-lg")]),
					h.div(
						[h.Class("min-w-0")],
						[
							h.h1([h.Class("text-[17px] leading-tight font-semibold tracking-tight")], ["tardigrade"]),
							h.p([h.Class("mt-0.5 hidden truncate text-[13px] text-dim sm:block")], ["An AI agent you can kill mid-task. It comes back and finishes the job."]),
						],
					),
				],
			),
			h.div(
				[h.Class("ml-auto flex flex-none items-center gap-2")],
				[
					h.span([h.Class("mr-2 hidden font-mono text-xs text-faint lg:inline")], [model.name]),
					h.span(
						[h.Class("flex items-baseline gap-1.5 px-2 text-xs text-dim")],
						["lives", h.b([h.Id("lives"), h.Class("font-mono text-sm font-medium text-ink")], [String(model.lives)])],
					),
					h.span(
						[h.Id("status"), h.Class(`flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-xs whitespace-nowrap ${status.tone}`)],
						[h.i([h.Class(`size-[7px] rounded-full ${status.dot}`)], []), status.label],
					),
					h.span([h.Class("md:hidden")], [button(h, "Files", Message.ToggledFilesPanel(), "border-line text-ink hover:bg-raised")]),
					button(h, "New", Message.ClickedNew(), "border-line text-ink hover:bg-raised"),
					button(h, "Kill it", Message.ClickedKill(), "border-bad-line text-bad hover:bg-bad-soft", isDown(model) || !model.busy),
				],
			),
		],
	);
};

const activity = (h: H, model: Model): Html => {
	const row = activityRow(model);

	return h.div(
		[
			h.Id("activity"),
			h.Hidden(!row.visible),
			h.Class(`mx-auto mb-2 flex w-full max-w-[740px] items-center gap-2 px-1 text-[13px] ${row.dead ? "text-bad" : "text-dim"}`),
		],
		[
			h.span([h.Class(`size-3 rounded-full border-2 ${row.dead ? "border-bad" : "animate-spin border-accent border-t-transparent"}`)], []),
			h.span([], [row.label]),
			h.span([h.Class("ml-auto font-mono text-xs text-faint")], [`${elapsedSeconds(model)}s`]),
		],
	);
};

const composer = (h: H, model: Model): Html =>
	h.form(
		[h.Class("mx-auto w-full max-w-[740px]"), h.OnSubmit(Message.SubmittedDraft())],
		[
			h.div(
				[h.Class("flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 focus-within:border-accent-line")],
				[
					h.textarea([
						h.Rows(1),
						h.Placeholder("Ask it to build something…"),
						h.Value(model.draft),
						h.Class("max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2 outline-none placeholder:text-faint"),
						h.OnInput((value) => Message.UpdatedDraft({ value })),
						h.OnKeyDownPreventDefault((key, modifiers) =>
							key === "Enter" && !modifiers.shiftKey ? Option.some(Message.SubmittedDraft()) : Option.none(),
						),
					]),
					h.button(
						[
							h.Type("submit"),
							h.Disabled(model.busy || isDown(model)),
							h.Class("h-10 rounded-xl bg-accent px-4 font-medium text-accent-ink disabled:opacity-40"),
						],
						["Send"],
					),
				],
			),
			h.p(
				[h.Class("mt-1.5 text-center text-xs text-faint")],
				[h.kbd([h.Class("font-mono")], ["Enter"]), " to send, ", h.kbd([h.Class("font-mono")], ["Shift + Enter"]), " for a new line"],
			),
		],
	);

export const view = (model: Model, h: H): Document => ({
	title: model.busy ? "tardigrade · working" : "tardigrade",
	body: h.div(
		[h.Class("grid h-full grid-rows-[auto_1fr]")],
		[
			header(h, model),
			h.main(
				[h.Class("grid min-h-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_360px]")],
				[
					h.section(
						[h.Class("grid min-h-0 grid-rows-[1fr_auto]")],
						[h.div([h.Id("log"), h.Class("overflow-y-auto px-6 pt-6 pb-2")], [transcript(h, model)]), h.div([h.Class("px-6 pb-4")], [activity(h, model), composer(h, model)])],
					),
					filesPanel(h, model),
				],
			),
		],
	),
});
