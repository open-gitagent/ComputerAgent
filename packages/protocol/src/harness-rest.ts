import { z } from "zod";
import { IdentitySource } from "./identity-source.js";
import { SessionStoreConfig } from "./session-store-config.js";

/**
 * Zod schemas for every REST request and response body in the Harness Protocol.
 *
 * Schemas live at the wire boundary only. Internal code uses inferred types.
 */

/** A user message in the Anthropic content-block shape. */
export const UserMessage = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string(),
      }).passthrough(),
    ),
  ]),
});
export type UserMessage = z.infer<typeof UserMessage>;

/**
 * File the caller wants to land in the session workdir before the engine starts.
 *
 * - `path` is relative to the workdir. Path-jailed: `..`, absolute paths, and
 *   symlink-outs are rejected with 400 PATH_ESCAPE.
 * - `content` is the file body. UTF-8 strings (default) or base64 for binary.
 * - Written AFTER the identity loader materializes the GAP repo, so attachments
 *   overlay on top of repo files (caller wins on collisions).
 */
export const Attachment = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** Identity reference: which loader, with which source. */
export const IdentityRef = z.object({
  loader: z.string().min(1),
  source: IdentitySource,
});
export type IdentityRef = z.infer<typeof IdentityRef>;

/** Body shared by `POST /v1/sessions` and `POST /v1/chat`. */
export const CreateSessionBody = z.object({
  engine: z.string().min(1),
  identity: IdentityRef,
  envs: z.record(z.string(), z.string()).optional(),
  messages: z.array(UserMessage).optional(),
  sessionId: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  /**
   * If false (default), the server closes the user-message queue after enqueueing
   * `messages`, so the engine ends naturally after handling them. Set true for
   * long-lived sessions where the client will POST follow-up messages over time
   * (and call `POST /sessions/:id/end-input` to close the queue itself).
   */
  streamingInput: z.boolean().optional(),
  /**
   * Optional swappable session store. When set, the server resolves `kind`
   * via the registry configured at `createHarnessServer({ sessionStores })`
   * and hands the live store to the engine. Presence of this field + a known
   * `sessionId` IS the resume signal — no separate flag.
   */
  sessionStore: SessionStoreConfig.optional(),
  /**
   * Files to materialize into the session workdir before the engine starts.
   * Written AFTER the identity loader populates the workdir, so an
   * attachment with the same name as a repo file overwrites it (caller
   * wins). Common uses: passing PDFs for analysis, CSVs for processing,
   * config overlays per request.
   */
  attachments: z.array(Attachment).optional(),
  /**
   * Optional per-session policy decider config. When set, the harness
   * builds the matching decider (e.g. SrsPolicyDecider) and gates every
   * tool call through it. Deny short-circuits the engine's permission
   * request with `behavior: "deny"` — no SSE round-trip to a client.
   *
   * Currently supported: `{ kind: "srs", endpoint, apiKey, policyId, principalId }`.
   */
  policy: z.object({
    kind: z.literal("srs"),
    endpoint: z.string().min(1),
    apiKey: z.string().min(1),
    policyId: z.string().min(1),
    principalId: z.string().min(1),
  }).optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

/** `POST /v1/sessions` — 201 on success. */
export const CreateSessionResponse = z.object({
  sessionId: z.string(),
  engine: z.string(),
  identity: z.object({
    name: z.string(),
    version: z.string(),
    sha: z.string().optional(),
  }),
  capabilities: z.object({
    streamingInput: z.boolean(),
    partialMessages: z.boolean(),
    permissionCallback: z.boolean(),
    sessions: z.boolean(),
    budget: z.boolean(),
  }),
  eventsUrl: z.string(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

/** `POST /v1/sessions/:id/messages` body. */
export const SendMessageBody = z.object({
  message: UserMessage,
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

/** `POST /v1/sessions/:id/permission/:callId` body. */
export const PermissionDecisionBody = z.object({
  decision: z.enum(["allow", "deny", "modify"]),
  input: z.unknown().optional(),
  reason: z.string().optional(),
});
export type PermissionDecisionBody = z.infer<typeof PermissionDecisionBody>;

/** Generic ack response. */
export const AckResponse = z.object({
  ok: z.literal(true),
});
export type AckResponse = z.infer<typeof AckResponse>;

/** Filesystem tree entry. */
export const FsTreeEntry = z.object({
  path: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtime: z.number().int(),
  mode: z.number().int(),
});
export type FsTreeEntry = z.infer<typeof FsTreeEntry>;

/** `GET /v1/sessions/:id/fs/tree` response. */
export const FsTreeResponse = z.object({
  entries: z.array(FsTreeEntry),
});
export type FsTreeResponse = z.infer<typeof FsTreeResponse>;

/** `POST /v1/sessions/:id/fs/edit` body — string-replace edit. */
export const FsEditBody = z.object({
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});
export type FsEditBody = z.infer<typeof FsEditBody>;

/** `POST /v1/sessions/:id/fs/edit` response. */
export const FsEditResponse = z.object({
  ok: z.literal(true),
  replacements: z.number().int().nonnegative(),
});
export type FsEditResponse = z.infer<typeof FsEditResponse>;

/** `POST /v1/sessions/:id/fs/mkdir` body. */
export const FsMkdirBody = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
});
export type FsMkdirBody = z.infer<typeof FsMkdirBody>;

/** `POST /v1/sessions/:id/fs/move` body. */
export const FsMoveBody = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type FsMoveBody = z.infer<typeof FsMoveBody>;

/** `GET /v1/health` response. */
export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  engines: z.record(
    z.string(),
    z.object({
      streamingInput: z.boolean(),
      partialMessages: z.boolean(),
      permissionCallback: z.boolean(),
      sessions: z.boolean(),
      budget: z.boolean(),
    }),
  ),
  loaders: z.array(z.string()),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
