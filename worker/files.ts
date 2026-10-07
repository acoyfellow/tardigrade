import { Clock, Context, Effect, Layer, Option, Predicate, Ref, Schema, Semaphore } from "effect";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { Commit } from "../shared/protocol";
import { MemoryFS } from "./memfs";

const DIRECTORY = "/repo";

const BRANCH = "main";

const AUTHOR = { name: "tardigrade", email: "agent@tardigrade.invalid" };

const TOKEN_TTL_SECONDS = 3600;

const REFRESH_MARGIN_MS = 5 * 60_000;

const LOG_DEPTH = 50;

export class RepoUnavailable extends Schema.TaggedError<RepoUnavailable>()("RepoUnavailable", {
	repo: Schema.String,
	cause: Schema.Defect(),
}) {}

export class InvalidPath extends Schema.TaggedError<InvalidPath>()("InvalidPath", { path: Schema.String }) {}

export class PushRejected extends Schema.TaggedError<PushRejected>()("PushRejected", {
	repo: Schema.String,
	cause: Schema.Defect(),
}) {}

export type WriteResult = { readonly oid: string; readonly changed: boolean };

type Credentials = { readonly remote: string; readonly secret: string; readonly expiresAt: number; readonly fresh: boolean };

export const cleanPath = (path: string): Effect.Effect<string, InvalidPath> => {
	const parts = path.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");

	return parts.length === 0 || parts.some((part) => part === ".." || part === ".git")
		? Effect.fail(new InvalidPath({ path }))
		: Effect.succeed(parts.join("/"));
};

type Token = { readonly secret: string; readonly expiresAt: number };

const tokenParts = (token: string, now: number): Token => {
	const [secret = "", query = ""] = token.split("?expires=");
	const expires = Number(query);
	const expiresAt = Number.isFinite(expires) && expires > 0 ? (expires < 1e12 ? expires * 1000 : expires) : now + TOKEN_TTL_SECONDS * 1000;

	return { secret, expiresAt };
};

