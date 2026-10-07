import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "happy-dom",
		include: ["client/src/**/*.test.ts", "worker/**/*.test.ts", "shared/**/*.test.ts", "test/**/*.test.ts"],
		setupFiles: ["./client/src/vitest-setup.ts"],
		server: { deps: { inline: ["foldkit"] } },
	},
});
