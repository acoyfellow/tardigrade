import { Array as Arr, Match, Option, Schema } from "effect";
import { ActivityLine, type Block, type Live, ReplyBlock, ThoughtBlock, ToolBlock, UserBlock } from "../shared/protocol";

const RESULT_LINE_LIMIT = 90;

const THOUGHT_SETTLE_MS = 2500;

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ThinkingPart = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String });

const ImagePart = Schema.Struct({ type: Schema.Literal("image") });

const ToolArguments = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)]);

const ToolCallPart = Schema.Struct({
	type: Schema.Literal("toolCall"),
	id: Schema.String,
	name: Schema.String,
	arguments: Schema.optional(ToolArguments),
});

const UserMessage = Schema.Struct({
	role: Schema.Literal("user"),
	content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextPart, ImagePart]))]),
});

const AssistantMessage = Schema.Struct({
	role: Schema.Literal("assistant"),
	content: Schema.Array(Schema.Union([TextPart, ThinkingPart, ToolCallPart])),
});

const ToolResultMessage = Schema.Struct({
	role: Schema.Literal("toolResult"),
	toolCallId: Schema.String,
	content: Schema.Array(Schema.Union([TextPart, ImagePart])),
	isError: Schema.Boolean,
});

const SystemMessage = Schema.Struct({ role: Schema.Literal("system") });

export const PiMessage = Schema.Union([UserMessage, AssistantMessage, ToolResultMessage, SystemMessage]);

export type PiMessage = typeof PiMessage.Type;

type AssistantMessage = typeof AssistantMessage.Type;

type ToolResultMessage = typeof ToolResultMessage.Type;

type ToolCallPart = typeof ToolCallPart.Type;

const ToolSlot = Schema.Struct({ name: Schema.String, status: Schema.Literals(["pending", "running", "done"]) });

export const PiLiveState = Schema.Struct({
	generation: Schema.optional(Schema.Struct({ message: Schema.optional(AssistantMessage) })),
	tools: Schema.optional(Schema.Array(ToolSlot)),
});

export type PiLiveState = typeof PiLiveState.Type;

export const decodePiMessages = Schema.decodeUnknownOption(Schema.Array(PiMessage));

export const decodePiLiveState = Schema.decodeUnknownOption(PiLiveState);

const decodeArgumentsJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));

const decodeStringField = Schema.decodeUnknownOption(Schema.String);

const argumentsOf = (part: ToolCallPart): Readonly<Record<string, Schema.Json>> =>
	Match.value(part.arguments).pipe(
		Match.when(Match.undefined, () => ({})),
		Match.when(Match.string, (raw) => Option.getOrElse(decodeArgumentsJson(raw), () => ({}))),
		Match.orElse((parsed) => parsed),
	);

const stringField = (record: Readonly<Record<string, Schema.Json>>, key: string): string =>
	Option.getOrElse(decodeStringField(record[key]), () => "");

const textOf = (parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
	parts.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");

const HARNESS_TAG = new RegExp("</?harness>", "g");

const ERROR_PREFIX = "[error]";

const withoutErrorPrefix = (text: string): string => (text.startsWith(ERROR_PREFIX) ? text.slice(ERROR_PREFIX.length) : text);

const firstResultLine = (message: ToolResultMessage): string =>
	withoutErrorPrefix(textOf(message.content).replaceAll(HARNESS_TAG, "").trim())
		.trim()
		.split("\n")[0]
		?.slice(0, RESULT_LINE_LIMIT) ?? "";

const toolBlock = (part: ToolCallPart, results: ReadonlyMap<string, ToolResultMessage>): ToolBlock => {
	const args = argumentsOf(part);
	const result = Option.fromNullishOr(results.get(part.id));

	return ToolBlock.make({
		callId: part.id,
		name: part.name,
		path: stringField(args, "path"),
		draft: stringField(args, "content"),
		result: Option.map(result, (message) => ({ line: firstResultLine(message), isError: message.isError })),
	});
};

const assistantBlocks = (message: AssistantMessage, results: ReadonlyMap<string, ToolResultMessage>): Block[] =>
	message.content.flatMap((part): Block[] =>
		Match.value(part).pipe(
			Match.discriminatorsExhaustive("type")({
				text: ({ text }) => (text === "" ? [] : [ReplyBlock.make({ text })]),
				thinking: ({ thinking }) => (thinking === "" ? [] : [ThoughtBlock.make({ text: thinking })]),
				toolCall: (call) => [toolBlock(call, results)],
			}),
		),
	);

const resultsOf = (messages: ReadonlyArray<PiMessage>): ReadonlyMap<string, ToolResultMessage> =>
	new Map(messages.flatMap((message) => (message.role === "toolResult" ? [[message.toolCallId, message] as const] : [])));

export const toBlocks = (messages: ReadonlyArray<PiMessage>): Block[] => {
	const results = resultsOf(messages);

	return messages.flatMap((message): Block[] =>
		Match.value(message).pipe(
			Match.discriminatorsExhaustive("role")({
				user: ({ content }) => {
					const text = Match.value(content).pipe(Match.when(Match.string, (value) => value), Match.orElse(textOf));

					return text === "" ? [] : [UserBlock.make({ text })];
				},
				assistant: (assistant) => assistantBlocks(assistant, results),
				toolResult: () => [],
				system: () => [],
			}),
		),
	);
};

const line = ActivityLine.make;

const activityOf = (state: PiLiveState, quietForMs: number): ActivityLine => {
	const running = (state.tools ?? []).filter((tool) => tool.status !== "done").map((tool) => tool.name);

	if (Arr.isReadonlyArrayNonEmpty(running)) return line({ activity: "running", detail: running.join(", ") });

	const last = Option.fromNullishOr(state.generation?.message?.content.at(-1));

	return Option.match(last, {
		onNone: () => line({ activity: "waiting", detail: "" }),
		onSome: (part) =>
			Match.value(part).pipe(
				Match.discriminatorsExhaustive("type")({
					toolCall: (call) =>
						call.name === "write_file"
							? line({ activity: "writing", detail: stringField(argumentsOf(call), "path") })
							: line({ activity: "calling", detail: call.name }),
					thinking: () => line({ activity: quietForMs > THOUGHT_SETTLE_MS ? "replying" : "thinking", detail: "" }),
					text: () => line({ activity: "replying", detail: "" }),
				}),
			),
	});
};

export const toLive = (state: PiLiveState, quietForMs: number): Live => ({
	...activityOf(state, quietForMs),
	blocks: Option.match(Option.fromNullishOr(state.generation?.message), {
		onNone: () => [],
		onSome: (message) => assistantBlocks(message, new Map()),
	}),
});

export const isBetweenSteps = (state: PiLiveState): boolean => state.generation === undefined;
