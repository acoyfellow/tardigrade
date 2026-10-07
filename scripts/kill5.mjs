const BASE = process.env.BASE ?? "http://127.0.0.1:8787";

const KILLS = Number(process.env.KILLS ?? 5);

const KILL_EVERY_MS = Number(process.env.KILL_EVERY_MS ?? 7000);

const FINISH_WITHIN_MS = Number(process.env.FINISH_WITHIN_MS ?? 300_000);

const TASK = process.env.TASK ?? "Build a small landing page for a bakery in index.html";

const name = `c-${crypto.randomUUID()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let requestId = 0;

const rpc = async (tag, payload) => {
	requestId += 1;

	const response = await fetch(`${BASE}/api/rpc`, {
		method: "POST",
		headers: { Origin: BASE, "content-type": "application/json" },
		body: JSON.stringify({ _tag: "Request", id: String(requestId), tag, payload: { name, ...payload }, headers: [] }),
	});

	const [reply] = await response.json();

	if (reply?._tag !== "Exit") throw new Error(`${tag}: ${JSON.stringify(reply)}`);

	return reply.exit;
};

const snapshot = async () => {
	const exit = await rpc("Snapshot", {});

	if (exit._tag !== "Success") throw new Error(`Snapshot failed: ${JSON.stringify(exit)}`);

	return exit.value;
};

const snapshotOrNull = () => snapshot().catch(() => null);

console.log(name);

console.log("send", (await rpc("Send", { text: TASK }))._tag);

for (let kill = 1; kill <= KILLS; kill += 1) {
	await sleep(KILL_EVERY_MS);

	const before = await snapshotOrNull();

	if (before && !before.busy) {
		console.log(`finished before kill ${kill}`);
		break;
	}

	const killed = await rpc("Kill", {}).then(
		() => "ok",
		(error) => `failed: ${error.message}`,
	);

	if (killed !== "ok") console.log(`kill ${kill} ${killed}`);
	await sleep(2500);

	const after = await snapshotOrNull();

	console.log(`kill ${kill}: lives=${after?.lives} busy=${after?.busy}`);
}

const deadline = Date.now() + FINISH_WITHIN_MS;

let final = await snapshotOrNull();

while ((final === null || final.busy) && Date.now() < deadline) {
	await sleep(3000);
	final = await snapshotOrNull();
}

const result = {
	lives: final?.lives,
	busy: final?.busy,
	commits: final?.commits.length,
	files: final?.files,
	replies: final?.blocks.filter((block) => block._tag === "Reply").length,
	timeline: final?.events.map((event) => event._tag).join(","),
};

console.log(JSON.stringify(result));

const recordedKills = final?.events.filter((event) => event._tag === "Killed").length;

const recordedComebacks = final?.events.filter((event) => event._tag === "Back").length;

const passed =
	result.lives === KILLS + 1 && result.busy === false && result.commits >= 1 && result.files.length >= 1 && recordedKills === KILLS && recordedComebacks === KILLS;

process.exit(passed ? 0 : 1);
