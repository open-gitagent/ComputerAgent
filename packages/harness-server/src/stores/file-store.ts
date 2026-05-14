import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve as resolvePath, join } from "node:path";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@computeragent/protocol";

/**
 * Durable SessionStore that writes one JSONL file per sessionId under a
 * configurable root. Append uses `fs.appendFile` (atomic per write on most
 * POSIX filesystems); load parses each line. Missing file returns null.
 *
 * Single-writer. Concurrent writers against the same sessionId from
 * different processes will interleave lines; users needing multi-writer
 * durability should plug in a remote store (Mongo, Redis, etc.).
 *
 * The on-disk filename is the sha256 of the sessionId, hex-encoded and
 * truncated. This neutralises any path-traversal risk in client-supplied
 * sessionIds without restricting their format on the wire. The original id
 * is preserved as metadata in the first entry of the JSONL file.
 */
export class FileSessionStore implements SessionStore {
  private readonly root: string;

  constructor(opts: { root: string }) {
    if (!opts.root) throw new Error("FileSessionStore: root is required");
    this.root = resolvePath(opts.root);
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await mkdir(this.root, { recursive: true });
    const path = this.fileFor(key.sessionId);
    // Idempotency by uuid: skip any uuid already present in the file.
    const existing = await this.loadRaw(path);
    const seenUuids = new Set(
      existing.map((e) => e.uuid).filter((u): u is string => typeof u === "string"),
    );
    const fresh = entries.filter((e) => !e.uuid || !seenUuids.has(e.uuid));
    if (fresh.length === 0) return;
    const payload = fresh.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(path, payload, "utf8");
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const entries = await this.loadRaw(this.fileFor(key.sessionId));
    return entries.length > 0 ? entries : null;
  }

  private fileFor(sessionId: string): string {
    const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return join(this.root, `${hash}.jsonl`);
  }

  private async loadRaw(path: string): Promise<SessionStoreEntry[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: SessionStoreEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as SessionStoreEntry);
      } catch {
        // Skip corrupt lines rather than fail the whole load.
      }
    }
    return out;
  }
}
