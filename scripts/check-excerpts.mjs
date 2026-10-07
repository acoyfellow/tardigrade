import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");

const SOURCES = ["worker/agent.ts", "worker/conversation.ts", "worker/harness.ts", "worker/services.ts", "client/src/story.test.ts", "client/src/update.ts"];

const normalized = (text) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("\n");

const sources = normalized(SOURCES.map((path) => readFileSync(path, "utf8")).join("\n"));

const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]);

const drifted = blocks.filter((block) => !sources.includes(normalized(block)));

for (const block of drifted) console.error(`README excerpt is not in the source:\n${block.split("\n").slice(0, 3).join("\n")}\n`);

console.log(`${blocks.length - drifted.length} of ${blocks.length} README excerpts match the source`);

process.exit(drifted.length === 0 ? 0 : 1);
