import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";
import {
	BusyFrame,
	ConversationName,
	KilledFrame,
	ReplyBlock,
	RevivedFrame,
	type Snapshot,
	SnapshotFrame,
	UserBlock,
} from "../../shared/protocol";
import { Kill, Send, ShowConversation } from "./command";
import { initialModel } from "./main";
import { Message } from "./message";
import { Event, Phase } from "./model";
import { update } from "./update";

const name = ConversationName.make("c-story");

const fresh = initialModel({ name, isNew: true, now: 1_000 });

const snapshot = (overrides: Partial<Snapshot>): Snapshot => ({
	name,
	model: "test-model",
	lives: 1,
	busy: false,
	blocks: [],
	live: Option.none(),
	files: [],
	commits: [],
	...overrides,
});

const frame = (value: Parameters<typeof Message.ReceivedFrame>[0]["frame"]) => Message.ReceivedFrame({ frame: value });

describe("connecting", () => {
	test("the first snapshot moves the page from connecting to idle", () => {
		story(
			update,
			given(fresh),
			message(Message.SocketOpened()),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({}) }))),
			model((current) => {
				expect(current.connected).toBe(true);
				expect(current.phase).toEqual(Phase.Idle());
			}),
		);
	});

	test("a busy snapshot moves the page to working", () => {
		story(
			update,
			given(fresh),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true, lives: 3 }) }))),
			model((current) => {
				expect(current.phase._tag).toBe("Working");
				expect(current.lives).toBe(3);
			}),
		);
	});
});

describe("sending", () => {
	test("an example sends the task, shows it at once, and puts the name in the URL", () => {
		story(
			update,
			given(fresh),
			message(Message.ClickedExample({ text: "  Build a page  " })),
			model((current) => {
				expect(current.busy).toBe(true);
				expect(current.blocks).toEqual([UserBlock.make({ text: "Build a page" })]);
			}),
			Command.expectHas(Send),
			Command.expectHas(ShowConversation),
			Command.resolve(Send, Message.SucceededSend()),
			Command.resolve(ShowConversation, Message.CompletedNavigation()),
		);
	});

	test("an empty draft sends nothing", () => {
		story(update, given(fresh), message(Message.SubmittedDraft()), Command.expectNone());
	});

	test("a rejected send leaves the page idle and says why", () => {
		story(
			update,
			given(fresh),
			message(Message.ClickedExample({ text: "Build a page" })),
			Command.resolve(Send, Message.FailedSend({ reason: "Still working on the last message." })),
			Command.resolve(ShowConversation, Message.CompletedNavigation()),
			model((current) => {
				expect(current.busy).toBe(false);
				expect(current.events.at(-1)?.event).toEqual(Event.Failed({ reason: "Still working on the last message." }));
			}),
		);
	});
});

describe("kill and revival", () => {
	const working = update(fresh, frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true }) }))).model;

	test("Kill it is ignored while nothing is running", () => {
		story(update, given(fresh), message(Message.ClickedKill()), Command.expectNone());
	});

	test("Kill it marks the agent dead and records when", () => {
		story(
			update,
			given({ ...working, now: 5_000 }),
			message(Message.ClickedKill()),
			model((current) => {
				expect(current.phase).toEqual(Phase.Dead({ killedAt: 5_000 }));
				expect(current.events.at(-1)?.event).toEqual(Event.Killed({ wasBusy: true }));
			}),
			Command.expectHas(Kill),
			Command.resolve(Kill, Message.CompletedKill()),
		);
	});

	test("a killed frame from another tab marks it dead exactly once", () => {
		story(
			update,
			given(working),
			message(frame(KilledFrame.make({}))),
			message(frame(KilledFrame.make({}))),
			model((current) => {
				expect(current.events.filter((placed) => Event.isAnyOf(["Killed"])(placed.event))).toHaveLength(1);
			}),
		);
	});

	test("after a kill, the socket drops, reconnects, and the page reports how long it was gone", () => {
		story(
			update,
			given({ ...working, now: 5_000 }),
			message(Message.ClickedKill()),
			Command.resolve(Kill, Message.CompletedKill()),
			message(Message.SocketClosed()),
			model((current) => {
				expect(current.phase).toEqual(Phase.Reviving({ killedAt: 5_000 }));
				expect(current.connectionEpoch).toBe(working.connectionEpoch + 1);
			}),
			message(Message.Ticked({ now: 7_900 })),
			message(Message.SocketOpened()),
			message(frame(RevivedFrame.make({ lives: 2 }))),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true, lives: 2 }) }))),
			model((current) => {
				expect(current.phase._tag).toBe("Working");
				expect(current.lives).toBe(2);
				expect(current.events.at(-1)?.event).toEqual(Event.Back({ afterMs: 2_900, lives: 2, resumed: true }));
			}),
		);
	});

	test("the run finishing ends the working state and keeps the reply", () => {
		story(
			update,
			given(working),
			message(frame(BusyFrame.make({ busy: false }))),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ blocks: [ReplyBlock.make({ text: "Done." })] }) }))),
			model((current) => {
				expect(current.phase._tag).toBe("Idle");
				expect(current.blocks).toEqual([ReplyBlock.make({ text: "Done." })]);
			}),
		);
	});
});
