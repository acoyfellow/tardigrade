import { DurableObject } from "cloudflare:workers";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import type { Json } from "effect/Schema";
import { Effect, Equal, Exit, Schema } from "effect";
import { openDurableObjectSqliteStorage } from "../../worker/vendor/pi-durable-do-sqlite";

const CaseResult = Schema.Struct({ name: Schema.String, ok: Schema.Boolean, error: Schema.String });

type CaseResult = typeof CaseResult.Type;

const encodeResults = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CaseResult)));

class AssertionFailed extends Schema.TaggedError<AssertionFailed>()("AssertionFailed", { reason: Schema.String }) {}

const check = (holds: boolean, reason: string): void => {
	if (!holds) throw new AssertionFailed({ reason });
};

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const isJsonObject = Schema.is(Schema.JsonObject);

const containsJson = (actual: Json, expected: Json): boolean => {
	if (!isJsonObject(expected)) return Equal.equals(Schema.toEquivalence(Schema.Json)(actual, expected), true);

	if (!isJsonObject(actual)) return false;

	return Object.entries(expected).every(([key, value]) => key in actual && containsJson(actual[key] ?? null, value));
};

const rejectsWith = async (operation: Promise<void>, messageIncludes: string): Promise<void> => {
	const exit = await Effect.runPromiseExit(Effect.tryPromise(() => operation));

	check(Exit.isFailure(exit) && String(exit.cause).includes(messageIncludes), `expected rejection containing ${messageIncludes}`);
};

const assertions: StorageConformanceAssertions = {
	ok: (value, message) => check(Boolean(value), message ?? "expected truthy"),
	strictEqual: (actual, expected) => check(Object.is(actual, expected), "expected strictly equal values"),
	deepEqual: (actual, expected) => check(Schema.toEquivalence(Schema.Json)(decodeJsonText(JSON.stringify(actual ?? null)), decodeJsonText(JSON.stringify(expected ?? null))), "expected deeply equal values"),
	partialDeepEqual: (actual, expected) => check(containsJson(decodeJsonText(JSON.stringify(actual ?? null)), decodeJsonText(JSON.stringify(expected ?? null))), "expected a matching subset"),
	greaterThan: (actual, expected) => check(actual > expected, `expected ${actual} > ${expected}`),
	rejects: rejectsWith,
};

const dropTables = (storage: DurableObjectStorage): void => {
	const tables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();

	for (const { name } of tables) storage.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
};

const runCase = (testCase: { readonly name: string; readonly run: () => Promise<void> }) =>
	Effect.tryPromise(testCase.run).pipe(
		Effect.exit,
		Effect.map((exit): CaseResult => ({ name: testCase.name, ok: Exit.isSuccess(exit), error: Exit.isSuccess(exit) ? "" : String(exit.cause) })),
	);

export class Conformance extends DurableObject {
	async run(): Promise<string> {
		const cases = createStorageConformance({
			assertions,
			withStorage: async (use) => {
				dropTables(this.ctx.storage);
				await use(await openDurableObjectSqliteStorage(this.ctx.storage));
			},
		});

		return encodeResults(await Effect.runPromise(Effect.forEach(cases, runCase)));
	}
}

export default {
	fetch: (_request, env) => env.CONFORMANCE.getByName("suite").run().then((body) => new Response(body)),
} satisfies ExportedHandler<{ readonly CONFORMANCE: DurableObjectNamespace<Conformance> }>;
