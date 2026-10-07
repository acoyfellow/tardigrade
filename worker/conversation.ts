import { Context, Effect, Layer, Option, Ref, Result, Schema, Stream } from "effect";
import {
	BackEvent,
	BlocksFrame,
	BusyFrame,
	EventsFrame,
	FailedEvent,
	FileNotFound,
	FilesUnavailable,
	KilledEvent,
	KilledFrame,
	KILLED_FROM_THE_UI,
	type Live,
	LiveFrame,
	KillNotSaved,
	NothingRunning,
	RestartedEvent,
	RevivedFrame,
	type Snapshot,
	SnapshotFrame,
	StillWorking,
	type TimelineEvent,
} from "../shared/protocol";
import { Model, Pi } from "./harness";
import { Broadcast, DurableObjectContext, now, Store } from "./services";
import { isBetweenSteps, type PiLiveState, toLive } from "./view";

const WATCHDOG_MS = 15_000;

const REVIVE_AFTER_MS = 1_000;

const Pending = Schema.Struct({ id: Schema.String, text: Schema.String });

const PendingJson = Schema.fromJsonString(Pending);

const encodePending = Schema.encodeSync(PendingJson);

const decodePending = Schema.decodeUnknownOption(PendingJson);

type LiveState = { readonly value: Option.Option<PiLiveState>; readonly changedAt: number };

export type Conversation = {
	readonly snapshot: Effect.Effect<Snapshot>;
	readonly send: (text: string) => Effect.Effect<{ readonly id: string }, StillWorking>;
	readonly kill: Effect.Effect<void, NothingRunning | KillNotSaved>;
	readonly readFile: (path: string) => Effect.Effect<string, FileNotFound | FilesUnavailable>;
	readonly keepAlive: Effect.Effect<void>;
};

