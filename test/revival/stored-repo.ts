import { Clock, Effect, Layer, Option, Schema } from "effect";
import type { Commit } from "../../shared/protocol";
import { cleanPath, Repo, type RepoFiles } from "../../worker/files";

const FilesJson = Schema.fromJsonString(Schema.Struct({ files: Schema.Record(Schema.String, Schema.String), commits: Schema.Array(Schema.Struct({ oid: Schema.String, message: Schema.String, time: Schema.Number })) }));

const decodeStoredFiles = Schema.decodeUnknownOption(FilesJson);

const encodeStoredFiles = Schema.encodeSync(FilesJson);

const STORED_FILES_KEY = "stored-repo";

const inStorage = (kv: SyncKvStorage) =>
	Effect.sync(() => {
		type Stored = { readonly files: Readonly<Record<string, string>>; readonly commits: ReadonlyArray<Commit> };

		const load = (): Stored => Option.getOrElse(decodeStoredFiles(kv.get(STORED_FILES_KEY)), (): Stored => ({ files: {}, commits: [] }));

		const list = Effect.sync(() => Object.keys(load().files).sort());

		const read = (path: string) => cleanPath(path).pipe(Effect.map((file) => Option.fromNullishOr(load().files[file])));

		const log = Effect.sync(() => load().commits);

		const write = (path: string, content: string, message: string) =>
			Effect.gen(function* () {
				const file = yield* cleanPath(path);
				const stored = load();

				if (stored.files[file] === content) return { oid: stored.commits[0]?.oid ?? "", changed: false };

				const commit: Commit = { oid: crypto.randomUUID().replaceAll("-", ""), message, time: yield* Clock.currentTimeMillis };

				kv.put(STORED_FILES_KEY, encodeStoredFiles({ files: { ...stored.files, [file]: content }, commits: [commit, ...stored.commits] }));

				return { oid: commit.oid, changed: true };
			});

		return { list, read, log, write } satisfies RepoFiles;
	});

export const storedRepo = (storage: DurableObjectStorage) => Layer.effect(Repo, inStorage(storage.kv));
