import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { type Conversation, createRegistry, defineExtension, defineTool, Harness, LiveDoc, section } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import { type Block, FilesFrame } from "../shared/protocol";
import { Repo, type RepoFiles } from "./files";
import { bindingAuthContext } from "./model";
import { Broadcast } from "./services";
import { openDurableObjectSqliteStorage } from "./vendor/pi-durable-do-sqlite";
import { decodePiLiveState, decodePiMessages, type PiLiveState, toBlocks } from "./view";

export const CONTEXT = BACKGROUND_CONTEXT;

const HISTORY_LIMIT = 500;

const PROMPT = [
	"You are tardigrade, a coding agent whose work survives crashes.",
	"Your workspace is a git repository. Every file you write becomes a commit.",
	"Use list_files and read_file before changing existing files. Use write_file to create or replace a whole file.",
	"Do the work instead of describing it. When finished, reply in one or two short sentences.",
].join("\n");

export class HarnessFailed extends Schema.TaggedError<HarnessFailed>()("HarnessFailed", { step: Schema.String, reason: Schema.String }) {}

export class RunEnded extends Schema.TaggedError<RunEnded>()("RunEnded", { status: Schema.String }) {}

const pi = <A>(step: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => new HarnessFailed({ step, reason: String(cause) }) });

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export type FilesChanged = (repo: RepoFiles) => Effect.Effect<void>;

const tools = (repo: RepoFiles, filesChanged: FilesChanged) => {
	const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

	return [
		defineTool({
			name: "list_files",
			description: "List every file in the repository.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: () => run(repo.list.pipe(Effect.map((files) => text(files.length > 0 ? files.join("\n") : "(empty repository)")))),
		}),
		defineTool({
			name: "read_file",
			description: "Read a file from the repository.",
			parameters: Type.Object({ path: Type.String() }),
			replay: "safe",
			execute: (args) =>
				run(
					repo.read(args.path).pipe(
						Effect.map(Option.match({ onSome: text, onNone: () => text(`No such file: ${args.path}`) })),
						Effect.catchTag("InvalidPath", ({ path }) => Effect.succeed(text(`Invalid path: ${path}`))),
					),
				),
		}),
		defineTool({
			name: "write_file",
			description: "Create or replace a whole file. Each call is one git commit.",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
				message: Type.Optional(Type.String({ description: "Commit message" })),
			}),
			replay: "safe",
			executionMode: "sequential",
			execute: (args) =>
				run(
					repo.write(args.path, args.content, args.message ?? `Write ${args.path}`).pipe(
						Effect.tap(() => filesChanged(repo)),
						Effect.map(({ oid, changed }) => text(`${changed ? `Committed ${oid.slice(0, 7)}` : "Already up to date"}: ${args.path}`)),
					),
				),
		}),
	];
};

export type Agentic = {
	readonly repo: RepoFiles;
	readonly live: Stream.Stream<Option.Option<PiLiveState>>;
	readonly blocks: Effect.Effect<ReadonlyArray<Block>, HarnessFailed>;
	readonly run: (requestId: string, input: string) => Effect.Effect<void, HarnessFailed | RunEnded>;
};

export class Pi extends Context.Service<Pi, Agentic>()("tardigrade/Pi") {
	static readonly layer = (options: { readonly storage: DurableObjectStorage; readonly model: string }) =>
		Layer.effect(
			Pi,
			Effect.gen(function* () {
				const repo = yield* Repo;
				const broadcast = yield* Broadcast;

				const filesChanged: FilesChanged = (changed) =>
					Effect.all({ files: changed.list, commits: changed.log }).pipe(
						Effect.flatMap(({ files, commits }) => broadcast.send(FilesFrame.make({ files, commits }))),
						Effect.ignore,
					);

				const models = createModels({ authContext: bindingAuthContext });

				models.setProvider(cloudflareWorkersAIProvider());

				const registry = createRegistry();

				registry.install(defineExtension({ name: "tardigrade", sections: [section("preamble", () => PROMPT, { tag: false })], tools: tools(repo, filesChanged) }));

				const harness = yield* Effect.acquireRelease(
					pi("open", async () => Harness.open(await openDurableObjectSqliteStorage(options.storage), { models, registry }, CONTEXT)),
					(opened) => Effect.promise(() => opened.close(CONTEXT).catch(() => undefined)),
				);

				const conversation: Conversation = yield* pi("root", () =>
					harness.root(CONTEXT, { agent: { model: { provider: "cloudflare-workers-ai", modelId: options.model } } }),
				);

				const watch = yield* pi("watch", () => harness.watchDoc(LiveDoc, conversation.id, CONTEXT));

				const live = Stream.callback<Option.Option<PiLiveState>>((queue) =>
					Effect.acquireRelease(
						Effect.sync(() =>
							watch?.start(async (value) => {
								Queue.offerUnsafe(queue, decodePiLiveState(value));
							}),
						),
						() => Effect.promise(() => watch?.stop() ?? Promise.resolve(undefined)),
					),
				);

				const blocks = pi("entries", () => conversation.entries({}, HISTORY_LIMIT, undefined, CONTEXT)).pipe(
					Effect.map((page) => [...page.items].reverse().flatMap((entry) => entry.model ?? [])),
					Effect.map((messages) => toBlocks(Option.getOrElse(decodePiMessages(messages), () => []))),
				);

				const run = (requestId: string, input: string) =>
					pi("submit", () => conversation.submit({ type: "input", content: input, requestId }, CONTEXT)).pipe(
						Effect.flatMap((submission) => pi("wait", () => submission.wait(CONTEXT))),
						Effect.flatMap((settled) => (settled.status === "done" ? Effect.void : Effect.fail(new RunEnded({ status: settled.status })))),
						Effect.withSpan("pi.run", { attributes: { requestId } }),
					);

				harness.resume();

				return { repo, live, blocks, run };
			}),
		);
}