export class ConversationAgent extends Context.Service<ConversationAgent, Conversation>()("tardigrade/ConversationAgent") {
	static readonly layer = Layer.effect(
			ConversationAgent,
			Effect.gen(function* () {
				const object = yield* DurableObjectContext;
				const store = yield* Store;
				const broadcast = yield* Broadcast;
				const pi = yield* Pi;
				const { modelId: model } = yield* Model;
				const driving = yield* Ref.make(false);
				const live = yield* Ref.make<LiveState>({ value: Option.none(), changedAt: 0 });

				const blocks = pi.blocks.pipe(Effect.orElseSucceed(() => []));

				const blockCount = Effect.map(blocks, (all) => all.length);

				const liveView = Effect.gen(function* () {
					const state = yield* Ref.get(live);
					const at = yield* now;

					return Option.map(state.value, (value): Live => toLive(value, at - state.changedAt));
				});

				const record = (event: TimelineEvent) => Effect.flatMap(store.addEvent(event), (events) => broadcast.send(EventsFrame.make({ events })));

				const pushFiles = pi.filesChanged;

				const snapshot: Effect.Effect<Snapshot> = Effect.gen(function* () {
					const [all, repo] = yield* Effect.all([blocks, Effect.result(Effect.all({ files: pi.repo.list, commits: pi.repo.log }))], { concurrency: "unbounded" });
					const { files, commits } = Result.getOrElse(repo, () => ({ files: [], commits: [] }));

					return {
						name: yield* store.name,
						model,
						lives: yield* store.lives,
						busy: yield* Ref.get(driving),
						blocks: all,
						live: yield* liveView,
						files,
						commits,
						events: yield* store.events,
						killedAt: yield* store.killedAt,
						filesError: Result.match(repo, { onSuccess: () => Option.none(), onFailure: (error) => Option.some(`Files are unavailable: ${error._tag}`) }),
					};
				});

				const fail = (reason: string) =>
					Effect.gen(function* () {
						yield* record(FailedEvent.make({ at: yield* now, afterBlock: yield* blockCount, reason }));
					});

				const finish = Effect.gen(function* () {
					yield* store.clearPending;
					yield* Ref.set(driving, false);
					yield* Ref.set(live, { value: Option.none(), changedAt: yield* now });
					yield* object.clearAlarm.pipe(Effect.catchTag("StorageFailed", (error) => Effect.logWarning("could not clear the watchdog", error.reason)));
					yield* broadcast.send(BusyFrame.make({ busy: false }));
					yield* broadcast.send(SnapshotFrame.make({ snapshot: yield* snapshot }));
				});

				const runToEnd = (id: string, text: string) =>
					Effect.gen(function* () {
						yield* object.setAlarm((yield* now) + WATCHDOG_MS);
						yield* pi.run(id, text);
					}).pipe(
						Effect.catchTags({
							RunEnded: ({ status }) => fail(`Run ended: ${status}`),
							HarnessFailed: ({ step, reason }) => fail(`${step}: ${reason}`),
							StorageFailed: ({ step, reason }) => fail(`Storage ${step} failed: ${reason}`),
						}),
						Effect.ensuring(finish),
					);

				const drive = (id: string, text: string) =>
					Effect.gen(function* () {
						if (yield* Ref.getAndSet(driving, true)) return;

						yield* broadcast.send(BusyFrame.make({ busy: true }));
						yield* object.background(runToEnd(id, text));
					});

				const onLive = (value: Option.Option<PiLiveState>) =>
					Effect.gen(function* () {
						yield* Ref.set(live, { value, changedAt: yield* now });
						yield* broadcast.send(LiveFrame.make({ live: yield* liveView }));

						const settled = Option.match(value, { onNone: () => true, onSome: isBetweenSteps });

						if ((yield* Ref.get(driving)) && settled) yield* broadcast.send(BlocksFrame.make({ blocks: yield* blocks }));
					});

				const revival = Effect.gen(function* () {
					const at = yield* now;
					const afterBlock = yield* blockCount;
					const killedAt = yield* store.takeKill;
					const pending = Option.flatMap(yield* store.pending, decodePending);

					if (Option.isNone(killedAt) && Option.isSome(pending)) yield* store.recordRestart;

					const lives = yield* store.lives;

					const comeback: Option.Option<TimelineEvent> = Option.isSome(killedAt)
						? Option.some(BackEvent.make({ at, afterBlock, afterMs: at - killedAt.value, lives, resumed: Option.isSome(pending) }))
						: Option.isSome(pending)
							? Option.some(RestartedEvent.make({ at, afterBlock, lives }))
							: Option.none();

					const events = Option.isSome(comeback) ? yield* store.addEvent(comeback.value) : [];

					return { lives, events, comeback, pending };
				});

				const comeBack = ({ lives, events, comeback, pending }: Effect.Success<typeof revival>) =>
					Effect.gen(function* () {
						if (Option.isNone(comeback)) return;

						yield* broadcast.send(EventsFrame.make({ events }));
						yield* broadcast.send(RevivedFrame.make({ lives }));

						if (Option.isSome(pending)) yield* drive(pending.value.id, pending.value.text);
					});

				const send = (text: string) =>
					Effect.gen(function* () {
						if (Option.isSome(yield* store.pending)) return yield* Effect.fail(new StillWorking());

						const id = crypto.randomUUID();

						yield* store.setPending(encodePending({ id, text }));
						yield* drive(id, text);

						return { id };
					});

				const kill = Effect.gen(function* () {
					const at = yield* now;
					const running = Option.isSome(yield* store.pending) && Option.isNone(yield* store.killedAt);

					if (!running) return yield* Effect.fail(new NothingRunning());

					yield* store.recordKill(at);

					const wasBusy = yield* Ref.get(driving);

					const events = yield* store.addEvent(KilledEvent.make({ at, afterBlock: yield* blockCount, wasBusy }));

					yield* object.setAlarm(at + REVIVE_AFTER_MS).pipe(Effect.andThen(object.flush), Effect.mapError(({ step, reason }) => new KillNotSaved({ reason: `${step}: ${reason}` })));
					yield* broadcast.send(EventsFrame.make({ events }));
					yield* broadcast.send(KilledFrame.make({ killedAt: at }));

					return yield* object.abort(KILLED_FROM_THE_UI);
				});

				const readFile = (path: string) =>
					pi.repo.read(path).pipe(
						Effect.catchTag("InvalidPath", () => Effect.succeed(Option.none<string>())),
						Effect.catchTag("RepoUnavailable", (error) => Effect.fail(new FilesUnavailable({ reason: String(error.cause) }))),
						Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => Effect.fail(new FileNotFound({ path })) })),
					);

				const keepAlive = Effect.gen(function* () {
					if (Option.isSome(yield* store.pending)) yield* object.setAlarm((yield* now) + WATCHDOG_MS);
				}).pipe(Effect.catchTag("StorageFailed", (error) => Effect.logError("could not re-arm the watchdog", error.reason)));

				yield* object.background(Stream.runForEach(pi.live, onLive));
				yield* object.background(comeBack(yield* revival));
				yield* object.background(pushFiles(pi.repo));

				return { snapshot, send, kill, readFile, keepAlive };
			}),
		);
}
