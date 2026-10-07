import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { type ConversationName, type ServerFrame, ServerFrameJson, type TimelineEvent } from "../shared/protocol";
import { Meta } from "./meta";

export class StorageFailed extends Schema.TaggedError<StorageFailed>()("StorageFailed", { step: Schema.String, reason: Schema.String }) {}

class SocketSendFailed extends Schema.TaggedError<SocketSendFailed>()("SocketSendFailed", { reason: Schema.String }) {}

const encodeFrame = Schema.encodeSync(ServerFrameJson);

type ObjectState = {
	readonly sockets: () => ReadonlyArray<WebSocket>;
	readonly setAlarm: (at: number) => Effect.Effect<void, StorageFailed>;
	readonly clearAlarm: Effect.Effect<void, StorageFailed>;
	readonly flush: Effect.Effect<void, StorageFailed>;
	readonly abort: (reason: string) => Effect.Effect<never>;
	readonly background: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void>;
};

const storageStep = (step: string, run: () => Promise<void>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new StorageFailed({ step, reason: String(cause) }) });

export class DurableObjectContext extends Context.Service<DurableObjectContext, ObjectState>()("tardigrade/DurableObjectContext") {
	static readonly layer = (ctx: DurableObjectState) =>
		Layer.succeed(DurableObjectContext, {
			sockets: () => ctx.getWebSockets(),
			setAlarm: (at) => storageStep("setAlarm", () => ctx.storage.setAlarm(at)),
			clearAlarm: storageStep("deleteAlarm", () => ctx.storage.deleteAlarm()),
			flush: storageStep("sync", () => ctx.storage.sync()),
			abort: (reason) => Effect.sync(() => ctx.abort(reason)).pipe(Effect.andThen(Effect.never)),
			background: (effect) =>
				Effect.contextWith((context: Context.Context<never>) =>
					Effect.sync(() => ctx.waitUntil(Effect.runPromiseWith(context)(effect.pipe(Effect.tapCause((cause) => Effect.logError("background work failed", Cause.pretty(cause))), Effect.ignoreCause)))),
				),
		});
}

type StoredState = {
	readonly name: Effect.Effect<ConversationName>;
	readonly pending: Effect.Effect<Option.Option<string>>;
	readonly setPending: (encoded: string) => Effect.Effect<void>;
	readonly clearPending: Effect.Effect<void>;
	readonly lives: Effect.Effect<number>;
	readonly events: Effect.Effect<ReadonlyArray<TimelineEvent>>;
	readonly addEvent: (event: TimelineEvent) => Effect.Effect<ReadonlyArray<TimelineEvent>>;
	readonly killedAt: Effect.Effect<Option.Option<number>>;
	readonly recordKill: (at: number) => Effect.Effect<void>;
	readonly recordRestart: Effect.Effect<void>;
	readonly takeKill: Effect.Effect<Option.Option<number>>;
};

export class Store extends Context.Service<Store, StoredState>()("tardigrade/Store") {
	static readonly layer = (storage: DurableObjectStorage) =>
		Layer.sync(Store, () => {
			const meta = new Meta(storage);

			return {
				name: Effect.sync(() => meta.name()),
				pending: Effect.sync(() => meta.pending()),
				setPending: (encoded) => Effect.sync(() => meta.setPending(encoded)),
				clearPending: Effect.sync(() => meta.clearPending()),
				lives: Effect.sync(() => meta.lives()),
				events: Effect.sync(() => meta.events()),
				addEvent: (event) => Effect.sync(() => meta.addEvent(event)),
				killedAt: Effect.sync(() => meta.killedAt()),
				recordKill: (at) => Effect.sync(() => meta.recordKill(at)),
				recordRestart: Effect.sync(() => meta.recordRestart()),
				takeKill: Effect.sync(() => meta.takeKill()),
			};
		});
}

const sendTo = (socket: WebSocket, data: string) =>
	Effect.try({ try: () => socket.send(data), catch: (cause) => new SocketSendFailed({ reason: String(cause) }) }).pipe(
		Effect.catchTag("SocketSendFailed", () => Effect.sync(() => socket.close(1011, "send failed"))),
	);

type Broadcaster = {
	readonly send: (frame: ServerFrame) => Effect.Effect<void>;
	readonly sendTo: (socket: WebSocket, frame: ServerFrame) => Effect.Effect<void>;
};

export class Broadcast extends Context.Service<Broadcast, Broadcaster>()("tardigrade/Broadcast") {
	static readonly layer = Layer.effect(
		Broadcast,
		Effect.gen(function* () {
			const object = yield* DurableObjectContext;

			return {
				send: (frame) => {
					const data = encodeFrame(frame);

					return Effect.forEach(object.sockets(), (socket) => sendTo(socket, data), { discard: true });
				},
				sendTo: (socket, frame) => sendTo(socket, encodeFrame(frame)),
			};
		}),
	);
}

export const now = Clock.currentTimeMillis;
