import { type Cause, Duration, Effect, Option, Queue, Schema, Stream } from "effect";
import { ManagedResource, Subscription } from "foldkit";
import { ConversationName, type ServerFrame, ServerFrameJson, socketPath } from "../../shared/protocol";
import { Message } from "./message";
import { type Model, Phase } from "./model";
import type { AgentClient } from "./rpc";

const CONNECT_TIMEOUT = Duration.seconds(5);

const TICK = Duration.millis(250);

type FrameQueue = Queue.Queue<ServerFrame, Cause.Done>;

type Connection = { readonly socket: WebSocket; readonly frames: FrameQueue };

export const AgentSocket = ManagedResource.tag<Connection>()("AgentSocket");

type AgentSocketService = ManagedResource.ServiceOf<typeof AgentSocket>;

const SocketTarget = Schema.Struct({ name: ConversationName, epoch: Schema.Number, failures: Schema.Number });

const MAX_BACKOFF = Duration.seconds(10);

export const reconnectDelay = (failures: number): Duration.Duration =>
	failures === 0 ? Duration.zero : Duration.min(Duration.millis(250 * 2 ** Math.min(failures, 6)), MAX_BACKOFF);

const decodeFrame = Schema.decodeUnknownOption(ServerFrameJson);

class SocketFailed extends Schema.TaggedError<SocketFailed>()("SocketFailed", { reason: Schema.String }) {}

const socketUrl = (name: ConversationName): string => {
	const scheme = globalThis.location.protocol === "https:" ? "wss:" : "ws:";

	return `${scheme}//${globalThis.location.host}${socketPath(name)}`;
};

const bufferFrames = (socket: WebSocket, frames: FrameQueue): void => {
	socket.addEventListener("message", (event: MessageEvent<string>) => {
		Option.map(decodeFrame(event.data), (frame) => Queue.offerUnsafe(frames, frame));
	});
	socket.addEventListener("close", () => Queue.endUnsafe(frames), { once: true });
};

const connect = (name: ConversationName, frames: FrameQueue) =>
	Effect.callback<WebSocket, SocketFailed>((resume) => {
		const socket = new WebSocket(socketUrl(name));
		const opened = () => resume(Effect.succeed(socket));
		const failed = () => resume(Effect.fail(new SocketFailed({ reason: "could not connect" })));

		bufferFrames(socket, frames);
		socket.addEventListener("open", opened, { once: true });
		socket.addEventListener("error", failed, { once: true });

		return Effect.sync(() => {
			socket.removeEventListener("open", opened);
			socket.removeEventListener("error", failed);
			socket.close();
		});
	}).pipe(
		Effect.timeout(CONNECT_TIMEOUT),
		Effect.catchTag("TimeoutError", () => Effect.fail(new SocketFailed({ reason: "timed out" }))),
	);

const open = (name: ConversationName, failures: number) =>
	Effect.gen(function* () {
		yield* Effect.sleep(reconnectDelay(failures));

		const frames = yield* Queue.unbounded<ServerFrame, Cause.Done>();
		const socket = yield* connect(name, frames);

		return { socket, frames };
	});

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
	agentSocket: entry(Schema.Option(SocketTarget), {
		resource: AgentSocket,
		modelToMaybeRequirements: (model) => Option.some({ name: model.name, epoch: model.connectionEpoch, failures: model.failedConnects }),
		acquire: ({ name, failures }) => open(name, failures),
		release: ({ socket }) => Effect.sync(() => socket.close()),
		onAcquired: () => Message.SocketOpened(),
		onReleased: () => Message.SocketClosed(),
		onAcquireError: () => Message.SocketClosed(),
	}),
}));

const framesOf = ({ frames }: Connection): Stream.Stream<Message> =>
	Stream.fromQueue(frames).pipe(
		Stream.map((frame) => Message.ReceivedFrame({ frame })),
		Stream.concat(Stream.succeed(Message.SocketClosed())),
	);

const isDown = Phase.isAnyOf(["Dead", "Reviving"]);

const now = Effect.clockWith((clock) => clock.currentTimeMillis);

export const subscriptions = Subscription.make<Model, Message, AgentSocketService | AgentClient>()((entry) => ({
	frames: entry(
		{ connected: Schema.Boolean, epoch: Schema.Number },
		{
			modelToDependencies: (model) => ({ connected: model.connected, epoch: model.connectionEpoch }),
			dependenciesToStream: ({ connected }) =>
				connected
					? Stream.unwrap(AgentSocket.get.pipe(Effect.map(framesOf), Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Stream.empty))))
					: Stream.empty,
		},
	),
	clock: entry(
		{ ticking: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ ticking: model.busy || isDown(model.phase) }),
			dependenciesToStream: ({ ticking }) => (ticking ? Stream.tick(TICK).pipe(Stream.mapEffect(() => now), Stream.map((at) => Message.Ticked({ now: at }))) : Stream.empty),
		},
	),
}));
