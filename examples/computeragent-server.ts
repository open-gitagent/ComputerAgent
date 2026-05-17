/**
 * ComputerAgentServer — host the SDK as a REST/SSE API.
 *
 * Wraps `new ComputerAgent({...})` behind an HTTP endpoint so any client
 * (curl, Python, browser, another service) can run any GAP agent without
 * embedding the TypeScript SDK.
 *
 *   POST /run     — full agent config + message in JSON; SSE stream out
 *   GET  /health  — up check
 *   GET  /artifact?sessionId=&path=  — fetch a workdir file (during run)
 *
 * Private repo support: pass `gitToken` in the body and the server
 * rewrites the `source.url` with HTTPS basic-auth credentials, so simple-git
 * clones the private repo without leaking the token to other endpoints.
 *
 * Session persistence: pass `sessionStore: { kind: "mongo" | "file" | "memory" }`
 * (with optional `options`) to enable cross-process conversation resume.
 * Combine with `sessionId` to continue a prior conversation. The `mongo`
 * kind reads `MONGO_URL` from the harness env when `options.url` is omitted,
 * so credentials stay server-side.
 *
 *   curl -N -X POST http://127.0.0.1:8787/run -H 'content-type: application/json' \
 *     -d '{
 *       "source": { "type": "git", "url": "github.com/myorg/private-agent" },
 *       "gitToken": "ghp_xxx",
 *       "harness": "claude-agent-sdk",
 *       "envs": { "ANTHROPIC_API_KEY": "sk-..." },
 *       "options": { "permissionMode": "bypassPermissions", "settingSources": ["project"] },
 *       "message": "Write a one-line summary of README.md"
 *     }'
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { ComputerAgent, LocalSubstrate } from "computeragent";
import type { IdentitySource } from "computeragent";

export interface ComputerAgentServerOptions {
  /** Bind host. Default "127.0.0.1" (loopback only). Pass "0.0.0.0" for LAN-accessible. */
  readonly host?: string;
  readonly port: number;
  /**
   * Env vars merged into every spawned agent's env. Per-request `envs` win.
   * Useful for setting a default `ANTHROPIC_API_KEY` without putting it in
   * every request body.
   */
  readonly defaultEnvs?: Readonly<Record<string, string>>;
  /**
   * Substrate factory — if absent, every request boots a fresh LocalSubstrate.
   * Override to share an E2B template, a long-lived VM, or a test mock.
   */
  readonly substrate?: () => InstanceType<typeof LocalSubstrate>;
  /**
   * Hard cap on concurrent agent runs. Beyond this, /run returns 429.
   * Default: 4 (LocalSubstrate spawns a Node process per agent).
   */
  readonly maxConcurrentRuns?: number;
}

interface RunBody {
  source: IdentitySource | string;
  harness: string;
  message: string | Array<{ role: "user"; content: string }>;
  envs?: Record<string, string>;
  options?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  baseUrl?: string;
  /** Personal access token for private git sources (currently github-style). */
  gitToken?: string;
  sessionId?: string;
  /** Enable verbose harness logs via COMPUTERAGENT_LOG=debug in the spawned harness. */
  debug?: boolean;
  /**
   * Pluggable session store. Built-in kinds shipped with the spawned harness:
   *   - "memory"  (default, in-process; lost on dispose)
   *   - "file"    options: { root: "/path/to/dir" }
   *   - "mongo"   options: { url?: "mongodb://...", database?: "..." }
   *               url omitted ⇒ falls back to MONGO_URL in the harness env
   *               (pass it via top-level `envs` so the credential never
   *               crosses the wire)
   * Pair with `sessionId` to resume an existing conversation across processes.
   */
  sessionStore?: { kind: string; options?: unknown };
}

interface ActiveRun {
  agent: InstanceType<typeof ComputerAgent>;
  startedAt: number;
}

