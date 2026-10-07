import { resolve } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { unstable_startWorker } from "wrangler";

const Results = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean, error: Schema.String })));

const decodeResults = Schema.decodeUnknownSync(Results);

test("Pi Durable's storage conformance suite passes on Durable Object SQLite inside workerd", { timeout: 60_000 }, async () => {
	const worker = await unstable_startWorker({
		config: resolve("test/conformance/wrangler.jsonc"),
		dev: { server: { port: 0 }, inspector: false, logLevel: "error" },
	});

	try {
		const results = decodeResults(await (await worker.fetch("http://suite/")).text());

		expect(results.length).toBeGreaterThan(20);
		expect(results.filter((result) => !result.ok)).toEqual([]);
	} finally {
		await worker.dispose();
	}
});
