import { Clock, Effect, Option, Schema } from "effect";

export type AccessConfig = { readonly teamDomain: string; readonly audience: string };

export class AccessDenied extends Schema.TaggedError<AccessDenied>()("AccessDenied", { reason: Schema.String }) {}

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

const CLOCK_SKEW_SECONDS = 60;

const KEYS_TTL_MS = 10 * 60_000;

const TeamDomain = Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/));

const Audience = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

const decodeConfig = Schema.decodeUnknownOption(Schema.Struct({ teamDomain: TeamDomain, audience: Audience }));

export const accessConfig = (teamDomain: string | undefined, audience: string | undefined): Option.Option<AccessConfig> =>
	decodeConfig({ teamDomain: teamDomain?.replace(/\/+$/, ""), audience });

const JwtHeader = Schema.Struct({ alg: Schema.Literal("RS256"), kid: Schema.String });

const JwtClaims = Schema.Struct({
	iss: Schema.String,
	aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
	exp: Schema.Number,
	nbf: Schema.optional(Schema.Number),
	email: Schema.optional(Schema.String),
	sub: Schema.String,
});

const SigningKey = Schema.Struct({ kid: Schema.String, kty: Schema.Literal("RSA"), n: Schema.String, e: Schema.String });

const KeySet = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });

const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(JwtHeader));

const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(JwtClaims));

const decodeKeySet = Schema.decodeUnknownEffect(KeySet);

const decodeSigningKey = Schema.decodeUnknownOption(SigningKey);

export type AccessIdentity = { readonly email: Option.Option<string>; readonly subject: string };

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");

	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const bytesOf = (segment: string) => Effect.try({ try: () => fromBase64Url(segment), catch: () => deny("malformed token") });

const textOf = (segment: string) => bytesOf(segment).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));

const deny = (reason: string) => new AccessDenied({ reason });

const cachedKeys = new Map<string, { readonly keys: ReadonlyMap<string, CryptoKey>; readonly until: number }>();

const importKey = (key: typeof SigningKey.Type) =>
	Effect.tryPromise({
		try: () => crypto.subtle.importKey("jwk", { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
		catch: () => deny("bad signing key"),
	}).pipe(Effect.map((imported): readonly [string, CryptoKey] => [key.kid, imported]));

const fetchKeys = (teamDomain: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({ try: () => fetch(`${teamDomain}/cdn-cgi/access/certs`), catch: () => deny("could not fetch Access keys") });

		if (!response.ok) return yield* Effect.fail(deny(`Access keys returned ${response.status}`));

		const body = yield* Effect.tryPromise({ try: () => response.json(), catch: () => deny("Access keys were not JSON") });
		const { keys } = yield* decodeKeySet(body).pipe(Effect.mapError(() => deny("Access keys had an unexpected shape")));
		const signing = keys.flatMap((key) => Option.toArray(decodeSigningKey(key)));

		return new Map(yield* Effect.forEach(signing, importKey));
	});

const keysFor = (teamDomain: string, forceRefresh: boolean) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const cached = cachedKeys.get(teamDomain);

		if (!forceRefresh && cached !== undefined && cached.until > now) return cached.keys;

		const keys = yield* fetchKeys(teamDomain);

		cachedKeys.set(teamDomain, { keys, until: now + KEYS_TTL_MS });

		return keys;
	});

const keyFor = (teamDomain: string, kid: string) =>
	keysFor(teamDomain, false).pipe(
		Effect.flatMap((keys) => (keys.has(kid) ? Effect.succeed(keys) : keysFor(teamDomain, true))),
		Effect.flatMap((keys) => Option.match(Option.fromNullishOr(keys.get(kid)), { onNone: () => Effect.fail(deny("unknown signing key")), onSome: Effect.succeed })),
	);

const verifySignature = (key: CryptoKey, signed: string, signature: string) =>
	bytesOf(signature).pipe(
		Effect.flatMap((signatureBytes) =>
			Effect.tryPromise({
				try: () => crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, new TextEncoder().encode(signed)),
				catch: () => deny("could not verify signature"),
			}),
		),
		Effect.flatMap((valid) => (valid ? Effect.void : Effect.fail(deny("bad signature")))),
	);

const isSingleAudience = Schema.is(Schema.String);

const audienceMatches = (aud: string | ReadonlyArray<string>, expected: string): boolean => (isSingleAudience(aud) ? aud === expected : aud.includes(expected));

export const verifyAccessToken = (config: AccessConfig, token: string) =>
	Effect.gen(function* () {
		const [headerPart, claimsPart, signature, ...rest] = token.split(".");

		if (headerPart === undefined || claimsPart === undefined || signature === undefined || rest.length > 0) return yield* Effect.fail(deny("malformed token"));

		const header = yield* textOf(headerPart).pipe(Effect.flatMap((text) => decodeHeader(text).pipe(Effect.mapError(() => deny("bad token header")))));
		const claims = yield* textOf(claimsPart).pipe(Effect.flatMap((text) => decodeClaims(text).pipe(Effect.mapError(() => deny("bad token claims")))));
		const key = yield* keyFor(config.teamDomain, header.kid);

		yield* verifySignature(key, `${headerPart}.${claimsPart}`, signature);

		const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;

		if (claims.iss !== config.teamDomain) return yield* Effect.fail(deny("wrong issuer"));

		if (!audienceMatches(claims.aud, config.audience)) return yield* Effect.fail(deny("wrong audience"));

		if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return yield* Effect.fail(deny("token expired"));

		if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) return yield* Effect.fail(deny("token not yet valid"));

		return { email: Option.fromNullishOr(claims.email), subject: claims.sub } satisfies AccessIdentity;
	});

const cookieToken = (request: Request): Option.Option<string> =>
	Option.fromNullishOr(
		request.headers
			.get("Cookie")
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("CF_Authorization="))
			?.slice("CF_Authorization=".length),
	);

export const accessToken = (request: Request): Option.Option<string> => Option.orElse(Option.fromNullishOr(request.headers.get(ACCESS_HEADER)), () => cookieToken(request));