export class ComputerAgentServer {
  private readonly opts: ComputerAgentServerOptions;
  private readonly app = new Hono();
  private server: ServerType | null = null;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(opts: ComputerAgentServerOptions) {
    this.opts = opts;
    this.wire();
  }

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port;
    await new Promise<void>((resolve) => {
      this.server = serve({ fetch: this.app.fetch, hostname: host, port }, () => resolve());
    });
    return { host, port };
  }

  async close(): Promise<void> {
    // Tear down any in-flight agent runs first so their substrates don't outlive us.
    await Promise.all([...this.runs.values()].map((r) => r.agent.dispose().catch(() => {})));
    this.runs.clear();
    if (this.server) {
      await new Promise<void>((r) => {
        this.server!.close(() => r());
      });
      this.server = null;
    }
  }

  private wire(): void {
    this.app.get("/health", (c) =>
      c.json({ ok: true, activeRuns: this.runs.size, max: this.opts.maxConcurrentRuns ?? 4 }),
    );

    this.app.post("/run", async (c) => {
      const max = this.opts.maxConcurrentRuns ?? 4;
      if (this.runs.size >= max) {
        return c.json({ error: { code: "TOO_MANY_RUNS", active: this.runs.size, max } }, 429);
      }

      let body: RunBody;
      try {
        body = (await c.req.json()) as RunBody;
      } catch (err) {
        return c.json({ error: { code: "INVALID_JSON", message: (err as Error).message } }, 400);
      }

      const validation = validateRunBody(body);
      if (validation) return c.json({ error: validation }, 400);

      const source = applyGitToken(normalizeSource(body.source), body.gitToken);
      const envs = {
        ...this.opts.defaultEnvs,
        ...body.envs,
      };
      if (!envs.ANTHROPIC_API_KEY && body.harness !== "gitagent") {
        // gitagent can also use other providers; only enforce key for engines that need it
        const fromHost = process.env.ANTHROPIC_API_KEY;
        if (fromHost) envs.ANTHROPIC_API_KEY = fromHost;
      }

      const agent = new ComputerAgent({
        source,
        harness: body.harness as never,
        runtime: this.opts.substrate ? this.opts.substrate() : new LocalSubstrate(),
        envs,
        ...(body.options ? { options: body.options } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body.debug ? { debug: true } : {}),
        ...(body.sessionStore ? { sessionStore: body.sessionStore as never } : {}),
      });

      // Track the agent so /artifact can find it by sessionId while the run is live.
      const placeholderId = `pending-${Math.random().toString(36).slice(2, 8)}`;
      this.runs.set(placeholderId, { agent, startedAt: Date.now() });

      return streamSSE(c, async (stream) => {
        let realSessionId: string | undefined;
        stream.onAbort(async () => {
          await agent.dispose().catch(() => {});
          this.runs.delete(placeholderId);
          if (realSessionId) this.runs.delete(realSessionId);
        });

        try {
          const handle = agent.chat(
            typeof body.message === "string" ? body.message : body.message,
          );
          for await (const ev of handle) {
            if (ev.kind === "ca_session_started" && !realSessionId) {
              realSessionId = ev.sessionId;
              this.runs.set(realSessionId, { agent, startedAt: Date.now() });
            }
            await stream.writeSSE({
              event: ev.kind,
              data: JSON.stringify(ev),
            });
            if (ev.kind === "ca_session_ended") break;
          }
          // Final summary event with the usage rollup the SDK aggregated.
          const usage = handle.getUsage();
          await stream.writeSSE({
            event: "ca_done",
            data: JSON.stringify({ sessionId: realSessionId, usage }),
          });
        } catch (err) {
          await stream.writeSSE({
            event: "ca_error",
            data: JSON.stringify({ message: (err as Error).message }),
          });
        } finally {
          // Give the client a tick to receive the final events before tearing
          // down the substrate (which drops the workdir on the floor for any
          // /artifact follow-ups).
          await stream.sleep(50);
          await agent.dispose().catch(() => {});
          this.runs.delete(placeholderId);
          if (realSessionId) this.runs.delete(realSessionId);
        }
      });
    });

    // Best-effort artifact fetch — works WHILE the run is live (between the
    // first ca_session_started event and ca_session_ended). After the agent
    // disposes, the substrate's workdir is gone; the client must capture
    // artifacts before that.
    this.app.get("/artifact", async (c) => {
      const sessionId = c.req.query("sessionId");
      const path = c.req.query("path");
      if (!sessionId || !path) {
        return c.json({ error: { code: "MISSING_PARAM", message: "sessionId and path are required" } }, 400);
      }
      const run = this.runs.get(sessionId);
      if (!run) {
        return c.json({ error: { code: "NOT_FOUND", sessionId } }, 404);
      }
      const bytes = await run.agent.fetchArtifact(path);
      if (!bytes) return c.json({ error: { code: "NOT_FOUND", path } }, 404);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    // List the session workdir while the run is live.
    this.app.get("/workdir", async (c) => {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: { code: "MISSING_PARAM", message: "sessionId is required" } }, 400);
      }
      const run = this.runs.get(sessionId);
      if (!run) return c.json({ error: { code: "NOT_FOUND", sessionId } }, 404);
      const tree = await run.agent.listWorkdir({ depth: 3 });
      return c.json({ entries: tree });
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function normalizeSource(source: IdentitySource | string): IdentitySource {
  if (typeof source !== "string") return source;
  // Heuristic: anything with github.com/owner/repo or ending in .git is a git source.
  if (
    source.startsWith("github.com/") ||
    source.startsWith("https://") ||
    source.startsWith("git@") ||
    source.endsWith(".git")
  ) {
    return { type: "git", url: source };
  }
  return { type: "local", path: source };
}

/**
 * If a PAT is supplied, embed it in the HTTPS URL using GitHub's standard
 * `x-access-token` basic-auth pattern. simple-git uses the credential
 * transparently; the token never appears in subsequent request paths.
 *
 * Supports:
 *   - `github.com/owner/repo`        → `https://x-access-token:<TOK>@github.com/owner/repo`
 *   - `https://github.com/owner/repo` → same
 *
 * SSH URLs (`git@github.com:owner/repo`) are passed through unchanged — they
 * authenticate by key, not token.
 */
function applyGitToken(source: IdentitySource, token: string | undefined): IdentitySource {
  if (!token || source.type !== "git") return source;
  const url = source.url;
  if (url.startsWith("github.com/")) {
    return { ...source, url: `https://x-access-token:${token}@${url}` };
  }
  if (url.startsWith("https://github.com/")) {
    return { ...source, url: url.replace("https://", `https://x-access-token:${token}@`) };
  }
  // Unknown shape (gitlab, bitbucket, ssh, custom). Pass through; caller can
  // pre-format the URL with whatever scheme that host expects.
  return source;
}

function validateRunBody(body: unknown): { code: string; message: string } | undefined {
  if (!body || typeof body !== "object") return { code: "INVALID_BODY", message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (!b.source) return { code: "MISSING_SOURCE", message: "source is required" };
  if (!b.harness || typeof b.harness !== "string") {
    return { code: "MISSING_HARNESS", message: "harness is required (e.g. 'claude-agent-sdk')" };
  }
  if (!b.message) return { code: "MISSING_MESSAGE", message: "message is required" };
  return undefined;
}

// ── Example ──
// Run with: `node --experimental-strip-types --no-warnings examples/computeragent-server.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new ComputerAgentServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8787),
    defaultEnvs: process.env.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
      : undefined,
    maxConcurrentRuns: 4,
  });
  const { host, port } = await server.listen();
  console.log(`ComputerAgentServer listening on http://${host}:${port}`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  POST /run        body: {source, harness, message, envs?, options?, gitToken?, model?, debug?}");
  console.log("  GET  /workdir?sessionId=<id>");
  console.log("  GET  /artifact?sessionId=<id>&path=<path>");
  console.log("");
  console.log("Example:");
  console.log("  curl -N -X POST http://" + host + ":" + port + "/run \\");
  console.log("    -H 'content-type: application/json' \\");
  console.log("    -d '{");
  console.log('      "source": "github.com/shreyas-lyzr/pdf-agent",');
  console.log('      "harness": "claude-agent-sdk",');
  console.log('      "options": { "permissionMode": "bypassPermissions", "settingSources": ["project"] },');
  console.log('      "message": "Write hello.pdf with one line of text"');
  console.log("    }'");
}
