/**
 * `@computeragent/task-store-mongo` — MongoDB backend for the harness's
 * `TaskStore` interface. Persists the entire run lifecycle (status, every
 * event, usage rollup, artifacts) so clients can fire-and-forget tasks and
 * poll by taskId.
 *
 *   import { mongoTaskStoreBuilder } from "@computeragent/task-store-mongo";
 *
 *   new ComputerAgentServer({
 *     ...,
 *     taskStores: { mongo: mongoTaskStoreBuilder({ url: process.env.MONGO_URL! }) },
 *   });
 */
export { MongoTaskStore } from "./mongo-store.js";
export type { MongoTaskStoreOptions } from "./mongo-store.js";
export { mongoTaskStoreBuilder } from "./builder.js";
