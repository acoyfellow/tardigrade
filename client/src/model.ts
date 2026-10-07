import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";
import { Block, Commit, ConversationName, Live } from "../../shared/protocol";

export const Phase = defineTaggedUnion({
	Connecting: {},
	Idle: {},
	Working: {},
	Dead: { killedAt: Schema.Number },
	Reviving: { killedAt: Schema.Number },
});

export type Phase = typeof Phase.Type;

export const Event = defineTaggedUnion({
	Killed: { wasBusy: Schema.Boolean },
	Back: { afterMs: Schema.Number, lives: Schema.Number, resumed: Schema.Boolean },
	Failed: { reason: Schema.String },
});

export type Event = typeof Event.Type;

export const PlacedEvent = Schema.Struct({ afterBlock: Schema.Number, event: Event });

export type PlacedEvent = typeof PlacedEvent.Type;

export const OpenFile = defineTaggedUnion({
	Closed: {},
	Loading: { path: Schema.String, at: Schema.String },
	Loaded: { path: Schema.String, at: Schema.String, body: Schema.String },
});

export type OpenFile = typeof OpenFile.Type;

export const Model = Schema.Struct({
	name: ConversationName,
	phase: Phase,
	connected: Schema.Boolean,
	connectionEpoch: Schema.Number,
	lives: Schema.Number,
	busy: Schema.Boolean,
	blocks: Schema.Array(Block),
	live: Schema.Option(Live),
	files: Schema.Array(Schema.String),
	commits: Schema.Array(Commit),
	events: Schema.Array(PlacedEvent),
	draft: Schema.String,
	openFile: OpenFile,
	filesPanelOpen: Schema.Boolean,
	openThoughts: Schema.Array(Schema.String),
	now: Schema.Number,
	activitySince: Schema.Number,
	activityKey: Schema.String,
});

export type Model = typeof Model.Type;

export const EXAMPLES = [
	"Build a small landing page for a bakery in index.html",
	"Write a Python script that prints the first 50 primes, then a README explaining it",
	"Create a todo app in one HTML file",
] as const;
