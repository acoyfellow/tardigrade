import { Option, Schema } from "effect";
import { ConversationName } from "../shared/protocol";

const decodeName = Schema.decodeUnknownOption(ConversationName);

const decodeText = Schema.decodeUnknownOption(Schema.String);

const decodeCount = Schema.decodeUnknownOption(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)));

const FALLBACK_NAME = ConversationName.make("default");

const Key = {
	name: "name",
	pending: "pending",
	lives: "lives",
	killed: "killed",
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

	recordKill(): void {
		this.kv.put(Key.lives, this.lives() + 1);
		this.kv.put(Key.killed, true);
	}

	takeKill(): boolean {
		return this.kv.delete(Key.killed);
	}
}
