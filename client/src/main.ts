import { Effect, Option, Schema } from "effect";
import type { Runtime } from "foldkit";
import { ConversationName } from "../../shared/protocol";
import { ShowConversation } from "./command";
import type { Message } from "./message";
import type { AgentClient } from "./rpc";
import { type Model, OpenFile, Phase } from "./model";

const decodeName = Schema.decodeUnknownOption(ConversationName);

const PAGE_ROUTE = /^\/c\/([^/]+)\/?$/;

export const Flags = Schema.Struct({ name: ConversationName, isNew: Schema.Boolean, now: Schema.Number });

export type Flags = typeof Flags.Type;

const freshName = (): ConversationName => ConversationName.make(`c-${crypto.randomUUID()}`);

export const flags: Effect.Effect<Flags> = Effect.gen(function* () {
	const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
	const fromUrl = decodeName(PAGE_ROUTE.exec(globalThis.location.pathname)?.[1]);

	return Option.match(fromUrl, {
		onSome: (name) => ({ name, isNew: false, now }),
		onNone: () => ({ name: freshName(), isNew: true, now }),
	});
});

export const initialModel = ({ name, now }: Flags): Model => ({
	name,
	phase: Phase.Connecting(),
	connected: false,
	connectionEpoch: 0,
	failedConnects: 0,
	lives: 1,
	busy: false,
	blocks: [],
	live: Option.none(),
	files: [],
	commits: [],
	events: [],
	localNotes: [],
	draft: "",
	openFile: OpenFile.Closed(),
	filesPanelOpen: false,
	openThoughts: [],
	now,
	activitySince: now,
	activityKey: "",
});

export const init: Runtime.ApplicationInit<Model, Message, Flags, AgentClient> = (startup) => ({
	model: initialModel(startup),
	commands: startup.isNew ? [] : [ShowConversation({ name: startup.name })],
});
