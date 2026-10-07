import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const LOCK = ".wrangler/tardigrade-dev.pid";

const isAlive = (pid) => {
	try {
		process.kill(pid, 0);

		return true;
	} catch {
		return false;
	}
};

const holder = existsSync(LOCK) ? Number(readFileSync(LOCK, "utf8")) : 0;

if (holder > 0 && isAlive(holder)) {
	console.error(`Another tardigrade dev server (pid ${holder}) is using .wrangler/state.`);
	console.error("Two servers on one state folder run the same Durable Object twice and corrupt its SQLite.");
	console.error("Stop it first, or run a second server with its own folder: npx wrangler dev --persist-to /tmp/other-state");
	process.exit(1);
}

mkdirSync(".wrangler", { recursive: true });

writeFileSync(LOCK, String(process.pid));

const release = () => rmSync(LOCK, { force: true });

const child = spawn("npx", ["wrangler", "dev", "--var", "LOCAL_DEV_WITHOUT_ACCESS:1", ...process.argv.slice(2)], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

child.on("exit", (code) => {
	release();
	process.exit(code ?? 0);
});
