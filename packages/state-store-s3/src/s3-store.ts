import {
  S3Client,
  type S3ClientConfig,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import type {
  SandboxSnapshot,
  SnapshotFilter,
  SnapshotSummary,
  StateStore,
} from "@open-gitagent/protocol";

/**
 * S3-backed StateStore. Each snapshot lives under
 * `<prefix>/<snapshotId>/` as two objects:
 *
 *   meta.json        — JSON metadata (SnapshotSummary, ISO-stringified dates)
 *   workdir.tar.gz   — raw gzipped tarball bytes
 *
 * Splitting them keeps `list()` cheap (no need to download tarballs to
 * render a listing) and lets the meta validator catch corrupt uploads
 * without parsing the binary payload.
 *
 * The implementation uses the standard AWS SDK credential chain — env
 * vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN),
 * shared config, EC2 instance role, etc. You can pass explicit
 * credentials via `accessKeyId` + `secretAccessKey`, but the preferred
 * production path is an IAM instance role.
 *
 * `endpoint` is for S3-compatible stores (MinIO, R2, etc.) — leave unset
 * for AWS S3.
 */
export interface S3StateStoreOptions {
  readonly bucket: string;
  readonly region?: string;
  /** Prefix under which all snapshots live. Default `sandboxes/snapshots/`. */
  readonly prefix?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly endpoint?: string;
  /** Pass-through extra config for advanced cases (custom retry, etc.). */
  readonly clientConfig?: Partial<S3ClientConfig>;
}

interface MetaJson {
  snapshotId: string;
  sourceSandboxId: string;
  sourceSessionId: string;
  takenAt: string;           // ISO
  config: Record<string, unknown>;
  turnCount: number;
  usage: SandboxSnapshot["usage"];
  sessionStoreRef?: SandboxSnapshot["sessionStoreRef"];
  workdirBytes: number;
  workdirFileCount: number;
}

export class S3StateStore implements StateStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3StateStoreOptions) {
    if (!opts.bucket) throw new Error("S3StateStore: bucket is required");
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix ?? "sandboxes/snapshots/").replace(/^\/+/, "");
    if (!this.prefix.endsWith("/")) this.prefix += "/";

    const cfg: S3ClientConfig = {
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}),
      ...(opts.clientConfig ?? {}),
    };
    this.client = new S3Client(cfg);
  }

  private metaKey(id: string): string { return `${this.prefix}${id}/meta.json`; }
  private tarKey(id: string): string  { return `${this.prefix}${id}/workdir.tar.gz`; }

  async save(snap: SandboxSnapshot): Promise<{ snapshotId: string; sizeBytes: number }> {
    const meta: MetaJson = {
      snapshotId: snap.snapshotId,
      sourceSandboxId: snap.sourceSandboxId,
      sourceSessionId: snap.sourceSessionId,
      takenAt: snap.takenAt.toISOString(),
      config: snap.config,
      turnCount: snap.turnCount,
      usage: snap.usage,
      ...(snap.sessionStoreRef ? { sessionStoreRef: snap.sessionStoreRef } : {}),
      workdirBytes: snap.workdirBytes,
      workdirFileCount: snap.workdirFileCount,
    };
    // Upload meta FIRST. If the tarball PUT fails afterwards we end up with
    // an orphan meta — survivable (list() shows it, load() returns null on
    // missing tar). The inverse (tar without meta) would surface as a ghost
    // blob with no way to list/delete it via the meta-driven scan path.
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.metaKey(snap.snapshotId),
      Body: Buffer.from(JSON.stringify(meta), "utf8"),
      ContentType: "application/json",
    }));
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.tarKey(snap.snapshotId),
      Body: snap.workdirTar,
      ContentType: "application/gzip",
    }));
    return { snapshotId: snap.snapshotId, sizeBytes: snap.workdirBytes };
  }

  async load(snapshotId: string): Promise<SandboxSnapshot | null> {
    const [metaRes, tarRes] = await Promise.all([
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.metaKey(snapshotId) })).catch(notFoundAsNull),
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.tarKey(snapshotId) })).catch(notFoundAsNull),
    ]);
    if (!metaRes || !tarRes) return null;
    const metaBytes = await streamToBuffer(metaRes.Body as NodeJS.ReadableStream);
    const meta = JSON.parse(metaBytes.toString("utf8")) as MetaJson;
    const tar = await streamToBuffer(tarRes.Body as NodeJS.ReadableStream);
    return {
      snapshotId: meta.snapshotId,
      sourceSandboxId: meta.sourceSandboxId,
      sourceSessionId: meta.sourceSessionId,
      takenAt: new Date(meta.takenAt),
      config: meta.config,
      turnCount: meta.turnCount,
      usage: meta.usage,
      ...(meta.sessionStoreRef ? { sessionStoreRef: meta.sessionStoreRef } : {}),
      workdirTar: tar,
      workdirBytes: meta.workdirBytes,
      workdirFileCount: meta.workdirFileCount,
    };
  }

  async list(filter?: SnapshotFilter): Promise<readonly SnapshotSummary[]> {
    // S3 has no native filter on object content — we list meta.json keys
    // under the prefix, fetch them in parallel (bounded), and post-filter.
    // Bounded parallelism: up to 16 at a time keeps this responsive even
    // for a few thousand snapshots without flooding S3 with concurrent
    // requests.
    const metaKeys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents ?? []) {
        if (obj.Key && obj.Key.endsWith("/meta.json")) metaKeys.push(obj.Key);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    const summaries: SnapshotSummary[] = [];
    const BATCH = 16;
    for (let i = 0; i < metaKeys.length; i += BATCH) {
      const batch = metaKeys.slice(i, i + BATCH);
      const metas = await Promise.all(batch.map(async (key) => {
        try {
          const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
          const bytes = await streamToBuffer(r.Body as NodeJS.ReadableStream);
          return JSON.parse(bytes.toString("utf8")) as MetaJson;
        } catch {
          return null;
        }
      }));
      for (const m of metas) {
        if (!m) continue;
        summaries.push({
          snapshotId: m.snapshotId,
          sourceSandboxId: m.sourceSandboxId,
          sourceSessionId: m.sourceSessionId,
          takenAt: new Date(m.takenAt),
          config: m.config,
          turnCount: m.turnCount,
          usage: m.usage,
          ...(m.sessionStoreRef ? { sessionStoreRef: m.sessionStoreRef } : {}),
          workdirBytes: m.workdirBytes,
          workdirFileCount: m.workdirFileCount,
        });
      }
    }
    let result = summaries;
    if (filter?.sourceSandboxId) {
      result = result.filter((s) => s.sourceSandboxId === filter.sourceSandboxId);
    }
    if (filter?.since) {
      const sinceMs = filter.since.getTime();
      result = result.filter((s) => s.takenAt.getTime() >= sinceMs);
    }
    result.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
    if (filter?.limit) result = result.slice(0, filter.limit);
    return result;
  }

  async delete(snapshotId: string): Promise<void> {
    // DeleteObjects ignores missing keys silently — idempotent by default.
    await this.client.send(new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: {
        Objects: [
          { Key: this.metaKey(snapshotId) },
          { Key: this.tarKey(snapshotId) },
        ],
        Quiet: true,
      },
    }));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function notFoundAsNull(err: unknown): null {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
  throw err;
}

async function streamToBuffer(s: NodeJS.ReadableStream | undefined): Promise<Buffer> {
  if (!s) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of s as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
