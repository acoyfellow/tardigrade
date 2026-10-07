import { defineConfig } from "vitest/config";

const inlineFoldkit = { deps: { inline: ["foldkit"] } };

export default defineConfig({
	test: {
		projects: [
			{ test: { name: "client", environment: "happy-dom", include: ["client/src/**/*.test.ts"], setupFiles: ["./client/src/vitest-setup.ts"], server: inlineFoldkit } },
			{ test: { name: "server", environment: "node", include: ["worker/**/*.test.ts", "shared/**/*.test.ts", "test/**/*.test.ts"], server: inlineFoldkit } },
		],
	},
});
