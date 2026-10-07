import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { type Conversation, createRegistry, defineExtension, defineTool, Harness, LiveDoc, section } from "@earendil-works/pi-durable";
import { Clock, Effect, Option, Result, Schema } from "effect";
import {
	BlocksFrame,
	BackEvent,
	BusyFrame,
	type ConversationName,
	EventsFrame,
	FailedEvent,
	KilledEvent,
	FileNotFound,
	FilesFrame,
	KilledFrame,
	KillOutcomeJson,
	type Live,
	LiveFrame,
	NothingRunning,
	ReadOutcomeJson,
	RevivedFrame,
	RunFailedFrame,
	SendOutcomeJson,
	type ServerFrame,
	ServerFrameJson,
	type Snapshot,
	SnapshotJson,
	SnapshotFrame,
	StillWorking,
	type TimelineEvent,
} from "../shared/protocol";
import { Repo, type RepoFiles } from "./files";
import { openDurableObjectSqliteStorage } from "./vendor/pi-durable-do-sqlite";
import { bindingAuthContext, routeWorkersAIThroughBinding } from "./model";
import { Meta } from "./meta";
import { decodePiLiveState, decodePiMessages, isBetweenSteps, type PiLiveState, toBlocks, toLive } from "./view";

export const DEFAULT_MODEL = "@cf/zai-org/glm-5.3";

const CONTEXT = BACKGROUND_CONTEXT;

const HISTORY_LIMIT = 500;

const WATCHDOG_MS = 15_000;

const REVIVE_AFTER_MS = 1_000;

const PROMPT = [
	"You are tardigrade, a coding agent whose work survives crashes.",
	"Your workspace is a git repository. Every file you write becomes a commit.",
	"Use list_files and read_file before changing existing files. Use write_file to create or replace a whole file.",
	"Do the work instead of describing it. When finished, reply in one or two short sentences.",
].join("\n");

export type AgentEnv = { readonly AI: Ai; readonly ARTIFACTS: Artifacts; readonly MODEL?: string };

const Pending = Schema.Struct({ id: Schema.String, text: Schema.String });

const PendingJson = Schema.fromJsonString(Pending);

const encodePending = Schema.encodeSync(PendingJson);

const decodePending = Schema.decodeUnknownOption(PendingJson);

const encodeFrame = Schema.encodeSync(ServerFrameJson);

const encodeSnapshot = Schema.encodeSync(SnapshotJson);

const encodeSend = Schema.encodeSync(SendOutcomeJson);

const encodeKill = Schema.encodeSync(KillOutcomeJson);

const encodeRead = Schema.encodeSync(ReadOutcomeJson);

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

type Opened = { readonly conversation: Conversation; readonly repo: RepoFiles };

export class Agent extends DurableObject<AgentEnv> {
	private readonly meta: Meta;
	private opened: Option.Option<Opened> = Option.none();
	private opening: Option.Option<Promise<Opened>> = Option.none();
	private driving = false;
	private live: Option.Option<PiLiveState> = Option.none();
	private lastLiveChange = 0;

	constructor(ctx: DurableObjectState, env: AgentEnv) {
		super(ctx, env);
		this.meta = new Meta(ctx.storage);
		routeWorkersAIThroughBinding(env.AI);
	}

	private get model(): string {
		return this.env.MODEL ?? DEFAULT_MODEL;
	}

