import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production the SPA is served by Caddy at agentos.clawagent.sh and /api/* is
// proxied to the Node server. For local `vite dev`, proxy /api to the live API
// (api.clawagent.sh/agentos/api) and inject the Basic Auth header so the
// dashboard works end-to-end against real data without deploying.
// Override AGENTOS_API_TARGET to point at a local server (e.g. http://127.0.0.1:8787).
const API_USER = process.env.AGENTOS_API_USER ?? "clawagent";
const API_PASS = process.env.AGENTOS_API_PASS ?? "";
const API_TARGET = process.env.AGENTOS_API_TARGET ?? "https://api.clawagent.sh";
const authHeader = "Basic " + Buffer.from(`${API_USER}:${API_PASS}`).toString("base64");

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, "/agentos/api"),
        headers: { Authorization: authHeader },
      },
    },
  },
});
