import { resolve } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { unstable_startWorker } from "wrangler";

const Outcome = Schema.fromJsonString(
	Schema.Struct({ lives: Schema.Number, files: Schema.Array(Schema.String), commits: Schema.Number, timeline: Schema.Array(Schema.String), kills: Schema.Array(Schema.String) }),
);

const decodeOutcome = Schema.decodeUnknownSync(Outcome);

test("a Durable Object killed three times with ctx.abort() mid-task comes back each time and finishes, offline in workerd", { timeout: 90_000 }, async () => {
	const worker = await unstable_startWorker({
		config: resolve("test/revival/wrangler.jsonc"),
		dev: { server: { port: 0 }, inspector: false, logLevel: "error", persist: false },
	});

	try {
		const response = await worker.fetch(`http://revival/?name=r-${crypto.randomUUID()}`);
		const outcome = decodeOutcome(await response.text());

		expect(outcome.kills).toEqual(["busy:killed from the UI", "busy:killed from the UI", "busy:killed from the UI"]);
		expect(outcome.lives).toBe(4);
		expect(outcome.timeline).toEqual(["Killed", "Back", "Killed", "Back", "Killed", "Back"]);
		expect(outcome.files).toEqual(["index.html"]);
		expect(outcome.commits).toBeGreaterThanOrEqual(1);
	} finally {
		await worker.dispose();
	}
});
