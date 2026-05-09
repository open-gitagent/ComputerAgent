import { z } from "zod";

/** Clone a remote git repo. */
export const GitIdentitySource = z.object({
  type: z.literal("git"),
  url: z.string().min(1),
  ref: z.string().optional(),
  subdir: z.string().optional(),
});
export type GitIdentitySource = z.infer<typeof GitIdentitySource>;

/** Use a directory already materialized on disk. */
export const LocalIdentitySource = z.object({
  type: z.literal("local"),
  path: z.string().min(1),
});
export type LocalIdentitySource = z.infer<typeof LocalIdentitySource>;

/** Pass the manifest + files in-memory; no I/O needed to fetch. */
export const InlineIdentitySource = z.object({
  type: z.literal("inline"),
  manifest: z.record(z.string(), z.unknown()),
  files: z.record(z.string(), z.string()).optional(),
});
export type InlineIdentitySource = z.infer<typeof InlineIdentitySource>;

/** Where an agent's identity is loaded from. */
export const IdentitySource = z.discriminatedUnion("type", [
  GitIdentitySource,
  LocalIdentitySource,
  InlineIdentitySource,
]);
export type IdentitySource = z.infer<typeof IdentitySource>;
