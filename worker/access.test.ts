import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { type AccessConfig, accessConfig, type AccessDenied, verifyAccessToken } from "./access";

const TEAM = "https://tardigrade-test.cloudflareaccess.com";

const AUD = "a".repeat(64);

const config: AccessConfig = { teamDomain: TEAM, audience: AUD };

const base64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

type Claims = { readonly iss: string; readonly aud: ReadonlyArray<string>; readonly exp: number; readonly sub: string; readonly email: string };

type Header = { readonly alg: string; readonly kid: string };

const encodeJson = (value: Claims | Header): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

type TestKeys = { pair: Option.Option<CryptoKeyPair>; other: Option.Option<CryptoKeyPair> };

const keys: TestKeys = { pair: Option.none(), other: Option.none() };

const generate = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

beforeAll(async () => {
	keys.pair = Option.some(await generate());
	keys.other = Option.some(await generate());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const pairOf = (which: "pair" | "other"): CryptoKeyPair => Option.getOrThrow(keys[which]);

const serveKeys = async (kid: string) => {
	const jwk = await crypto.subtle.exportKey("jwk", pairOf("pair").publicKey);

	vi.stubGlobal("fetch", async () => Response.json({ keys: [{ kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }] }));
};

const sign = async (claims: Claims, signer: "pair" | "other" = "pair", kid = "key-1"): Promise<string> => {
	const signed = `${encodeJson({ alg: "RS256", kid })}.${encodeJson(claims)}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pairOf(signer).privateKey, new TextEncoder().encode(signed));

	return `${signed}.${base64Url(new Uint8Array(signature))}`;
};

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

const goodClaims = (): Claims => ({ iss: TEAM, aud: [AUD], exp: inAnHour(), sub: "user-1", email: "owner@example.com" });

const verify = (token: string) => Effect.runPromiseExit(verifyAccessToken(config, token));

const reasonOf = (exit: Exit.Exit<unknown, AccessDenied>): string =>
	Exit.match(exit, { onSuccess: () => "succeeded", onFailure: (cause) => Option.match(Cause.findErrorOption(cause), { onNone: () => "defect", onSome: ({ reason }) => reason }) });

test("accepts a token signed by the team key for this application", async () => {
	await serveKeys("key-1");

	const exit = await verify(await sign(goodClaims()));

	expect(Exit.isSuccess(exit)).toBe(true);
});

test.each([
	["a different audience", { aud: ["b".repeat(64)] }, "wrong audience"],
	["a different team", { iss: "https://someone-else.cloudflareaccess.com" }, "wrong issuer"],
	["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }, "token expired"],
] as const)("rejects %s", async (_label, override: Partial<Claims>, reason) => {
	await serveKeys("key-1");

	expect(reasonOf(await verify(await sign({ ...goodClaims(), ...override })))).toContain(reason);
});

test("rejects a token signed by another key", async () => {
	await serveKeys("key-1");

	expect(reasonOf(await verify(await sign(goodClaims(), "other")))).toContain("bad signature");
});

test("rejects a token whose key the team does not publish", async () => {
	await serveKeys("key-1");

	expect(reasonOf(await verify(await sign(goodClaims(), "pair", "key-unknown")))).toContain("unknown signing key");
});

test("rejects garbage", async () => {
	await serveKeys("key-1");

	expect(reasonOf(await verify("not-a-token"))).toContain("malformed token");
	expect(reasonOf(await verify("a.b.c"))).toContain("malformed token");
	expect(reasonOf(await verify("!!.@@.##"))).toContain("malformed token");
});

test("treats missing or malformed configuration as not configured", () => {
	expect(Option.isNone(accessConfig(undefined, undefined))).toBe(true);
	expect(Option.isNone(accessConfig("", ""))).toBe(true);
	expect(Option.isNone(accessConfig("https://evil.example.com", AUD))).toBe(true);
	expect(Option.isSome(accessConfig(`${TEAM}/`, AUD))).toBe(true);
});
