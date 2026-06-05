// One-off: drop ALL collections in the AgentOS Mongo database, for a clean slate.
//
// Safe by construction: it prints the target DB + collections and refuses to
// drop unless you confirm by passing the DB name back via CONFIRM_DROP.
//
//   # dry run — just shows what WOULD be dropped:
//   MONGO_URL=... MONGO_DATABASE=computeragent-dev \
//     node packages/agentos-server/scripts/drop-collections.mjs
//
//   # actually drop (must echo the exact db name):
//   MONGO_URL=... MONGO_DATABASE=computeragent-dev CONFIRM_DROP=computeragent-dev \
//     node packages/agentos-server/scripts/drop-collections.mjs
//
// Reads MONGO_URL / MONGO_DATABASE from the environment — point it at the env
// you intend to wipe. There is NO undo.

import { MongoClient } from "mongodb";

const url = process.env.MONGO_URL;
const dbName = process.env.MONGO_DATABASE;
const confirm = process.env.CONFIRM_DROP;

if (!url || !dbName) {
  console.error("✗ MONGO_URL and MONGO_DATABASE must both be set.");
  process.exit(1);
}

const client = new MongoClient(url);
try {
  await client.connect();
  const db = client.db(dbName);
  const colls = (await db.listCollections().toArray()).map((c) => c.name).sort();

  console.log(`\nDatabase: ${dbName}`);
  console.log(`Collections (${colls.length}):`);
  for (const name of colls) {
    const count = await db.collection(name).estimatedDocumentCount();
    console.log(`  - ${name}  (~${count} docs)`);
  }

  if (colls.length === 0) {
    console.log("\nNothing to drop — database is already empty.");
    process.exit(0);
  }

  if (confirm !== dbName) {
    console.log(
      `\n⚠️  DRY RUN — nothing dropped.\n` +
        `To DROP all ${colls.length} collection(s) above, re-run with:\n` +
        `  CONFIRM_DROP=${dbName}\n`,
    );
    process.exit(0);
  }

  console.log(`\nDropping all ${colls.length} collection(s)…`);
  for (const name of colls) {
    await db.collection(name).drop().catch((e) => {
      console.warn(`  ! ${name}: ${e.message}`);
    });
    console.log(`  ✓ dropped ${name}`);
  }
  console.log("\nDone. The agentos-server recreates collections + indexes on next boot.");
} finally {
  await client.close();
}