const make = (artifacts: Artifacts, repo: string) =>
	Effect.gen(function* () {
		const credentials = yield* Ref.make(Option.none<Credentials>());
		const loaded = yield* Ref.make(Option.none<MemoryFS>());
		const lock = yield* Semaphore.make(1);
		const loadLock = yield* Semaphore.make(1);

		const unavailable = (cause: unknown) => new RepoUnavailable({ repo, cause });

		const existingAccess = (now: number) =>
			Effect.tryPromise({
				try: async (): Promise<Credentials> => {
					const handle = await artifacts.get(repo);
					const [info, token] = await Promise.all([handle.info(), handle.createToken("write", TOKEN_TTL_SECONDS)]);

					return { remote: info.remote, ...tokenParts(token.plaintext, now), fresh: false };
				},
				catch: unavailable,
			});

		const createdAccess = (now: number) =>
			Effect.tryPromise({
				try: async (): Promise<Credentials> => {
					const created = await artifacts.create(repo);

					return { remote: created.remote, ...tokenParts(created.token, now), fresh: true };
				},
				catch: unavailable,
			});

		const authenticate = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;

			const next = yield* existingAccess(now).pipe(
				Effect.catchTag("RepoUnavailable", () => createdAccess(now)),
				Effect.catchTag("RepoUnavailable", () => existingAccess(now)),
			);

			yield* Ref.set(credentials, Option.some(next));

			return next;
		});

		const currentCredentials = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const known = yield* Ref.get(credentials);

			return yield* Option.match(Option.filter(known, (value) => now < value.expiresAt - REFRESH_MARGIN_MS), {
				onSome: Effect.succeed,
				onNone: () => authenticate,
			});
		});

		const onAuth = (secret: string) => () => ({ username: "x", password: secret });

		const remoteHasMain = (access: Credentials) =>
			Effect.tryPromise({
				try: () => git.getRemoteInfo2({ http, url: access.remote, onAuth: onAuth(access.secret) }),
				catch: unavailable,
			}).pipe(Effect.map((info) => (info.refs ?? []).some((ref) => ref.ref === `refs/heads/${BRANCH}`)));

		const cloneInto = (access: Credentials) =>
			Effect.tryPromise({
				try: async () => {
					const fs = new MemoryFS();

					await git.clone({ fs, http, dir: DIRECTORY, url: access.remote, ref: BRANCH, singleBranch: true, onAuth: onAuth(access.secret) });
					await git.resolveRef({ fs, dir: DIRECTORY, ref: `refs/heads/${BRANCH}` });

					return fs;
				},
				catch: unavailable,
			});

		const emptyRepo = Effect.tryPromise({
			try: async () => {
				const fs = new MemoryFS();

				await fs.mkdir(DIRECTORY, { recursive: true });
				await git.init({ fs, dir: DIRECTORY, defaultBranch: BRANCH });

				return fs;
			},
			catch: unavailable,
		});

		const pointHeadAtMain = (fs: MemoryFS) =>
			Effect.tryPromise({
				try: () => git.writeRef({ fs, dir: DIRECTORY, ref: "HEAD", value: `refs/heads/${BRANCH}`, symbolic: true, force: true }),
				catch: unavailable,
			});

		const cloneExisting = (access: Credentials) =>
			cloneInto(access).pipe(
				Effect.catchTag("RepoUnavailable", (error) =>
					remoteHasMain(access).pipe(
						Effect.flatMap((hasMain) => (hasMain ? Effect.fail(error) : emptyRepo)),
					),
				),
				Effect.retry({ times: 1 }),
			);

		const load = Effect.gen(function* () {
			const cached = yield* Ref.get(loaded);

			if (Option.isSome(cached)) return cached.value;

			const access = yield* authenticate;
			const fs = access.fresh ? yield* emptyRepo : yield* cloneExisting(access);

			yield* pointHeadAtMain(fs);
			yield* Ref.set(loaded, Option.some(fs));

			return fs;
		}).pipe(loadLock.withPermits(1), Effect.withSpan("repo.load"));

		const readFrom = (fs: MemoryFS, path: string) =>
			Effect.promise(() => fs.readText(`${DIRECTORY}/${path}`).then(Option.some, () => Option.none<string>()));

		const list: Effect.Effect<ReadonlyArray<string>, RepoUnavailable> = load.pipe(
			Effect.flatMap((fs) => Effect.promise(() => git.listFiles({ fs, dir: DIRECTORY, ref: "HEAD" }).catch((): string[] => []))),
		);

		const read = (path: string) =>
			Effect.gen(function* () {
				const file = yield* cleanPath(path);
				const fs = yield* load;

				return yield* readFrom(fs, file);
			});

		const log: Effect.Effect<ReadonlyArray<Commit>, RepoUnavailable> = load.pipe(
			Effect.flatMap((fs) => Effect.promise(() => git.log({ fs, dir: DIRECTORY, depth: LOG_DEPTH }).catch(() => []))),
			Effect.map((entries) =>
				entries.map((entry): Commit => ({ oid: entry.oid, message: entry.commit.message.trim(), time: entry.commit.committer.timestamp * 1000 })),
			),
		);

		const headOid = (fs: MemoryFS) =>
			Effect.promise(() => git.resolveRef({ fs, dir: DIRECTORY, ref: "HEAD" }).catch(() => ""));

		const commitAndPush = (file: string, content: string, message: string) =>
			Effect.gen(function* () {
				const fs = yield* load;
				const access = yield* currentCredentials;
				const current = yield* readFrom(fs, file);

				if (Option.contains(current, content)) return { oid: yield* headOid(fs), changed: false };

				const oid = yield* Effect.tryPromise({
					try: async () => {
						await fs.writeFile(`${DIRECTORY}/${file}`, content);
						await git.add({ fs, dir: DIRECTORY, filepath: file });

						return git.commit({ fs, dir: DIRECTORY, message, author: AUTHOR });
					},
					catch: unavailable,
				});

				yield* Effect.tryPromise({
					try: () => git.push({ fs, http, dir: DIRECTORY, url: access.remote, ref: BRANCH, onAuth: onAuth(access.secret) }),
					catch: (cause) => new PushRejected({ repo, cause }),
				}).pipe(Effect.tapError(() => Ref.set(loaded, Option.none())));

				return { oid, changed: true };
			});

		const write = (path: string, content: string, message: string): Effect.Effect<WriteResult, InvalidPath | RepoUnavailable | PushRejected> =>
			cleanPath(path).pipe(
				Effect.flatMap((file) => commitAndPush(file, content, message).pipe(Effect.retry({ times: 1, while: Predicate.isTagged("PushRejected") }))),
				lock.withPermits(1),
				Effect.withSpan("repo.write", { attributes: { path } }),
			);

		return { list, read, log, write };
	});

export type RepoFiles = Effect.Success<ReturnType<typeof make>>;

export class Repo extends Context.Service<Repo, RepoFiles>()("tardigrade/Repo") {
	static readonly layer = (artifacts: Artifacts, name: string) => Layer.effect(Repo, make(artifacts, name));
}
