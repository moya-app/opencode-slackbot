import { z } from "zod"

const boolSetting = (defaultValue: boolean) =>
  z
    .string()
    .default(defaultValue ? "true" : "false")
    .transform((v) => ["true", "1", "yes", "on"].includes(v.trim().toLowerCase()))

const SettingsSchema = z.object({
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  // Comma-separated Slack user IDs whose requests are rejected outright.
  BLOCKED_USERS: z.string().default(""),
  // Whether to broadcast replies into the channel (true) or keep them thread-only (false).
  REPLY_BROADCAST: boolSetting(true),
  // Whether to reject requests from users outside the bot's own workspace (e.g. Slack Connect).
  RESTRICT_TO_WORKSPACE: boolSetting(true),
})

export const settings = SettingsSchema.parse(process.env)

export const blockedUsers = new Set(
  settings.BLOCKED_USERS.split(",").map((s) => s.trim()).filter(Boolean),
)

export function isBlockedUser(userId: string | undefined): boolean {
  return !!userId && blockedUsers.has(userId)
}
