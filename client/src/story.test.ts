import { Duration, Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";
import {
	BackEvent,
	BusyFrame,
	ConversationName,
	EventsFrame,
	KilledEvent,
	RestartedEvent,
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
import { reconnectDelay } from "./socket";
import { Phase } from "./model";
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
	events: [],
	killedAt: Option.none(),
	filesError: Option.none(),
	...overrides,
});

const frame = (value: Parameters<typeof Message.ReceivedFrame>[0]["frame"]) => Message.ReceivedFrame({ frame: value });

describe("files", () => {
	test("when the file store is down, the page says so instead of showing an empty repository", () => {
		story(
			update,
			given(fresh),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ filesError: Option.some("Files are unavailable: RepoUnavailable") }) }))),
			model((current) => {
				expect(current.filesError).toEqual(Option.some("Files are unavailable: RepoUnavailable"));
			}),
		);
	});
});

describe("reconnecting", () => {
	test("each failed connect waits longer, up to ten seconds, and a good connect resets the wait", () => {
		expect([0, 1, 2, 3, 10].map((failures) => Duration.toMillis(reconnectDelay(failures)))).toEqual([0, 500, 1000, 2000, 10000]);

		story(
			update,
			given(fresh),
			message(Message.SocketClosed()),
			message(Message.SocketClosed()),
			model((current) => {
				expect(current.failedConnects).toBe(2);
			}),
			message(Message.SocketOpened()),
			model((current) => {
				expect(current.failedConnects).toBe(0);
			}),
		);
	});
});

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
				expect(current.localNotes.at(-1)?.reason).toBe("Still working on the last message.");
			}),
		);
	});
});

describe("kill and revival", () => {
	const working = update(fresh, frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true }) }))).model;

	test("Kill it is ignored while nothing is running", () => {
		story(update, given(fresh), message(Message.ClickedKill()), Command.expectNone());
	});

	const killed = KilledEvent.make({ at: 5_000, afterBlock: 0, wasBusy: true });

	const back = BackEvent.make({ at: 7_900, afterBlock: 0, afterMs: 2_900, lives: 2, resumed: true });

	test("Kill it marks the agent dead at once and asks the server to kill it", () => {
		story(
			update,
			given({ ...working, now: 5_000 }),
			message(Message.ClickedKill()),
			model((current) => {
				expect(current.phase).toEqual(Phase.Dead({ killedAt: 5_000 }));
			}),
			Command.expectHas(Kill),
			Command.resolve(Kill, Message.CompletedKill()),
		);
	});

	test("the kill shown on the page is the one the server recorded, shown once", () => {
		story(
			update,
			given(working),
			message(frame(KilledFrame.make({ killedAt: 5_000 }))),
			message(frame(EventsFrame.make({ events: [killed] }))),
			message(frame(KilledFrame.make({ killedAt: 5_000 }))),
			message(frame(EventsFrame.make({ events: [killed] }))),
			model((current) => {
				expect(current.events).toEqual([killed]);
				expect(current.phase).toEqual(Phase.Dead({ killedAt: 5_000 }));
			}),
		);
	});

	test("a page opened after a kill, before the comeback, shows the kill and that it is coming back", () => {
		story(
			update,
			given(fresh),
			message(Message.SocketOpened()),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true, lives: 2, events: [killed], killedAt: Option.some(5_000) }) }))),
			model((current) => {
				expect(current.events).toEqual([killed]);
				expect(current.phase).toEqual(Phase.Reviving({ killedAt: 5_000 }));
			}),
		);
	});

	test("a page opened after the comeback shows the kill and the comeback, exactly as the first tab saw them", () => {
		story(
			update,
			given(fresh),
			message(Message.SocketOpened()),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true, lives: 2, events: [killed, back] }) }))),
			model((current) => {
				expect(current.events).toEqual([killed, back]);
				expect(current.phase._tag).toBe("Working");
				expect(current.lives).toBe(2);
			}),
		);
	});

	test("a restart without a kill shows as a Restarted line and keeps working", () => {
		const restarted = RestartedEvent.make({ at: 9_000, afterBlock: 1, lives: 2 });

		story(
			update,
			given(working),
			message(frame(EventsFrame.make({ events: [restarted] }))),
			model((current) => {
				expect(current.events).toEqual([restarted]);
				expect(current.phase._tag).toBe("Working");
			}),
		);
	});

	test("after a kill, the socket drops and reconnects, and the server's events replace the local guess", () => {
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
			message(Message.SocketOpened()),
			message(frame(RevivedFrame.make({ lives: 2 }))),
			message(frame(SnapshotFrame.make({ snapshot: snapshot({ busy: true, lives: 2, events: [killed, back] }) }))),
			model((current) => {
				expect(current.phase._tag).toBe("Working");
				expect(current.lives).toBe(2);
				expect(current.events).toEqual([killed, back]);
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
