/**
 * distill-now — run the company-knowledge distiller once, on demand.
 *
 *   node --experimental-strip-types examples/distill-now.ts [--dry-run]
 *   bun run examples/distill-now.ts --dry-run
 *
 * Reads the same env the Slack bot uses: MONGO_URL, MONGO_DATABASE,
 * GITAGENT_ANTHROPIC_API_KEY, and (repo/token) LYRA_LEARN_REPO or SLACK_LYRA_SOURCE
 * + SLACK_LYRA_GIT_TOKEN / GITHUB_TOKEN. --dry-run distills + scrubs + dedups and
 * prints what WOULD be proposed, without touching git or the watermark.
 */
import { KnowledgeDistiller } from "./knowledge-distiller.ts";

const dryRun = process.argv.includes("--dry-run");

const mongoUrl = process.env.MONGO_URL;
const mongoDb = process.env.MONGO_DATABASE ?? "computeragent";
const anthropicKey = process.env.GITAGENT_ANTHROPIC_API_KEY;
const bot = process.env.LYRA_LEARN_BOT ?? "lyra";
const repo = process.env.LYRA_LEARN_REPO ?? process.env.SLACK_LYRA_SOURCE;
const gitToken = process.env.SLACK_LYRA_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? "";

if (!mongoUrl) {
  console.error("MONGO_URL is required");
  process.exit(1);
}
if (!anthropicKey) {
  console.error("GITAGENT_ANTHROPIC_API_KEY is required");
  process.exit(1);
}
if (!repo) {
  console.error("Set LYRA_LEARN_REPO (or SLACK_LYRA_SOURCE) to the target repo");
  process.exit(1);
}
if (!dryRun && !gitToken) {
  console.error("A git token (SLACK_LYRA_GIT_TOKEN / GITHUB_TOKEN) is required for a real run");
  process.exit(1);
}

const distiller = new KnowledgeDistiller({
  mongoUrl,
  mongoDb,
  bot,
  repo,
  gitToken,
  anthropicKey,
  model: process.env.LYRA_LEARN_MODEL,
});

try {
  console.log(`[distill-now] bot=${bot} repo=${repo} dryRun=${dryRun}`);
  const r = await distiller.runOnce({ dryRun });
  console.log(
    `\nthreads=${r.scannedThreads} extracted=${r.extracted} afterScrub=${r.afterScrub} fresh=${r.fresh}`,
  );
  if (r.freshStatements.length) {
    console.log("\nWould propose:");
    for (const s of r.freshStatements) console.log(`  - ${s}`);
  }
  if (r.prUrl) console.log(`\nPR: ${r.prUrl}`);
  if (r.skippedReason) console.log(`\n(${r.skippedReason})`);
} catch (e) {
  console.error("[distill-now] failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await distiller.close();
}
