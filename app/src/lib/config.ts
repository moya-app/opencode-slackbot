import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type StdioMcpServer = {
  type: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type RemoteMcpServer = {
  type: "remote"
  url: string
  transport?: "streamable-http" | "sse"
  headers?: Record<string, string>
  timeoutMs?: number
}

export type McpServerConfig = StdioMcpServer | RemoteMcpServer

export type McpConfig = {
  servers: Record<string, McpServerConfig>
}

const CONFIG_DIR = "/app/config"

let _config: McpConfig | null = null

export async function loadMcpConfig(): Promise<McpConfig> {
  if (_config) return _config

  const paths = [
    join(CONFIG_DIR, "mcp.json"),
    join(CONFIG_DIR, "mcp.jsonc"),
  ]

  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8")
      const stripped = raw
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
      const parsed = JSON.parse(stripped) as McpConfig
      if (parsed.servers && typeof parsed.servers === "object") {
        _config = parsed
        const types = Object.entries(parsed.servers)
          .map(([k, v]) => `${k} (${v.type})`)
          .join(", ")
        console.log(`Loaded MCP config from ${path}: ${types}`)
        return _config
      }
    } catch {
      // try next path
    }
  }

  console.log("No MCP config found, running without MCP servers")
  _config = { servers: {} }
  return _config
}
