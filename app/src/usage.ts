import type { SessionUsage, MessageUsage } from "./types"

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

export function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function parseMessageUsage(info: any): MessageUsage {
  return {
    cost: normalizeNumber(info?.cost),
    tokens: {
      input: normalizeNumber(info?.tokens?.input),
      output: normalizeNumber(info?.tokens?.output),
      reasoning: normalizeNumber(info?.tokens?.reasoning),
      cache: {
        read: normalizeNumber(info?.tokens?.cache?.read),
        write: normalizeNumber(info?.tokens?.cache?.write),
      },
    },
  }
}

export function applyUsageDelta(total: SessionUsage, previous: MessageUsage, next: MessageUsage): void {
  total.cost += next.cost - previous.cost
  total.tokens.input += next.tokens.input - previous.tokens.input
  total.tokens.output += next.tokens.output - previous.tokens.output
  total.tokens.reasoning += next.tokens.reasoning - previous.tokens.reasoning
  total.tokens.cache.read += next.tokens.cache.read - previous.tokens.cache.read
  total.tokens.cache.write += next.tokens.cache.write - previous.tokens.cache.write
}
