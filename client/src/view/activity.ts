import { Match, Option } from "effect";
import type { Live } from "../../../shared/protocol";
import { type Model, Phase } from "../model";

export type ActivityRow = { readonly visible: boolean; readonly dead: boolean; readonly label: string };

const liveLabel = (live: Live): string =>
	Match.value(live.activity).pipe(
		Match.when("waiting", () => "Waiting for the model"),
		Match.when("thinking", () => "Thinking"),
		Match.when("replying", () => "Replying"),
		Match.when("writing", () => `Writing ${live.detail === "" ? "a file" : live.detail}`),
		Match.when("calling", () => `Calling ${live.detail}`),
		Match.when("running", () => `Running ${live.detail}`),
		Match.exhaustive,
	);

export const activityRow = (model: Model): ActivityRow =>
	Phase.match(model.phase, {
		Dead: () => ({ visible: true, dead: true, label: "Killed. Waiting for it to come back" }),
		Reviving: () => ({ visible: true, dead: false, label: "Coming back" }),
		Connecting: () => ({ visible: model.busy, dead: false, label: "Reconnecting" }),
		Idle: () => ({ visible: false, dead: false, label: "" }),
		Working: () => ({ visible: true, dead: false, label: Option.match(model.live, { onNone: () => "Working", onSome: liveLabel }) }),
	});

export const activityKey = (model: Model): string => activityRow(model).label;

export const elapsedSeconds = (model: Model): number => Math.max(0, Math.floor((model.now - model.activitySince) / 1000));
