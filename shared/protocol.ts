import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const ConversationName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(Schema.brand("ConversationName"));

export type ConversationName = typeof ConversationName.Type;

export const Commit = Schema.Struct({ oid: Schema.String, message: Schema.String, time: Schema.Number });

export type Commit = typeof Commit.Type;

export const UserBlock = Schema.TaggedStruct("UserText", { text: Schema.String });

export const ReplyBlock = Schema.TaggedStruct("Reply", { text: Schema.String });

export const ThoughtBlock = Schema.TaggedStruct("Thought", { text: Schema.String });

export const ToolBlock = Schema.TaggedStruct("Tool", {
	callId: Schema.String,
	name: Schema.String,
	path: Schema.String,
	draft: Schema.String,
	result: Schema.OptionFromNullOr(Schema.Struct({ line: Schema.String, isError: Schema.Boolean })),
});

export const Block = Schema.Union([UserBlock, ReplyBlock, ThoughtBlock, ToolBlock]);

export type Block = typeof Block.Type;

export type ToolBlock = typeof ToolBlock.Type;

export const Activity = Schema.Literals(["waiting", "thinking", "replying", "writing", "calling", "running"]);

export type Activity = typeof Activity.Type;

export const ActivityLine = Schema.Struct({ activity: Activity, detail: Schema.String });

export type ActivityLine = typeof ActivityLine.Type;

export const Live = Schema.Struct({ ...ActivityLine.fields, blocks: Schema.Array(Block) });

export type Live = typeof Live.Type;

export const KilledEvent = Schema.TaggedStruct("Killed", { at: Schema.Number, afterBlock: Schema.Number, wasBusy: Schema.Boolean });

export const BackEvent = Schema.TaggedStruct("Back", { at: Schema.Number, afterBlock: Schema.Number, afterMs: Schema.Number, lives: Schema.Number, resumed: Schema.Boolean });

export const FailedEvent = Schema.TaggedStruct("Failed", { at: Schema.Number, afterBlock: Schema.Number, reason: Schema.String });

export const ResumedEvent = Schema.TaggedStruct("Resumed", { at: Schema.Number, afterBlock: Schema.Number, lives: Schema.Number });

export const TimelineEvent = Schema.Union([KilledEvent, BackEvent, ResumedEvent, FailedEvent]);

export type TimelineEvent = typeof TimelineEvent.Type;

export const Snapshot = Schema.Struct({
	name: ConversationName,
	model: Schema.String,
	lives: Schema.Number,
	busy: Schema.Boolean,
	blocks: Schema.Array(Block),
	live: Schema.OptionFromNullOr(Live),
	files: Schema.Array(Schema.String),
	commits: Schema.Array(Commit),
	events: Schema.Array(TimelineEvent),
	killedAt: Schema.OptionFromNullOr(Schema.Number),
});

export type Snapshot = typeof Snapshot.Type;

export const SnapshotFrame = Schema.TaggedStruct("Snapshot", { snapshot: Snapshot });

export const LiveFrame = Schema.TaggedStruct("Live", { live: Schema.OptionFromNullOr(Live) });

export const BlocksFrame = Schema.TaggedStruct("Blocks", { blocks: Schema.Array(Block) });

export const FilesFrame = Schema.TaggedStruct("Files", { files: Schema.Array(Schema.String), commits: Schema.Array(Commit) });

export const BusyFrame = Schema.TaggedStruct("Busy", { busy: Schema.Boolean });

export const KilledFrame = Schema.TaggedStruct("Killed", { killedAt: Schema.Number });

export const EventsFrame = Schema.TaggedStruct("Events", { events: Schema.Array(TimelineEvent) });

export const RevivedFrame = Schema.TaggedStruct("Revived", { lives: Schema.Number });

export const RunFailedFrame = Schema.TaggedStruct("RunFailed", { reason: Schema.String });

export const ServerFrame = Schema.Union([SnapshotFrame, LiveFrame, BlocksFrame, FilesFrame, BusyFrame, KilledFrame, RevivedFrame, RunFailedFrame, EventsFrame]);

export type ServerFrame = typeof ServerFrame.Type;

export const ServerFrameJson = Schema.fromJsonString(ServerFrame);

export class StillWorking extends Schema.TaggedError<StillWorking>()("StillWorking", {}) {}

export class NothingRunning extends Schema.TaggedError<NothingRunning>()("NothingRunning", {}) {}

export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", { path: Schema.String }) {}

export const Accepted = Schema.Struct({ id: Schema.String });

export const SendOutcome = Schema.Result(Accepted, StillWorking);

export const KillOutcome = Schema.Result(Schema.Void, NothingRunning);

export const ReadOutcome = Schema.Result(Schema.String, FileNotFound);

export const MAX_INPUT = 8000;

export const Input = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_INPUT));

const target = { name: ConversationName };

export const AgentRpcs = RpcGroup.make(
	Rpc.make("Snapshot", { payload: target, success: Snapshot }),
	Rpc.make("Send", { payload: { ...target, text: Input }, success: Accepted, error: StillWorking }),
	Rpc.make("Kill", { payload: target, error: NothingRunning }),
	Rpc.make("ReadFile", { payload: { ...target, path: Schema.String }, success: Schema.String, error: FileNotFound }),
);

export type AgentRpcs = typeof AgentRpcs;

export const RPC_PATH = "/api/rpc";

export const socketPath = (name: ConversationName) => `/api/c/${name}/ws`;

export const SnapshotJson = Schema.fromJsonString(Schema.toCodecJson(Snapshot));

export const SendOutcomeJson = Schema.fromJsonString(Schema.toCodecJson(SendOutcome));

export const KillOutcomeJson = Schema.fromJsonString(Schema.toCodecJson(KillOutcome));

export const ReadOutcomeJson = Schema.fromJsonString(Schema.toCodecJson(ReadOutcome));
