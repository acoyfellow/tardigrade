import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");

const normalized = (text) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("\n");

const linkedSource = (offset) => {
	const links = [...readme.slice(0, offset).matchAll(/\]\(([^)#\s]+\.ts)[^)]*\)/g)];

	return links.at(-1)?.[1];
};

const excerpts = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => ({ code: match[1], source: linkedSource(match.index) }));

const drifted = excerpts.filter(({ code, source }) => source === undefined || !normalized(readFileSync(source, "utf8")).includes(normalized(code)));

for (const { code, source } of drifted) console.error(`README excerpt is not in ${source ?? "any linked file"}:\n${code.split("\n").slice(0, 3).join("\n")}\n`);

console.log(`${excerpts.length - drifted.length} of ${excerpts.length} README excerpts match the file linked above them`);

process.exit(drifted.length === 0 ? 0 : 1);
