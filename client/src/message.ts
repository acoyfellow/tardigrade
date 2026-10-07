import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { ServerFrame } from "../../shared/protocol";

export const Message = defineMessageUnion({
	ReceivedFrame: { frame: ServerFrame },
	SocketOpened: {},
	SocketClosed: {},
	UpdatedDraft: { value: Schema.String },
	SubmittedDraft: {},
	ClickedExample: { text: Schema.String },
	SucceededSend: {},
	FailedSend: { reason: Schema.String },
	ClickedKill: {},
	CompletedKill: {},
	ClickedNew: {},
	ToggledFilesPanel: {},
	ClickedFile: { path: Schema.String },
	LoadedFile: { path: Schema.String, at: Schema.String, body: Schema.String },
	ToggledThought: { key: Schema.String },
	Ticked: { now: Schema.Number },
	CompletedNavigation: {},
});

export type Message = typeof Message.Type;
