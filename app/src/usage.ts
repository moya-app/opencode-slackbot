import type { SessionUsage } from "./types"

export function emptyUsage(): SessionUsage {
  return {
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
}
