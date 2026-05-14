import { z } from "zod";

/**
 * Wire-side descriptor for a swappable SessionStore. SessionStore instances
 * cannot fly over HTTP; clients send this descriptor in `POST /v1/sessions`,
 * the server resolves it to a live instance via the registry configured at
 * `createHarnessServer({ sessionStores: { ... } })`.
 *
 * `kind` is intentionally open — the registry is the authority on what's
 * actually registered. The server returns `UNKNOWN_STORE` with an `available`
 * list when a caller asks for a kind nobody registered.
 */
export const SessionStoreConfig = z.object({
  kind: z.string().min(1),
  options: z.unknown().optional(),
});
export type SessionStoreConfig = z.infer<typeof SessionStoreConfig>;
