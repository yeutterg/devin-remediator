import { z } from "zod";

const ConfigSchema = z.object({
  githubToken: z.string().min(1, "GITHUB_TOKEN required"),
  devinApiKey: z
    .string()
    .min(1)
    .regex(/^(cog_|dsk_|dev_)/, "DEVIN_API_KEY must be a service-user key (cog_*, dsk_*, dev_*)")
    .optional(),
  devinOrgId: z
    .string()
    .min(1)
    .regex(
      /^org-[0-9a-f]{16,}$/,
      "DEVIN_ORG_ID must be the prefixed UUID like 'org-abc123…' — copy it from the Devin UI URL, not the org display name",
    )
    .optional(),
  devinUserId: z
    .string()
    .regex(
      /^(user-|email\|)/,
      "DEVIN_USER_ID must be a prefixed ID like 'user-…' or 'email|…' — not the display name",
    )
    .optional(),
  devinApiBase: z.string().default("https://api.devin.ai/v3"),
  targetRepo: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  remediatorRepo: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  targetCheckout: z.string().default("/home/ubuntu/repos/superset"),
  stateFile: z.string().default("./state.json"),
  maxActiveSessions: z.coerce.number().default(5),
  maxAcuPerSession: z.coerce.number().default(8),
  autoRemediateLabel: z.string().default("devin-auto-remediate"),
  dryRun: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    githubToken: process.env.GITHUB_TOKEN,
    devinApiKey: process.env.DEVIN_API_KEY,
    devinOrgId: process.env.DEVIN_ORG_ID,
    devinUserId: process.env.DEVIN_USER_ID,
    devinApiBase: process.env.DEVIN_API_BASE,
    targetRepo: process.env.TARGET_REPO ?? "yeutterg/superset",
    remediatorRepo: process.env.REMEDIATOR_REPO ?? "yeutterg/devin-remediator",
    targetCheckout: process.env.TARGET_CHECKOUT,
    stateFile: process.env.REMEDIATOR_STATE,
    maxActiveSessions: process.env.MAX_ACTIVE_SESSIONS,
    maxAcuPerSession: process.env.MAX_ACU_PER_SESSION,
    autoRemediateLabel: process.env.AUTO_REMEDIATE_LABEL,
    dryRun: process.env.DRY_RUN,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return parsed.data;
}
