import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { AgentRpcs, AgentUnavailable, ConversationName, KillOutcomeJson, ReadOutcomeJson, RPC_PATH, SendOutcomeJson, SnapshotJson } from "../shared/protocol";
import { accessConfig, accessToken, verifyAccessToken } from "./access";
import { Agent, type AgentEnv } from "./agent";

export { Agent };

type Env = AgentEnv & {
	readonly AGENT: DurableObjectNamespace<Agent>;
	readonly ASSETS: Fetcher;
	readonly ACCESS_TEAM_DOMAIN?: string;
	readonly ACCESS_AUD?: string;
	readonly LOCAL_DEV_WITHOUT_ACCESS?: string;
};

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

const unavailable = (cause: unknown) => new AgentUnavailable({ reason: String(cause) });

const call = <A>(promise: () => Promise<A>): Effect.Effect<A, AgentUnavailable> => Effect.tryPromise({ try: promise, catch: unavailable });

const isKilled = Predicate.isTagged("Killed");

const storedKills = (env: Env, name: ConversationName) =>
	call(() => agentFor(env, name).getSnapshot(name)).pipe(
		Effect.flatMap(decodeSnapshot),
		Effect.catchTag("SchemaError", Effect.die),
		Effect.map((snapshot) => snapshot.events.filter(isKilled).length),
	);

const handlers = (env: Env) =>
	AgentRpcs.toLayer({
		Snapshot: ({ name }) => call(() => agentFor(env, name).getSnapshot(name)).pipe(Effect.flatMap(decodeSnapshot), Effect.catchTag("SchemaError", Effect.die)),
		Send: ({ name, text }) =>
			call(() => agentFor(env, name).send(name, text)).pipe(Effect.flatMap(decodeSend), Effect.catchTag("SchemaError", Effect.die), Effect.flatMap(Effect.fromResult)),
		Kill: ({ name }) =>
			Effect.gen(function* () {
				const before = yield* storedKills(env, name);

				return yield* call(() => agentFor(env, name).kill(name)).pipe(
					Effect.flatMap(decodeKill),
					Effect.catchTag("SchemaError", Effect.die),
					Effect.flatMap(Effect.fromResult),
					Effect.catchTag("AgentUnavailable", (dropped) =>
						storedKills(env, name).pipe(
							Effect.orElseSucceed(() => before),
							Effect.flatMap((after) => (after > before ? Effect.void : Effect.fail(dropped))),
						),
					),
				);
			}),
		ReadFile: ({ name, path }) =>
			call(() => agentFor(env, name).readFile(name, path)).pipe(Effect.flatMap(decodeRead), Effect.catchTag("SchemaError", Effect.die), Effect.flatMap(Effect.fromResult)),
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLocalDev = (request: Request, env: Env): boolean => env.LOCAL_DEV_WITHOUT_ACCESS === "1" && LOCAL_HOSTS.has(new URL(request.url).hostname);

const NOT_CONFIGURED = "tardigrade is locked: set ACCESS_TEAM_DOMAIN and ACCESS_AUD and put the hostname behind Cloudflare Access. See README, Deploy.";

const admit = (request: Request, env: Env): Promise<Option.Option<Response>> => {
	if (isLocalDev(request, env)) return Promise.resolve(Option.none());

	return Option.match(accessConfig(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD), {
		onNone: () => Promise.resolve(Option.some(refuse(503, NOT_CONFIGURED))),
		onSome: (config) =>
			Option.match(accessToken(request), {
				onNone: () => Promise.resolve(Option.some(refuse(401, "sign in through Cloudflare Access"))),
				onSome: (token) =>
					Effect.runPromise(
						verifyAccessToken(config, token).pipe(
							Effect.as(Option.none()),
							Effect.catchTag("AccessDenied", ({ reason }) => Effect.succeed(Option.some(refuse(403, `Access token rejected: ${reason}`)))),
						),
					),
			}),
	});
};

export default {
	async fetch(request, env) {
		const denied = await admit(request, env);

		if (Option.isSome(denied)) return denied.value;

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
