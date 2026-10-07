import { Effect, Schema } from "effect";
import { Command, Navigation } from "foldkit";
import { ConversationName } from "../../shared/protocol";
import { Message } from "./message";
import { AgentClient } from "./rpc";

const reasonOf = (error: { readonly message: string }) => error.message;

export const Send = Command.define("Send", {
	args: { name: ConversationName, text: Schema.String },
	messages: [Message.SucceededSend, Message.FailedSend],
	execute: ({ name, text }) =>
		Effect.gen(function* () {
			const client = yield* AgentClient;

			yield* client.Send({ name, text });

			return Message.SucceededSend();
		}).pipe(
			Effect.catchTag("StillWorking", () => Effect.succeed(Message.FailedSend({ reason: "Still working on the last message." }))),
			Effect.catch((error) => Effect.succeed(Message.FailedSend({ reason: reasonOf(error) }))),
		),
});

export const Kill = Command.define("Kill", {
	args: { name: ConversationName },
	messages: [Message.CompletedKill],
	execute: ({ name }) =>
		Effect.gen(function* () {
			const client = yield* AgentClient;

			yield* client.Kill({ name });
		}).pipe(Effect.ignoreCause, Effect.as(Message.CompletedKill())),
});

export const LoadFile = Command.define("LoadFile", {
	args: { name: ConversationName, path: Schema.String, at: Schema.String },
	messages: [Message.LoadedFile],
	execute: ({ name, path, at }) =>
		Effect.gen(function* () {
			const client = yield* AgentClient;

			return yield* client.ReadFile({ name, path });
		}).pipe(
			Effect.orElseSucceed(() => "(could not read file)"),
			Effect.map((body) => Message.LoadedFile({ path, at, body })),
		),
});

export const ShowConversation = Command.define("ShowConversation", {
	args: { name: ConversationName },
	messages: [Message.CompletedNavigation],
	execute: ({ name }) => Navigation.replaceUrl(`/c/${name}`).pipe(Effect.as(Message.CompletedNavigation())),
});

export const StartNewConversation = Command.define("StartNewConversation", {
	messages: [Message.CompletedNavigation],
	execute: Navigation.load("/").pipe(Effect.as(Message.CompletedNavigation())),
});
