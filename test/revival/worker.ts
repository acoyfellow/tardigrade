import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer, Schema } from "effect";
import { Agent, conversationLayer } from "../../worker/agent";
import { Repo } from "../../worker/files";
import { Model } from "../../worker/harness";
import { ConversationName, SnapshotJson } from "../../shared/protocol";

const KILLS = 3;

const KILL_EVERY_MS = 1_600;

const PAGE = "<!doctype html><title>bakery</title><h1>Fresh bread</h1>";

const wroteThePage = (context: { readonly messages: ReadonlyArray<{ readonly role: string; readonly toolName?: string }> }) =>
	context.messages.some((message) => message.role === "toolResult" && message.toolName === "write_file");

const scripted = () => {
	const faux = fauxProvider({ tokensPerSecond: 20 });

	faux.setResponses(
		Array.from({ length: 50 }, () => (context: { readonly messages: ReadonlyArray<{ readonly role: string; readonly toolName?: string }> }) =>
			!wroteThePage(context)
				? fauxAssistantMessage([fauxText("Writing the page now. ".repeat(80)), fauxToolCall("write_file", { path: "index.html", content: PAGE, message: "Add the bakery page" })], { stopReason: "toolUse" })
				: fauxAssistantMessage(fauxText("Done: index.html has the bakery page.")),
		),
	);

	return Layer.succeed(Model, { provider: faux.provider, modelId: faux.models[0].id, options: {} });
};

export class RevivalAgent extends Agent {
	protected override layer(ctx: DurableObjectState) {
		return conversationLayer(ctx, scripted(), Repo.inObjectStorage(ctx.storage));
	}
}

const decodeSnapshot = Schema.decodeUnknownSync(SnapshotJson);

type Env = { readonly AGENT: DurableObjectNamespace<RevivalAgent> };

const sleep = (ms: number) => Effect.runPromise(Effect.sleep(ms));

export default {
	async fetch(request, env) {
		const name = ConversationName.make(new URL(request.url).searchParams.get("name") ?? "revival");
		const agent = () => env.AGENT.getByName(name);
		const snapshot = async () => decodeSnapshot(await agent().getSnapshot(name));

		await agent().send(name, "Build a bakery page");

		const kills: string[] = [];

		for (let kill = 0; kill < KILLS; kill += 1) {
			await sleep(KILL_EVERY_MS);
			const before = await snapshot().catch(() => undefined);

			kills.push(`${before?.busy ? "busy" : "idle"}:${await agent().kill(name).catch((error: Error) => error.message.slice(0, 40))}`);
		}

		for (let i = 0; i < 100; i += 1) {
			await sleep(300);
			const current = await snapshot().catch(() => undefined);

			const finished = current?.blocks.some((block) => block._tag === "Reply" && block.text.startsWith("Done")) ?? false;

			if (current !== undefined && !current.busy && finished) {
				return Response.json({ lives: current.lives, files: current.files, commits: current.commits.length, timeline: current.events.map((event) => event._tag), kills });
			}
		}

		return Response.json({ timedOut: true, last: await snapshot().catch(() => null) }, { status: 500 });
	},
} satisfies ExportedHandler<Env>;
