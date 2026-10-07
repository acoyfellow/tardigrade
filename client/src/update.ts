import { Array as Arr, Match, Option } from "effect";
import type { Command, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { type ServerFrame, type Snapshot, UserBlock } from "../../shared/protocol";
import { Kill, LoadFile, Send, ShowConversation, StartNewConversation } from "./command";
import { Message } from "./message";
import { type Model, OpenFile, Phase } from "./model";
import type { AgentClient } from "./rpc";
import { activityKey } from "./view/activity";

type UpdateReturn = Update.Return<Model, Message, AgentClient>;

type AnyCommand = Command.Command<Message, never, AgentClient>;

const isDown = (phase: Phase): boolean => Phase.isAnyOf(["Dead", "Reviving"])(phase);

const withNote = (model: Model, reason: string): Model =>
	modifyFields(model, { localNotes: (notes) => [...notes, { at: model.now, afterBlock: model.blocks.length, reason }] });

const latestCommit = (model: Model): string => Option.getOrElse(Option.map(Arr.head(model.commits), (commit) => commit.oid), () => "");

const refreshOpenFile = (model: Model): { readonly model: Model; readonly commands: ReadonlyArray<AnyCommand> } =>
	OpenFile.match(model.openFile, {
		Closed: () => ({ model, commands: [] }),
		Loading: () => ({ model, commands: [] }),
		Loaded: ({ path, at }) => {
			const head = latestCommit(model);

			return at === head
				? { model, commands: [] }
				: { model: modifyFields(model, { openFile: () => OpenFile.Loading({ path, at: head }) }), commands: [LoadFile({ name: model.name, path, at: head })] };
		},
	});

const withActivity = (model: Model): Model => {
	const key = activityKey(model);

	return key === model.activityKey ? model : modifyFields(model, { activityKey: () => key, activitySince: () => model.now });
};

const settlePhase = (model: Model, busy: boolean): Model =>
	modifyFields(model, { busy: () => busy, phase: () => (busy ? Phase.Working() : Phase.Idle()) });

const phaseFor = (snapshot: Snapshot, connected: boolean): Phase =>
	Option.match(snapshot.killedAt, {
		onSome: (killedAt) => (connected ? Phase.Reviving({ killedAt }) : Phase.Dead({ killedAt })),
		onNone: () => (snapshot.busy ? Phase.Working() : Phase.Idle()),
	});

const applySnapshot = (model: Model, snapshot: Snapshot): Model =>
	modifyFields(model, {
		lives: () => snapshot.lives,
		busy: () => snapshot.busy,
		blocks: () => snapshot.blocks,
		live: () => snapshot.live,
		files: () => snapshot.files,
		commits: () => snapshot.commits,
		filesError: () => snapshot.filesError,
		events: () => snapshot.events,
		localNotes: () => [],
		phase: () => phaseFor(snapshot, model.connected),
	});

const markKilled = (model: Model, killedAt: number): Model =>
	isDown(model.phase) ? model : modifyFields(model, { phase: () => Phase.Dead({ killedAt }), live: () => Option.none() });

const onFrame = (model: Model, frame: ServerFrame): UpdateReturn => {
	const next = Match.value(frame).pipe(
		Match.tagsExhaustive({
			Snapshot: ({ snapshot }) => applySnapshot(model, snapshot),
			Live: ({ live }) => modifyFields(model, { live: () => live }),
			Blocks: ({ blocks }) => modifyFields(model, { blocks: () => blocks }),
			Files: ({ files, commits }) => modifyFields(model, { files: () => files, commits: () => commits }),
			Busy: ({ busy }) => settlePhase(busy ? model : modifyFields(model, { live: () => Option.none() }), busy),
			Killed: ({ killedAt }) => markKilled(model, killedAt),
			Revived: ({ lives }) => modifyFields(model, { lives: () => lives }),
			Events: ({ events }) => modifyFields(model, { events: () => events }),
		}),
	);

	return refreshOpenFile(withActivity(next));
};

const send = (model: Model, text: string): UpdateReturn => {
	const trimmed = text.trim();

	if (trimmed === "" || model.busy || isDown(model.phase)) return { model };

	const pending = modifyFields(model, {
		draft: () => "",
		busy: () => true,
		phase: () => Phase.Working(),
		blocks: (blocks) => [...blocks, UserBlock.make({ text: trimmed })],
	});

	return { model: withActivity(pending), commands: [Send({ name: model.name, text: trimmed }), ShowConversation({ name: model.name })] };
};

const toggled = (items: ReadonlyArray<string>, item: string) => (items.includes(item) ? items.filter((each) => each !== item) : [...items, item]);

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ReceivedFrame: ({ frame }) => onFrame(model, frame),
		SocketOpened: () => ({ model: modifyFields(model, { connected: () => true, failedConnects: () => 0 }) }),
		SocketClosed: () => ({
			model: modifyFields(model, {
				connected: () => false,
				connectionEpoch: (epoch) => epoch + 1,
				failedConnects: (failures) => (model.connected ? 0 : failures + 1),
				phase: (phase) =>
					Match.value(phase).pipe(
						Match.tag("Dead", ({ killedAt }) => Phase.Reviving({ killedAt })),
						Match.tag("Reviving", (reviving) => reviving),
						Match.orElse(() => Phase.Connecting()),
					),
			}),
		}),
		UpdatedDraft: ({ value }) => ({ model: modifyFields(model, { draft: () => value }) }),
		SubmittedDraft: () => send(model, model.draft),
		ClickedExample: ({ text }) => send(model, text),
		SucceededSend: () => ({ model }),
		FailedSend: ({ reason }) => ({ model: settlePhase(withNote(model, reason), false) }),
		ClickedKill: () => (isDown(model.phase) || !model.busy ? { model } : { model: markKilled(model, model.now), commands: [Kill({ name: model.name })] }),
		CompletedKill: () => ({ model }),
		ClickedNew: () => ({ model, commands: [StartNewConversation()] }),
		ToggledFilesPanel: () => ({ model: modifyFields(model, { filesPanelOpen: (open) => !open }) }),
		ClickedFile: ({ path }) =>
			OpenFile.match(model.openFile, {
				Loaded: (open) => (open.path === path ? { model: modifyFields(model, { openFile: () => OpenFile.Closed() }) } : openFile(model, path)),
				Loading: (open) => (open.path === path ? { model: modifyFields(model, { openFile: () => OpenFile.Closed() }) } : openFile(model, path)),
				Closed: () => openFile(model, path),
			}),
		LoadedFile: ({ path, at, body }) =>
			OpenFile.match(model.openFile, {
				Loading: (open) => (open.path === path && open.at === at ? { model: modifyFields(model, { openFile: () => OpenFile.Loaded({ path, at, body }) }) } : { model }),
				Loaded: () => ({ model }),
				Closed: () => ({ model }),
			}),
		ToggledThought: ({ key }) => ({ model: modifyFields(model, { openThoughts: (open) => toggled(open, key) }) }),
		Ticked: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),
		CompletedNavigation: () => ({ model }),
	});

const openFile = (model: Model, path: string): UpdateReturn => {
	const at = latestCommit(model);

	return { model: modifyFields(model, { openFile: () => OpenFile.Loading({ path, at }) }), commands: [LoadFile({ name: model.name, path, at })] };
};
