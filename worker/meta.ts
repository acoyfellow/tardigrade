import { Option, Schema } from "effect";
import { ConversationName, TimelineEvent } from "../shared/protocol";

const decodeName = Schema.decodeUnknownOption(ConversationName);

const decodeText = Schema.decodeUnknownOption(Schema.String);

const decodeCount = Schema.decodeUnknownOption(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)));

const EventsJson = Schema.fromJsonString(Schema.Array(TimelineEvent));

const decodeEvents = Schema.decodeUnknownOption(EventsJson);

const encodeEvents = Schema.encodeSync(EventsJson);

const decodeTime = Schema.decodeUnknownOption(Schema.Number);

const EVENT_LIMIT = 200;

const FALLBACK_NAME = ConversationName.make("default");

const Key = {
	name: "name",
	pending: "pending",
	lives: "lives",
	killed: "killed",
	events: "events",
	revivedAt: "revivedAt",
} as const;

export class Meta {
	private readonly kv: SyncKvStorage;

	constructor(storage: DurableObjectStorage) {
		this.kv = storage.kv;
	}

	private text(key: string): Option.Option<string> {
		return decodeText(this.kv.get(key));
	}

	name(): ConversationName {
		return Option.getOrElse(decodeName(this.kv.get(Key.name)), () => FALLBACK_NAME);
	}

	claimName(name: ConversationName): void {
		if (Option.isNone(this.text(Key.name))) this.kv.put(Key.name, name);
	}

	nameFromUrl(url: string): Option.Option<ConversationName> {
		return decodeName(new URL(url).searchParams.get("name"));
	}

	pending(): Option.Option<string> {
		return this.text(Key.pending);
	}

	setPending(encoded: string): void {
		this.kv.put(Key.pending, encoded);
	}

	clearPending(): void {
		this.kv.delete(Key.pending);
	}

	lives(): number {
		return Option.getOrElse(decodeCount(this.kv.get(Key.lives)), () => 1);
	}

	events(): ReadonlyArray<TimelineEvent> {
		return Option.getOrElse(decodeEvents(this.kv.get(Key.events)), () => []);
	}

	addEvent(event: TimelineEvent): ReadonlyArray<TimelineEvent> {
		const events = [...this.events(), event].slice(-EVENT_LIMIT);

		this.kv.put(Key.events, encodeEvents(events));

		return events;
	}

	killedAt(): Option.Option<number> {
		return decodeTime(this.kv.get(Key.killed));
	}

	recordKill(at: number): void {
		this.kv.put(Key.lives, this.lives() + 1);
		this.kv.put(Key.killed, at);
	}

	recordRevival(at: number): void {
		this.kv.put(Key.revivedAt, at);
	}

	revivedWithin(now: number, windowMs: number): boolean {
		return Option.match(decodeTime(this.kv.get(Key.revivedAt)), { onNone: () => false, onSome: (at) => now - at < windowMs });
	}

	recordRestart(): void {
		this.kv.put(Key.lives, this.lives() + 1);
	}

	takeKill(): Option.Option<number> {
		const at = this.killedAt();

		this.kv.delete(Key.killed);

		return at;
	}
}
