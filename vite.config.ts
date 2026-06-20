import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for building the React frontend into ./dist.
// Worker serves these assets at runtime via the ASSETS binding.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    // Proxy /api and /ws to wrangler dev during frontend-only dev.
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