	private broadcast(frame: ServerFrame): void {
		const data = encodeFrame(frame);

		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(data);
			} catch {
				socket.close(1011, "send failed");
			}
		}
	}

	private tools(repo: RepoFiles) {
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
							Effect.tap(() => Effect.sync(() => this.ctx.waitUntil(this.pushFiles(repo)))),
							Effect.map(({ oid, changed }) => text(`${changed ? `Committed ${oid.slice(0, 7)}` : "Already up to date"}: ${args.path}`)),
						),
					),
			}),
		];
	}

	private open(name: Option.Option<ConversationName>): Promise<Opened> {
		if (Option.isSome(this.opened)) return Promise.resolve(this.opened.value);

		if (Option.isSome(this.opening)) return this.opening.value;

		Option.map(name, (value) => this.meta.claimName(value));

		const opening = this.openHarness().finally(() => {
			this.opening = Option.none();
		});

		this.opening = Option.some(opening);

		return opening;
	}

	private async openHarness(): Promise<Opened> {
		const repo = await Effect.runPromise(Effect.service(Repo).pipe(Effect.provide(Repo.layer(this.env.ARTIFACTS, `tg-${this.meta.name()}`))));
		const models = createModels({ authContext: bindingAuthContext });

		models.setProvider(cloudflareWorkersAIProvider());

		const registry = createRegistry();

		registry.install(defineExtension({ name: "tardigrade", sections: [section("preamble", () => PROMPT, { tag: false })], tools: this.tools(repo) }));

		const harness = await Harness.open(await openDurableObjectSqliteStorage(this.ctx.storage), { models, registry }, CONTEXT);
		const conversation = await harness.root(CONTEXT, { agent: { model: { provider: "cloudflare-workers-ai", modelId: this.model } } });
		const watch = await harness.watchDoc(LiveDoc, conversation.id, CONTEXT);
		const opened = { conversation, repo };

		watch?.start(async (value) => this.onLive(opened, decodePiLiveState(value)));
		this.opened = Option.some(opened);
		harness.resume();
		this.resumePending(opened);

		return opened;
	}

	private async onLive(opened: Opened, live: Option.Option<PiLiveState>): Promise<void> {
		this.live = live;
		this.lastLiveChange = Date.now();
		this.broadcast(LiveFrame.make({ live: this.liveView() }));

		if (this.driving && Option.match(this.live, { onNone: () => true, onSome: isBetweenSteps })) {
			this.ctx.waitUntil(this.pushBlocks(opened));
		}
	}

	private liveView(): Option.Option<Live> {
		const quietForMs = Date.now() - this.lastLiveChange;

		return Option.map(this.live, (state) => toLive(state, quietForMs));
	}

	private async blockCount(opened: Opened): Promise<number> {
		return (await this.blocks(opened)).length;
	}

	private record(event: TimelineEvent): void {
		this.broadcast(EventsFrame.make({ events: this.meta.addEvent(event) }));
	}

	private resumePending(opened: Opened): void {
		const pending = this.meta.pending().pipe(Option.flatMap(decodePending));
		const killedAt = this.meta.takeKill();

		this.ctx.waitUntil(this.recordComeback(opened, killedAt, Option.isSome(pending)));
		Option.map(pending, ({ id, text }) => this.drive(opened, id, text));
	}

	private async recordComeback(opened: Opened, killedAt: Option.Option<number>, resumed: boolean): Promise<void> {
		if (Option.isNone(killedAt)) return;

		const at = Date.now();

		this.record(BackEvent.make({ at, afterBlock: await this.blockCount(opened), afterMs: at - killedAt.value, lives: this.meta.lives(), resumed }));
		this.broadcast(RevivedFrame.make({ lives: this.meta.lives() }));
	}

	private drive(opened: Opened, id: string, input: string): void {
		if (this.driving) return;

		this.driving = true;
		this.broadcast(BusyFrame.make({ busy: true }));
		this.ctx.waitUntil(this.runToEnd(opened, id, input));
	}

	private async runToEnd(opened: Opened, id: string, input: string): Promise<void> {
		await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);

		try {
			const submission = await opened.conversation.submit({ type: "input", content: input, requestId: id }, CONTEXT);
			const settled = await submission.wait(CONTEXT);

			if (settled.status !== "done") await this.recordFailure(opened, `Run ended: ${settled.status}`);
		} catch (error) {
			await this.recordFailure(opened, String(error));
		} finally {
			this.meta.clearPending();
			this.driving = false;
			this.live = Option.none();
			await this.ctx.storage.deleteAlarm();
			this.broadcast(BusyFrame.make({ busy: false }));
			this.broadcast(SnapshotFrame.make({ snapshot: await this.snapshot(opened) }));
		}
	}

	private async recordFailure(opened: Opened, reason: string): Promise<void> {
		this.record(FailedEvent.make({ at: Date.now(), afterBlock: await this.blockCount(opened), reason }));
		this.broadcast(RunFailedFrame.make({ reason }));
	}

	private async blocks(opened: Opened) {
		const page = await opened.conversation.entries({}, HISTORY_LIMIT, undefined, CONTEXT);
		const messages = [...page.items].reverse().flatMap((entry) => entry.model ?? []);

		return toBlocks(Option.getOrElse(decodePiMessages(messages), () => []));
	}

	private async pushBlocks(opened: Opened): Promise<void> {
		this.broadcast(BlocksFrame.make({ blocks: await this.blocks(opened) }));
	}

	private async pushFiles(repo: RepoFiles): Promise<void> {
		const { files, commits } = await Effect.runPromise(Effect.all({ files: repo.list, commits: repo.log }));

		this.broadcast(FilesFrame.make({ files, commits }));
	}

	private async snapshot(opened: Opened): Promise<Snapshot> {
		const [blocks, files, commits] = await Promise.all([this.blocks(opened), Effect.runPromise(opened.repo.list), Effect.runPromise(opened.repo.log)]);

		return {
			name: this.meta.name(),
			model: this.model,
			lives: this.meta.lives(),
			busy: this.driving,
			blocks,
			live: this.liveView(),
			files,
			commits,
			events: this.meta.events(),
			killedAt: this.meta.killedAt(),
		};
	}

	async getSnapshot(name: ConversationName): Promise<string> {
		return encodeSnapshot(await this.snapshot(await this.open(Option.some(name))));
	}

	async send(name: ConversationName, input: string): Promise<string> {
		const opened = await this.open(Option.some(name));

		if (Option.isSome(this.meta.pending())) return encodeSend(Result.fail(new StillWorking()));

		const id = crypto.randomUUID();

		this.meta.setPending(encodePending({ id, text: input }));
		this.drive(opened, id, input);

		return encodeSend(Result.succeed({ id }));
	}

	async kill(name: ConversationName): Promise<string> {
		const opened = await this.open(Option.some(name));

		if (Option.isNone(this.meta.pending())) return encodeKill(Result.fail(new NothingRunning()));

		const killedAt = Date.now();

		this.meta.recordKill(killedAt);
		this.meta.addEvent(KilledEvent.make({ at: killedAt, afterBlock: await this.blockCount(opened), wasBusy: this.driving }));
		this.broadcast(EventsFrame.make({ events: this.meta.events() }));
		this.broadcast(KilledFrame.make({ killedAt }));
		await this.ctx.storage.setAlarm(Date.now() + REVIVE_AFTER_MS);
		await this.ctx.storage.sync();
		this.ctx.abort("killed from the UI");

		return encodeKill(Result.succeed(undefined));
	}

	async readFile(name: ConversationName, path: string): Promise<string> {
		const { repo } = await this.open(Option.some(name));
		const missing = () => encodeRead(Result.fail(new FileNotFound({ path })));

		return Effect.runPromise(
			repo.read(path).pipe(
				Effect.map(Option.match({ onSome: (body) => encodeRead(Result.succeed(body)), onNone: missing })),
				Effect.catchTag("InvalidPath", () => Effect.sync(missing)),
			),
		);
	}

	override async fetch(request: Request): Promise<Response> {
		const name = this.meta.nameFromUrl(request.url);
		const opened = await this.open(name);
		const pair = new WebSocketPair();

		this.ctx.acceptWebSocket(pair[1]);
		pair[1].send(encodeFrame(SnapshotFrame.make({ snapshot: await this.snapshot(opened) })));

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
		socket.close(code, "bye");
	}

	override async alarm(): Promise<void> {
		await this.open(Option.none());

		if (Option.isSome(this.meta.pending())) await this.ctx.storage.setAlarm((await Effect.runPromise(Clock.currentTimeMillis)) + WATCHDOG_MS);
	}
}
