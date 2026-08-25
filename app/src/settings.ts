import { z } from "zod"

const SettingsSchema = z.object({
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  // Comma-separated Slack user IDs whose requests are rejected outright.
  BLOCKED_USERS: z.string().default(""),
  // Whether to broadcast replies into the channel (true) or keep them thread-only (false).
  REPLY_BROADCAST: z
    .string()
    .default("true")
    .transform((v) => ["true", "1", "yes", "on"].includes(v.trim().toLowerCase())),
})

export const settings = SettingsSchema.parse(process.env)

export const blockedUsers = new Set(
  settings.BLOCKED_USERS.split(",").map((s) => s.trim()).filter(Boolean),
)

export function isBlockedUser(userId: string | undefined): boolean {
  return !!userId && blockedUsers.has(userId)
}
