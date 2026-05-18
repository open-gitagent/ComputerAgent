/**
 * `@computeragent/state-store-s3` — S3 backend for the harness's
 * `StateStore` interface. Persists sandbox snapshots (workdir tarball +
 * metadata) so clients can save and restore live sandbox state.
 *
 *   import { s3StateStoreBuilder } from "@computeragent/state-store-s3";
 *
 *   new ComputerAgentServer({
 *     ...,
 *     stateStores: { s3: s3StateStoreBuilder({ bucket: process.env.S3_BUCKET! }) },
 *   });
 *
 * Credentials follow the standard AWS SDK chain — prefer EC2 instance
 * role or env vars over plaintext in `S3StateStoreOptions`.
 */
export { S3StateStore } from "./s3-store.js";
export type { S3StateStoreOptions } from "./s3-store.js";
export { s3StateStoreBuilder } from "./builder.js";
