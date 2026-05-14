import Database, { type Database as Db } from "better-sqlite3";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@computeragent/protocol";

/**
 * SQLite-backed SessionStore. One row per (session, entry) under a single
 * table. Idempotency by entry uuid is enforced at the schema level via a
 * UNIQUE constraint on (session_id, uuid) — collisions are silent inserts
 * (INSERT OR IGNORE).
 *
 * The schema:
 *   CREATE TABLE entries (
 *     session_id TEXT NOT NULL,
 *     project_key TEXT NOT NULL,
 *     ordinal INTEGER NOT NULL,        -- monotonic insertion order per session
 *     uuid TEXT,                        -- nullable; idempotency only when present
 *     payload TEXT NOT NULL,            -- full JSON of the SessionStoreEntry
 *     UNIQUE (session_id, uuid)         -- partial enforcement (NULL uuid skipped)
 *   );
 *   CREATE INDEX entries_session_ordinal ON entries(session_id, ordinal);
 *
 * Built specifically as a third independent backend (alongside Memory + File
 * + Mongo) so the SessionStore contract gets stressed by a SQL model — which
 * forces transactions, schema-level idempotency, and prepared statements.
 */
export interface SqliteSessionStoreOptions {
  /** Absolute or relative path to the .sqlite file. Use ":memory:" for ephemeral. */
  readonly path: string;
  /** Open in read-only mode (default false). */
  readonly readonly?: boolean;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: Db;
  private readonly insertStmt;
  private readonly selectStmt;
  private readonly nextOrdinalStmt;
  private readonly countStmt;
  private readonly listSessionsStmt;

  constructor(opts: SqliteSessionStoreOptions) {
    if (!opts.path) throw new Error("SqliteSessionStore: path is required");
    this.db = new Database(opts.path, { readonly: opts.readonly ?? false });
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        session_id   TEXT NOT NULL,
        project_key  TEXT NOT NULL,
        ordinal      INTEGER NOT NULL,
        uuid         TEXT,
        payload      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS entries_uuid
        ON entries(session_id, uuid)
        WHERE uuid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS entries_session_ordinal
        ON entries(session_id, ordinal);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO entries (session_id, project_key, ordinal, uuid, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT payload FROM entries WHERE session_id = ? ORDER BY ordinal ASC`,
    );
    this.nextOrdinalStmt = this.db.prepare(
      `SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM entries WHERE session_id = ?`,
    );
    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM entries WHERE session_id = ?`,
    );
    this.listSessionsStmt = this.db.prepare(
      `SELECT session_id, MAX(rowid) AS r FROM entries WHERE project_key = ?
       GROUP BY session_id ORDER BY r DESC LIMIT 50`,
    );
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const insertMany = this.db.transaction((rows: SessionStoreEntry[]) => {
      const next = (this.nextOrdinalStmt.get(key.sessionId) as { next: number }).next;
      let ordinal = next;
      for (const entry of rows) {
        this.insertStmt.run(
          key.sessionId,
          key.projectKey,
          ordinal,
          entry.uuid ?? null,
          JSON.stringify(entry),
        );
        ordinal += 1;
      }
    });
    insertMany(entries);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.selectStmt.all(key.sessionId) as { payload: string }[];
    if (rows.length === 0) return null;
    return rows.map((r) => JSON.parse(r.payload) as SessionStoreEntry);
  }

  /** Test/admin helper: number of entries stored for a sessionId. */
  size(sessionId: string): number {
    return (this.countStmt.get(sessionId) as { n: number }).n;
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    const rows = this.listSessionsStmt.all(projectKey) as { session_id: string; r: number }[];
    return rows.map((r) => ({ sessionId: r.session_id, mtime: r.r }));
  }

  /** Close the underlying database. Idempotent. */
  close(): void {
    if (this.db.open) this.db.close();
  }
}
