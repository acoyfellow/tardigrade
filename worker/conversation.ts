import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import {
	BackEvent,
	BlocksFrame,
	BusyFrame,
	EventsFrame,
	FailedEvent,
	FileNotFound,
	FilesFrame,
	KilledEvent,
	KilledFrame,
	type Live,
	LiveFrame,
	NothingRunning,
	ResumedEvent,
	RevivedFrame,
	RunFailedFrame,
	type Snapshot,
	SnapshotFrame,
	StillWorking,
	type TimelineEvent,
} from "../shared/protocol";
import type { RepoFiles } from "./files";
import { Pi } from "./harness";
import { Broadcast, DurableObjectContext, now, Store } from "./services";
import { isBetweenSteps, type PiLiveState, toLive } from "./view";

const WATCHDOG_MS = 15_000;

const REVIVE_AFTER_MS = 1_000;

const KILL_COOLDOWN_MS = 1_000;

const Pending = Schema.Struct({ id: Schema.String, text: Schema.String });

const PendingJson = Schema.fromJsonString(Pending);

const encodePending = Schema.encodeSync(PendingJson);

const decodePending = Schema.decodeUnknownOption(PendingJson);

type LiveState = { readonly value: Option.Option<PiLiveState>; readonly changedAt: number };

export type Conversation = {
	readonly snapshot: Effect.Effect<Snapshot>;
	readonly send: (text: string) => Effect.Effect<{ readonly id: string }, StillWorking>;
	readonly kill: Effect.Effect<void, NothingRunning>;
	readonly readFile: (path: string) => Effect.Effect<string, FileNotFound>;
	readonly keepAlive: Effect.Effect<void>;
};

export class Agent extends Context.Service<Agent, Conversation>()("tardigrade/Agent") {
	static readonly layer = (model: string) =>
		Layer.effect(
			Agent,
			Effect.gen(function* () {
				const object = yield* DurableObjectContext;
				const store = yield* Store;
				const broadcast = yield* Broadcast;
				const pi = yield* Pi;
				const driving = yield* Ref.make(false);
				const live = yield* Ref.make<LiveState>({ value: Option.none(), changedAt: 0 });

				const blocks = pi.blocks.pipe(Effect.orElseSucceed(() => []));

				const blockCount = Effect.map(blocks, (all) => all.length);

				const liveView = Effect.gen(function* () {
					const state = yield* Ref.get(live);
					const at = yield* now;

					return Option.map(state.value, (value): Live => toLive(value, at - state.changedAt));
				});

				const record = (event: TimelineEvent) => broadcast.send(EventsFrame.make({ events: store.addEvent(event) }));

				const pushFiles = (repo: RepoFiles) =>
					Effect.all({ files: repo.list, commits: repo.log }).pipe(
						Effect.flatMap(({ files, commits }) => broadcast.send(FilesFrame.make({ files, commits }))),
						Effect.ignore,
					);

				const snapshot: Effect.Effect<Snapshot> = Effect.gen(function* () {
					const [all, files, commits] = yield* Effect.all([blocks, pi.repo.list.pipe(Effect.orElseSucceed(() => [])), pi.repo.log.pipe(Effect.orElseSucceed(() => []))], {
						concurrency: "unbounded",
					});

					return {
						name: store.name(),
						model,
						lives: store.lives(),
						busy: yield* Ref.get(driving),
						blocks: all,
						live: yield* liveView,
						files,
						commits,
						events: store.events(),
						killedAt: store.killedAt(),
					};
				});

				const fail = (reason: string) =>
					Effect.gen(function* () {
						yield* record(FailedEvent.make({ at: yield* now, afterBlock: yield* blockCount, reason }));
						yield* broadcast.send(RunFailedFrame.make({ reason }));
					});

				const finish = Effect.gen(function* () {
					store.clearPending();
					yield* Ref.set(driving, false);
					yield* Ref.set(live, { value: Option.none(), changedAt: yield* now });
					yield* object.clearAlarm;
					yield* broadcast.send(BusyFrame.make({ busy: false }));
					yield* broadcast.send(SnapshotFrame.make({ snapshot: yield* snapshot }));
				});

				const runToEnd = (id: string, text: string) =>
					Effect.gen(function* () {
						yield* object.setAlarm((yield* now) + WATCHDOG_MS);
						yield* pi.run(id, text).pipe(
							Effect.catchTags({
								RunEnded: ({ status }) => fail(`Run ended: ${status}`),
								HarnessFailed: ({ step, reason }) => fail(`${step}: ${reason}`),
							}),
						);
					}).pipe(Effect.ensuring(finish));

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
					const killedAt = store.takeKill();
					const pending = store.pending().pipe(Option.flatMap(decodePending));

					store.recordRevival(at);

					if (Option.isNone(killedAt) && Option.isSome(pending)) store.recordRestart();

					return { at, killedAt, pending };
				});

				const comeBack = ({ at, killedAt, pending }: Effect.Success<typeof revival>) =>
					Effect.gen(function* () {
						if (Option.isNone(killedAt) && Option.isNone(pending)) return;

						const afterBlock = yield* blockCount;

						if (Option.isSome(killedAt)) {
							yield* record(BackEvent.make({ at, afterBlock, afterMs: at - killedAt.value, lives: store.lives(), resumed: Option.isSome(pending) }));
						} else {
							yield* record(ResumedEvent.make({ at, afterBlock, lives: store.lives() }));
						}

						yield* broadcast.send(RevivedFrame.make({ lives: store.lives() }));

						if (Option.isSome(pending)) yield* drive(pending.value.id, pending.value.text);
					});

				const send = (text: string) =>
					Effect.gen(function* () {
						if (Option.isSome(store.pending())) return yield* Effect.fail(new StillWorking());

						const id = crypto.randomUUID();

						store.setPending(encodePending({ id, text }));
						yield* drive(id, text);

						return { id };
					});

				const kill = Effect.gen(function* () {
					const at = yield* now;
					const running = Option.isSome(store.pending()) && Option.isNone(store.killedAt()) && !store.revivedWithin(at, KILL_COOLDOWN_MS);

					if (!running) return yield* Effect.fail(new NothingRunning());

					store.recordKill(at);
					store.addEvent(KilledEvent.make({ at, afterBlock: yield* blockCount, wasBusy: yield* Ref.get(driving) }));
					yield* object.setAlarm(at + REVIVE_AFTER_MS);
					yield* object.flush;
					yield* broadcast.send(EventsFrame.make({ events: store.events() }));
					yield* broadcast.send(KilledFrame.make({ killedAt: at }));

					return yield* object.abort("killed from the UI");
				});

				const readFile = (path: string) =>
					pi.repo.read(path).pipe(
						Effect.catchTag("InvalidPath", () => Effect.succeed(Option.none<string>())),
						Effect.orElseSucceed(() => Option.none<string>()),
						Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => Effect.fail(new FileNotFound({ path })) })),
					);

				const keepAlive = Effect.gen(function* () {
					if (Option.isSome(store.pending())) yield* object.setAlarm((yield* now) + WATCHDOG_MS);
				});

				yield* object.background(Stream.runForEach(pi.live, onLive));
				yield* object.background(comeBack(yield* revival));
				yield* object.background(pushFiles(pi.repo));

				return { snapshot, send, kill, readFile, keepAlive };
			}),
		);
}
