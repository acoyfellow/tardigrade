import { Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { Message } from "../message";
import { type Model, Phase } from "../model";
import { activityRow, elapsedSeconds } from "./activity";
import { filesPanel } from "./files";
import { transcript } from "./transcript";

type H = HtmlBuilder<Message>;

type Status = { readonly label: string; readonly tone: string; readonly mark: string };

const statusOf = (model: Model): Status =>
	Phase.match(model.phase, {
		Connecting: () => ({ label: "Connecting", tone: "text-faint", mark: "bg-faint" }),
		Idle: () => ({ label: "Idle", tone: "text-dim", mark: "bg-ok" }),
		Working: () => ({ label: "Working", tone: "text-ink", mark: "bg-ink" }),
		Dead: () => ({ label: "Killed", tone: "text-bad", mark: "bg-bad" }),
		Reviving: () => ({ label: "Coming back", tone: "text-life", mark: "bg-life" }),
	});

const isDown = (model: Model): boolean => Phase.isAnyOf(["Dead", "Reviving"])(model.phase);

const BUTTON = "h-8 rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const SECONDARY = `${BUTTON} border border-line-strong bg-bg text-ink hover:bg-raised`;

const DANGER = `${BUTTON} border border-bad-line bg-bg text-bad hover:bg-bad-soft`;

const button = (h: H, label: string | Html, message: Message, style: string, disabled = false): Html =>
	h.button([h.Type("button"), h.Disabled(disabled), h.Class(style), h.OnClick(message)], [label]);

const divider = (h: H): Html => h.span([h.Class("h-4 w-px bg-line-strong"), h.AriaHidden(true)], []);

const header = (h: H, model: Model): Html => {
	const status = statusOf(model);

	return h.header(
		[h.Class("flex h-14 items-center gap-3 border-b border-line px-5")],
		[
			h.img([h.Src("/img/tardigrade.png"), h.Alt(""), h.Width("26"), h.Height("26"), h.Class("rounded-md")]),
			h.h1([h.Class("text-[15px] font-semibold tracking-[-0.01em]")], ["tardigrade"]),
			divider(h),
			h.span([h.Class("hidden truncate font-mono text-[12px] text-faint sm:inline")], [model.name]),
			h.div(
				[h.Class("ml-auto flex flex-none items-center gap-4")],
				[
					h.span(
						[h.Id("status"), h.Class(`flex items-center gap-2 text-[13px] ${status.tone}`), h.AriaLive("polite")],
						[h.i([h.Class(`size-2 rounded-full ${status.mark}`), h.AriaHidden(true)], []), status.label],
					),
					h.span(
						[h.Class(`flex items-baseline gap-1.5 text-[13px] ${model.lives > 1 ? "text-life" : "text-dim"}`), h.Title("How many times this agent has started. Each kill adds one.")],
						["Lives", h.b([h.Id("lives"), h.Class("font-mono text-[14px] font-medium")], [String(model.lives)])],
					),
					divider(h),
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.span([h.Class("md:hidden")], [button(h, "Files", Message.ToggledFilesPanel(), SECONDARY)]),
							button(h, "New", Message.ClickedNew(), SECONDARY),
							button(h, "Kill it", Message.ClickedKill(), DANGER, isDown(model) || !model.busy),
						],
					),
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
			h.Class(`mx-auto mb-2 flex w-full max-w-[720px] items-center gap-2 text-[13px] ${row.dead ? "text-bad" : "text-dim"}`),
			h.AriaLive("polite"),
		],
		[
			h.span([h.Class(`size-3 rounded-full border-[1.5px] ${row.dead ? "border-bad" : "animate-spin border-line-strong border-t-ink"}`), h.AriaHidden(true)], []),
			h.span([], [row.label]),
			h.span([h.Class("ml-auto text-faint")], [`${elapsedSeconds(model)}s`]),
		],
	);
};

const composer = (h: H, model: Model): Html =>
	h.form(
		[h.Class("mx-auto w-full max-w-[720px]"), h.OnSubmit(Message.SubmittedDraft())],
		[
			h.label([h.For("task"), h.Class("sr-only")], ["Task for the agent"]),
			h.div(
				[h.Class("flex items-end gap-2 rounded-lg border border-line-strong bg-bg p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus-within:border-ink")],
				[
					h.textarea([
						h.Id("task"),
						h.Rows(1),
						h.Placeholder("Describe a task that takes a few steps"),
						h.Value(model.draft),
						h.Class("max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2.5 py-1.5 outline-none placeholder:text-faint focus-visible:outline-none"),
						h.OnInput((value) => Message.UpdatedDraft({ value })),
						h.OnKeyDownPreventDefault((key, modifiers) =>
							key === "Enter" && !modifiers.shiftKey ? Option.some(Message.SubmittedDraft()) : Option.none(),
						),
					]),
					h.button(
						[
							h.Type("submit"),
							h.Disabled(model.busy || isDown(model)),
							h.Class(`${BUTTON} h-9 bg-accent text-accent-ink hover:opacity-90`),
						],
						["Send"],
					),
				],
			),
			h.p(
				[h.Class("mt-2 text-[12px] text-faint")],
				[h.kbd([h.Class("font-mono")], ["Enter"]), " sends. ", h.kbd([h.Class("font-mono")], ["Shift Enter"]), " adds a line."],
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
				[h.Class("grid min-h-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]")],
				[
					h.section(
						[h.Class("grid min-h-0 grid-rows-[1fr_auto]"), h.AriaLabel("Conversation")],
						[h.div([h.Id("log"), h.Class("overflow-y-auto px-5 pt-8 pb-4")], [transcript(h, model)]), h.div([h.Class("px-5 pb-5")], [activity(h, model), composer(h, model)])],
					),
					filesPanel(h, model),
				],
			),
		],
	),
});
