import { fileURLToPath } from "node:url";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [tailwindcss(), foldkit()],
	build: { outDir: "dist", emptyOutDir: true },
});
