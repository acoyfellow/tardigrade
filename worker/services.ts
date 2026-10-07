import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { type ServerFrame, ServerFrameJson } from "../shared/protocol";
import { Meta } from "./meta";

export class SocketSendFailed extends Schema.TaggedError<SocketSendFailed>()("SocketSendFailed", { reason: Schema.String }) {}

const encodeFrame = Schema.encodeSync(ServerFrameJson);

export type ObjectState = {
	readonly sockets: () => ReadonlyArray<WebSocket>;
	readonly setAlarm: (at: number) => Effect.Effect<void>;
	readonly clearAlarm: Effect.Effect<void>;
	readonly flush: Effect.Effect<void>;
	readonly abort: (reason: string) => Effect.Effect<never>;
	readonly background: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<void>;
};

export class DurableObjectContext extends Context.Service<DurableObjectContext, ObjectState>()("tardigrade/DurableObjectContext") {
	static readonly layer = (ctx: DurableObjectState) =>
		Layer.succeed(DurableObjectContext, {
			sockets: () => ctx.getWebSockets(),
			setAlarm: (at) => Effect.promise(() => ctx.storage.setAlarm(at)),
			clearAlarm: Effect.promise(() => ctx.storage.deleteAlarm()),
			flush: Effect.promise(() => ctx.storage.sync()),
			abort: (reason) => Effect.sync(() => ctx.abort(reason)).pipe(Effect.andThen(Effect.never)),
			background: (effect) => Effect.sync(() => ctx.waitUntil(Effect.runPromise(Effect.ignoreCause(effect)))),
		});
}

export class Store extends Context.Service<Store, Meta>()("tardigrade/Store") {
	static readonly layer = (storage: DurableObjectStorage) => Layer.sync(Store, () => new Meta(storage));
}

const sendTo = (socket: WebSocket, data: string) =>
	Effect.try({ try: () => socket.send(data), catch: (cause) => new SocketSendFailed({ reason: String(cause) }) }).pipe(
		Effect.catchTag("SocketSendFailed", () => Effect.sync(() => socket.close(1011, "send failed"))),
	);

export type Broadcaster = {
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

export const someIf = <A>(holds: boolean, value: A): Option.Option<A> => (holds ? Option.some(value) : Option.none());
