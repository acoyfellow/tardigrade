import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AgentRpcs, ConversationName, KillOutcomeJson, ReadOutcomeJson, RPC_PATH, SendOutcomeJson, SnapshotJson } from "../shared/protocol";
import { Agent, type AgentEnv } from "./agent";

export { Agent };

type Env = AgentEnv & { readonly AGENT: DurableObjectNamespace<Agent>; readonly ASSETS: Fetcher };

const SOCKET_ROUTE = /^\/api\/c\/([^/]+)\/ws$/;

const PAGE_ROUTE = /^\/c\/([^/]+)\/?$/;

const decodeName = Schema.decodeUnknownOption(ConversationName);

export const isSameOrigin = (request: Request): boolean => request.headers.get("Origin") === new URL(request.url).origin;

const refuse = (status: number, reason: string) => new Response(reason, { status });

const agentFor = (env: Env, name: ConversationName) => env.AGENT.getByName(name);

const decodeSnapshot = Schema.decodeEffect(SnapshotJson);

const decodeSend = Schema.decodeEffect(SendOutcomeJson);

const decodeKill = Schema.decodeEffect(KillOutcomeJson);

const decodeRead = Schema.decodeEffect(ReadOutcomeJson);

const call = <A>(promise: () => Promise<A>): Effect.Effect<A> => Effect.promise(promise);

const handlers = (env: Env) =>
	AgentRpcs.toLayer({
		Snapshot: ({ name }) => call((): Promise<string> => agentFor(env, name).getSnapshot(name)).pipe(Effect.flatMap(decodeSnapshot), Effect.orDie),
		Send: ({ name, text }) =>
			call((): Promise<string> => agentFor(env, name).send(name, text)).pipe(Effect.flatMap(decodeSend), Effect.orDie, Effect.flatMap(Effect.fromResult)),
		Kill: ({ name }) =>
			Effect.tryPromise((): Promise<string> => agentFor(env, name).kill(name)).pipe(
				Effect.flatMap(decodeKill),
				Effect.flatMap(Effect.fromResult),
				Effect.catchTags({ UnknownError: () => Effect.void, SchemaError: Effect.die }),
			),
		ReadFile: ({ name, path }) =>
			call((): Promise<string> => agentFor(env, name).readFile(name, path)).pipe(Effect.flatMap(decodeRead), Effect.orDie, Effect.flatMap(Effect.fromResult)),
	});

const buildRpcHandler = (env: Env) =>
	HttpRouter.toWebHandler(
		RpcServer.layerHttp({ group: AgentRpcs, path: RPC_PATH, protocol: "http" }).pipe(
			Layer.provide(handlers(env)),
			Layer.provide(RpcSerialization.layerJson),
		),
		{ disableLogger: true },
	).handler;

const rpcHandlers = new WeakMap<Env, ReturnType<typeof buildRpcHandler>>();

const rpcHandler = (env: Env): ReturnType<typeof buildRpcHandler> => {
	const cached = rpcHandlers.get(env);

	if (cached !== undefined) return cached;

	const built = buildRpcHandler(env);

	rpcHandlers.set(env, built);

	return built;
};

const rpcRequest = (request: Request): Request => {
	const url = new URL(request.url);

	url.pathname = RPC_PATH;

	return new Request(url, request);
};

const socket = (request: Request, env: Env, rawName: string): Promise<Response> =>
	Option.match(decodeName(rawName), {
		onNone: () => Promise.resolve(refuse(400, "bad conversation name")),
		onSome: (name) => {
			const inner = new URL(request.url);

			inner.searchParams.set("name", name);

			return agentFor(env, name).fetch(new Request(inner, request));
		},
	});

const page = (request: Request, env: Env, rawName: string): Promise<Response> =>
	Option.match(decodeName(rawName), {
		onNone: () => env.ASSETS.fetch(request),
		onSome: () => env.ASSETS.fetch(new Request(new URL("/", request.url), request)),
	});

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		const isWrite = request.method !== "GET" || request.headers.get("Upgrade") === "websocket";

		if (pathname.startsWith("/api/") && isWrite && !isSameOrigin(request)) return refuse(403, "cross-origin request refused");

		if (pathname === RPC_PATH || pathname === `${RPC_PATH}/`) return rpcHandler(env)(rpcRequest(request), Context.empty());

		const socketMatch = SOCKET_ROUTE.exec(pathname);

		if (socketMatch?.[1] !== undefined) {
			return request.headers.get("Upgrade") === "websocket" ? socket(request, env, socketMatch[1]) : refuse(426, "expected websocket");
		}

		if (pathname.startsWith("/api/")) return refuse(404, "not found");

		const pageMatch = PAGE_ROUTE.exec(pathname);

		return pageMatch?.[1] !== undefined && request.method === "GET" ? page(request, env, pageMatch[1]) : env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
