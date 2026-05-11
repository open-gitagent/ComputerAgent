import { defineCommand } from "citty";

/** `computeragent health` — quick connectivity + capability check. */
export const healthCommand = defineCommand({
  meta: {
    name: "health",
    description: "Check connectivity to a harness server and print its capabilities.",
  },
  args: {
    "harness-url": {
      type: "string",
      description: "Harness server URL",
      default: "http://127.0.0.1:7700",
    },
  },
  async run({ args }) {
    const url = `${args["harness-url"]}/v1/health`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      process.stderr.write(`unreachable: ${url}\n  ${(err as Error).message}\n`);
      process.exit(2);
    }
    if (!res.ok) {
      process.stderr.write(`unhealthy: ${res.status} ${res.statusText}\n`);
      process.exit(1);
    }
    const body = await res.json() as {
      version: string;
      engines: Record<string, Record<string, boolean>>;
      loaders: string[];
    };
    process.stdout.write(`harness-server v${body.version}  ${args["harness-url"]}\n`);
    process.stdout.write(`engines:\n`);
    for (const [name, caps] of Object.entries(body.engines)) {
      const flags = Object.entries(caps)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",");
      process.stdout.write(`  - ${name}  [${flags}]\n`);
    }
    process.stdout.write(`identity loaders:\n`);
    for (const l of body.loaders) process.stdout.write(`  - ${l}\n`);
  },
});
