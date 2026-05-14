import { z } from "zod";

/**
 * Narrow zod schema for the parts of GAP's `agent.yaml` we actually consume.
 *
 * GAP's full schema is much richer (compliance blocks, sub-agents, hooks, …); we
 * intentionally only model what the MVP translator uses, with `passthrough()` so
 * extra fields round-trip without us caring. When we add features (compliance,
 * sub-agents), expand this schema then.
 */
export const GapManifest = z
  .object({
    spec_version: z.string().optional(),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    model: z
      .object({
        preferred: z.string().optional(),
        fallback: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    runtime: z
      .object({
        max_turns: z.number().int().positive().optional(),
        timeout: z.number().int().positive().optional(),
        budget_usd: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    skills: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    compliance: z
      .object({
        supervision: z
          .object({
            /**
             * GAP supervision mode. When `always`, the harness rejects caller
             * options that would bypass tool-call confirmation (the "strictest
             * wins" rule from PLAN.md). `destructive` is reserved for future
             * use — the MVP translator treats it the same as `always`. `none`
             * is the default permissive mode.
             */
            human_in_the_loop: z.enum(["always", "destructive", "none"]).optional(),
            escalation_triggers: z.array(z.string()).optional(),
            kill_switch: z.boolean().optional(),
            escalation_recipients: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type GapManifest = z.infer<typeof GapManifest>;
