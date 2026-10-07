import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer, Option, Schema } from "effect";
import { Agent, conversationLayer } from "../../worker/agent";
import { PushRejected, Repo } from "../../worker/files";
import { storedRepo } from "./stored-repo";
import { Model } from "../../worker/harness";
import { ConversationName, KILLED_FROM_THE_UI, SnapshotJson } from "../../shared/protocol";

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
		return conversationLayer(ctx, scripted(), storedRepo(ctx.storage));
	}
}

const rejectingPushes = Layer.succeed(Repo, {
	list: Effect.succeed([]),
	read: () => Effect.succeed(Option.none()),
	log: Effect.succeed([]),
	write: () => Effect.fail(new PushRejected({ repo: "test", cause: new Error("push rejected by the test") })),
});

export class RejectingAgent extends Agent {
	protected override layer(ctx: DurableObjectState) {
		return conversationLayer(ctx, scripted(), rejectingPushes);
	}
}

const decodeSnapshot = Schema.decodeUnknownSync(SnapshotJson);

type Env = { readonly AGENT: DurableObjectNamespace<RevivalAgent>; readonly REJECTING: DurableObjectNamespace<RejectingAgent> };

const sleep = (ms: number) => Effect.runPromise(Effect.sleep(ms));

const rejecting = async (env: Env): Promise<Response> => {
	const name = ConversationName.make(`r-${crypto.randomUUID()}`);
	const agent = () => env.REJECTING.getByName(name);

	await agent().send(name, "Build a bakery page");

	for (let i = 0; i < 100; i += 1) {
		await sleep(300);
		const current = decodeSnapshot(await agent().getSnapshot(name));

		if (!current.busy) {
			const toolResults = current.blocks.flatMap((block) => (block._tag === "Tool" ? Option.toArray(block.result).map((result) => `${result.isError ? "error" : "ok"}: ${result.line}`) : []));

			return Response.json({ lives: current.lives, files: current.files, commits: current.commits.length, timeline: current.events.map((event) => event._tag), kills: toolResults });
		}
	}

	return Response.json({ timedOut: true }, { status: 500 });
};

export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/rejecting") return rejecting(env);

		const name = ConversationName.make(new URL(request.url).searchParams.get("name") ?? "revival");
		const agent = () => env.AGENT.getByName(name);
		const snapshot = async () => decodeSnapshot(await agent().getSnapshot(name));

		await agent().send(name, "Build a bakery page");

		const kills: string[] = [];

		for (let kill = 0; kill < KILLS; kill += 1) {
			await sleep(KILL_EVERY_MS);
			const before = await snapshot().catch(() => undefined);

			kills.push(`${before?.busy ? "busy" : "idle"}:${await agent().kill(name).then(() => "returned", (error: Error) => (String(error).includes(KILLED_FROM_THE_UI) ? "aborted" : String(error)))}`);
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
