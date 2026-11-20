import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const CORE = "127.0.0.1:47621";

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://${CORE}`,
      "/health": `http://${CORE}`,
      "/plugins": `http://${CORE}`,
      "/ws": { target: `ws://${CORE}`, ws: true },
    },
  },
});
