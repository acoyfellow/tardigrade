import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { type ConversationName, KillOutcomeJson, ReadOutcomeJson, SendOutcomeJson, SnapshotFrame, SnapshotJson } from "../shared/protocol";
import { Agent as Conversation } from "./conversation";
import { Repo, type RepoUnavailable } from "./files";
import { type HarnessFailed, Model, Pi } from "./harness";
import { routeWorkersAIThroughBinding } from "./model";
import { Meta } from "./meta";
import { Broadcast, DurableObjectContext, Store } from "./services";

export const DEFAULT_MODEL = "@cf/zai-org/glm-5.3";

export type AgentEnv = { readonly AI: Ai; readonly ARTIFACTS: Artifacts; readonly MODEL?: string };

const encodeSnapshot = Schema.encodeSync(SnapshotJson);

const encodeSend = Schema.encodeSync(SendOutcomeJson);

const encodeKill = Schema.encodeSync(KillOutcomeJson);

const encodeRead = Schema.encodeSync(ReadOutcomeJson);

export const conversationLayer = (ctx: DurableObjectState, model: Layer.Layer<Model>, files: Layer.Layer<Repo, RepoUnavailable>) => {
	const object = Layer.mergeAll(DurableObjectContext.layer(ctx), Store.layer(ctx.storage));
	const broadcast = Broadcast.layer.pipe(Layer.provideMerge(object));
	const pi = Pi.layer(ctx.storage).pipe(Layer.provide(files), Layer.provideMerge(model), Layer.provideMerge(broadcast));

	return Conversation.layer.pipe(Layer.provideMerge(pi));
};

const layerFor = (ctx: DurableObjectState, env: AgentEnv, name: ConversationName) =>
	conversationLayer(ctx, Model.workersAI(env.MODEL ?? DEFAULT_MODEL), Repo.layer(env.ARTIFACTS, `tg-${name}`));

const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

const sendableCloseCode = (code: number): number => (RESERVED_CLOSE_CODES.has(code) ? 1000 : code);

type Services = Conversation | Broadcast | Store;

const withAgent = <A, E>(use: (agent: Conversation["Service"]) => Effect.Effect<A, E>): Effect.Effect<A, E, Conversation> =>
	Effect.gen(function* () {
		return yield* use(yield* Conversation);
	});

export class Agent extends DurableObject<AgentEnv> {
	private runtime: Option.Option<ManagedRuntime.ManagedRuntime<Services, HarnessFailed | RepoUnavailable>> = Option.none();

	constructor(ctx: DurableObjectState, env: AgentEnv) {
		super(ctx, env);
		routeWorkersAIThroughBinding(env.AI);
	}

	private run<A, E>(name: Option.Option<ConversationName>, effect: Effect.Effect<A, E, Services>): Promise<A> {
		const runtime = Option.getOrElse(this.runtime, () => {
			const meta = new Meta(this.ctx.storage);

			Option.map(name, (value) => meta.claimName(value));

			const created = ManagedRuntime.make(this.layer(this.ctx, meta.name()));

			this.runtime = Option.some(created);

			return created;
		});

		return runtime.runPromiseExit(effect).then((exit) => (Exit.isSuccess(exit) ? exit.value : this.reset(runtime).then(() => Promise.reject(Cause.squash(exit.cause)))));
	}

	protected layer(ctx: DurableObjectState, name: ConversationName) {
		return layerFor(ctx, this.env, name);
	}

	private reset(runtime: ManagedRuntime.ManagedRuntime<Services, HarnessFailed | RepoUnavailable>): Promise<void> {
		this.runtime = Option.none();

		return runtime.dispose();
	}

	getSnapshot(name: ConversationName): Promise<string> {
		return this.run(Option.some(name), withAgent((agent) => agent.snapshot).pipe(Effect.map(encodeSnapshot)));
	}

	send(name: ConversationName, text: string): Promise<string> {
		return this.run(Option.some(name), withAgent((agent) => agent.send(text)).pipe(Effect.result, Effect.map(encodeSend)));
	}

	kill(name: ConversationName): Promise<string> {
		return this.run(Option.some(name), withAgent((agent) => agent.kill).pipe(Effect.result, Effect.map(encodeKill)));
	}

	readFile(name: ConversationName, path: string): Promise<string> {
		return this.run(Option.some(name), withAgent((agent) => agent.readFile(path)).pipe(Effect.result, Effect.map(encodeRead)));
	}

	override async fetch(request: Request): Promise<Response> {
		const name = new Meta(this.ctx.storage).nameFromUrl(request.url);
		const pair = new WebSocketPair();

		this.ctx.acceptWebSocket(pair[1]);
		await this.run(
			name,
			Effect.gen(function* () {
				const agent = yield* Conversation;
				const broadcast = yield* Broadcast;

				yield* broadcast.sendTo(pair[1], SnapshotFrame.make({ snapshot: yield* agent.snapshot }));
			}),
		);

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
		socket.close(sendableCloseCode(code), "bye");
	}

	override async alarm(): Promise<void> {
		await this.run(Option.none(), withAgent((agent) => agent.keepAlive));
	}
}
