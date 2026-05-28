/**
 * Idempotent one-shot — seed the `agent_registry` Mongo collection with the
 * agents currently configured in-memory at `examples/computeragent-server.ts`.
 *
 * Run once when migrating an existing deployment to the registry-backed
 * dashboard. The dashboard reads `agent_registry` and unions with the
 * in-memory list, so this seed isn't strictly required (the dashboard still
 * works without it) — but it lets you tweak label/model/source via the
 * dashboard CRUD endpoints without restarting the server.
 *
 *   MONGO_URL=mongodb://... MONGO_DATABASE=agentos \
 *     pnpm tsx scripts/seed-agent-registry.ts
 *
 * Safe to re-run: `register()` is an idempotent upsert by name.
 */
import { MongoClient } from "mongodb";
import { AgentRegistry } from "@computeragent/agent-registry-mongo";

interface SeedAgent {
  readonly name: string;
  readonly label: string;
  readonly harness: string;
  readonly source: string;
  readonly model?: string;
}

// Mirrors the hardcoded agentDefs in examples/computeragent-server.ts:2306+.
// Keep in sync when adding/removing built-in agents there.
const SEED_AGENTS: readonly SeedAgent[] = [
  {
    name: "gitagent",
    label: "GitAgent",
    harness: "gitagent",
    source: "github.com/shreyas-lyzr/general-agent",
  },
  {
    name: "claude-code",
    label: "Claude Code",
    harness: "claude-agent-sdk",
    source: "github.com/shreyas-lyzr/general-agent",
  },
  {
    name: "deep-agent",
    label: "Deep Agent",
    harness: "deepagents",
    source: "github.com/shreyas-lyzr/general-agent",
  },
  {
    name: "agentosbuilder",
    label: "AgentOS Builder",
    harness: "claude-agent-sdk",
    source: "github.com/open-gitagent/agentos-builder",
  },
  {
    name: "gap-promoter",
    label: "GAP Promoter",
    harness: "gitagent",
    source: "github.com/open-gitagent/gap-promoter",
  },
  {
    name: "framework-translator",
    label: "Framework Translator",
    harness: "gitagent",
    source: "github.com/shreyas-lyzr/framework-translator-agent",
  },
];

async function main(): Promise<void> {
  const url = process.env.MONGO_URL;
  const database = process.env.MONGO_DATABASE ?? "agentos";
  if (!url) {
    console.error("MONGO_URL is required");
    process.exit(2);
  }

  const client = new MongoClient(url);
  await client.connect();
  const registry = new AgentRegistry({ url, database, client });

  console.log(`[seed] writing ${SEED_AGENTS.length} agents to ${database}.agent_registry`);
  for (const a of SEED_AGENTS) {
    await registry.register({
      name: a.name,
      label: a.label,
      harness: a.harness,
      source: a.source,
      model: a.model,
      registeredBy: "seed-script",
    });
    console.log(`  ✓ ${a.name}`);
  }

  await client.close();
  console.log("[seed] done");
}

main().catch((err) => {
  console.error("[seed] fatal:", err);
  process.exit(1);
});
