import { Hono } from "hono";
import { FsEditBody, FsMkdirBody, FsMoveBody } from "@open-gitagent/protocol";
import { BadRequest, NotFound } from "../error-mapper.js";
import { PathEscapeError } from "../path-jail.js";
import {
  editFile,
  listTree,
  makeDir,
  movePath,
  readBytes,
  removePath,
  writeBytes,
} from "../services/workspace-fs.js";
import type { ServerContext } from "../app.js";

/**
 * Workspace FS routes — every operation is jailed to the session workdir.
 *
 *   GET    /v1/sessions/:id/fs/tree?path=&depth=
 *   GET    /v1/sessions/:id/fs/file?path=
 *   PUT    /v1/sessions/:id/fs/file?path=
 *   DELETE /v1/sessions/:id/fs/file?path=&recursive=
 *   POST   /v1/sessions/:id/fs/edit
 *   POST   /v1/sessions/:id/fs/mkdir
 *   POST   /v1/sessions/:id/fs/move
 */
export function fsRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/sessions/:id/fs/tree", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const path = c.req.query("path") ?? "";
    const depth = parseDepth(c.req.query("depth"));
    ctx.deps.logger.debug("fs.tree", { sessionId: id, path, depth });
    const entries = await catchEscape(() => listTree(session.workdir, path, depth));
    return c.json({ entries });
  });

  app.get("/sessions/:id/fs/file", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const path = c.req.query("path");
    if (!path) throw BadRequest("MISSING_PATH", "query param 'path' is required");
    ctx.deps.logger.debug("fs.read", { sessionId: id, path });
    const buf = await catchEscape(() => readBytes(session.workdir, path));
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  });

  app.put("/sessions/:id/fs/file", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const path = c.req.query("path");
    if (!path) throw BadRequest("MISSING_PATH", "query param 'path' is required");
    const body = Buffer.from(await c.req.arrayBuffer());
    ctx.deps.logger.debug("fs.write", { sessionId: id, path, bytes: body.length });
    const { size } = await catchEscape(() => writeBytes(session.workdir, path, body));
    return c.json({ ok: true, size });
  });

  app.delete("/sessions/:id/fs/file", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const path = c.req.query("path");
    if (!path) throw BadRequest("MISSING_PATH", "query param 'path' is required");
    const recursive = c.req.query("recursive") === "true";
    ctx.deps.logger.debug("fs.delete", { sessionId: id, path, recursive });
    await catchEscape(() => removePath(session.workdir, path, recursive));
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/fs/edit", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const body = FsEditBody.parse(await c.req.json());
    ctx.deps.logger.debug("fs.edit", { sessionId: id, path: body.path, replaceAll: body.replaceAll });
    const { replacements } = await catchEscape(() =>
      editFile(session.workdir, body.path, body.oldString, body.newString, body.replaceAll ?? false),
    );
    return c.json({ ok: true, replacements });
  });

  app.post("/sessions/:id/fs/mkdir", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const body = FsMkdirBody.parse(await c.req.json());
    ctx.deps.logger.debug("fs.mkdir", { sessionId: id, path: body.path, recursive: body.recursive });
    await catchEscape(() => makeDir(session.workdir, body.path, body.recursive ?? false));
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/fs/move", async (c) => {
    const id = c.req.param("id");
    const session = requireSession(ctx, id);
    const body = FsMoveBody.parse(await c.req.json());
    ctx.deps.logger.debug("fs.move", { sessionId: id, from: body.from, to: body.to });
    await catchEscape(() => movePath(session.workdir, body.from, body.to));
    return c.json({ ok: true });
  });

  return app;
}

function requireSession(ctx: ServerContext, id: string) {
  const s = ctx.registry.get(id);
  if (!s) throw NotFound("session", id);
  return s;
}

function parseDepth(raw: string | undefined): number {
  const n = raw == null ? 1 : Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 1;
  return Math.min(n, 8);
}

async function catchEscape<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PathEscapeError) {
      throw BadRequest("PATH_ESCAPE", err.message, { attempted: err.attempted });
    }
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw NotFound("file", (err as NodeJS.ErrnoException).path ?? "?");
    }
    throw err;
  }
}
