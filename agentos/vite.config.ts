import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy defaults to the local combined agentos-server (packages/agentos-server).
// Both /api and /obs-api are served from that one process — /api maps to the
// dashboard surface (/agentos/api/*) and /obs-api maps to the observability
// surface (/v1/*). Boot the server with:
//   pnpm --filter @computeragent/agentos-server dev
//
// To target a deployed backend instead, copy .env.example → .env.local and
// fill in AGENTOS_API_TARGET + AGENTOS_API_PASS (both .env and .env.local are
// gitignored at the repo root).
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const env = { ...fileEnv, ...process.env };

  const API_USER = env.AGENTOS_API_USER ?? "clawagent";
  const API_PASS = env.AGENTOS_API_PASS ?? "";
  const API_TARGET = env.AGENTOS_API_TARGET ?? "http://127.0.0.1:8788";

  // Same upstream by default — single combined server hosts both surfaces.
  // Override OBS_API_URL only if you're still running the legacy obs-api
  // standalone process (deprecated; will be removed in a future release).
  const OBS_API_URL = env.OBS_API_URL ?? API_TARGET;

  const apiHeaders = API_PASS
    ? { Authorization: "Basic " + Buffer.from(`${API_USER}:${API_PASS}`).toString("base64") }
    : undefined;

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: API_TARGET,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, "/agentos/api"),
          ...(apiHeaders ? { headers: apiHeaders } : {}),
        },
        "/obs-api": {
          target: OBS_API_URL,
          changeOrigin: true,
          // /obs-api/v1/dashboard → /v1/dashboard on the combined server.
          rewrite: (p) => p.replace(/^\/obs-api/, ""),
          ...(apiHeaders ? { headers: apiHeaders } : {}),
        },
      },
    },
  };
});
