import { connectMcpServer, defineTool } from "@flue/runtime"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { ToolDefinition } from "@flue/runtime"
import type { McpServerConfig } from "./config"

type McpConnection = {
  name: string
  tools: ToolDefinition[]
  close: () => Promise<void>
}

let connections: McpConnection[] = []

export async function connectAllMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  await disconnectAll()

  for (const [name, config] of Object.entries(servers)) {
    try {
      if (config.type === "remote") {
        const conn = await connectMcpServer(name, {
          url: config.url,
          transport: config.transport || "streamable-http",
          headers: config.headers,
          timeoutMs: config.timeoutMs,
        })
        console.log(`MCP server "${name}" connected via remote: ${config.url}`)
        connections.push({
          name,
          tools: conn.tools,
          close: () => conn.close(),
        })
      } else if (config.type === "stdio") {
        const conn = await connectStdioMcp(name, config)
        connections.push(conn)
      } else {
        console.warn(`MCP server "${name}": unknown type "${(config as any).type}", skipping`)
      }
    } catch (error) {
      console.error(`Failed to connect MCP server "${name}":`, error)
    }
  }
}

async function connectStdioMcp(
  name: string,
  config: { command: string; args?: string[]; env?: Record<string, string> },
): Promise<McpConnection> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  if (config.env) {
    Object.assign(env, config.env)
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args || [],
    env,
  })

  const client = new Client(
    { name: "opencode-slackbot", version: "2.0.0" },
    { capabilities: {} },
  )

  await client.connect(transport)

  const result = await client.listTools()
  const tools: ToolDefinition[] = []

  for (const tool of result.tools) {
    const adaptedName = `mcp__${name}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    tools.push(
      defineTool({
        name: adaptedName,
        description: tool.description || `MCP tool: ${tool.name} (${name})`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        execute: async (args: any, _signal?: AbortSignal) => {
          const callResult = await client.callTool({
            name: tool.name,
            arguments: args || {},
          })
          const contentItems = (callResult as any).content as Array<{
            type: string; text?: string; resource?: { uri?: string }
          }>
          return contentItems
            .map((c) => {
              if (c.type === "text") return c.text || ""
              if (c.type === "resource") return `[resource: ${c.resource?.uri || "unknown"}]`
              return JSON.stringify(c)
            })
            .join("\n")
        },
      }),
    )
  }

  console.log(`MCP server "${name}" connected via stdio: ${config.command} ${(config.args || []).join(" ")}, ${tools.length} tools`)

  return {
    name,
    tools,
    close: async () => {
      try { await client.close() } catch { /* ignore */ }
    },
  }
}

export async function disconnectAll(): Promise<void> {
  for (const conn of connections) {
    try { await conn.close() } catch { /* ignore */ }
  }
  connections = []
}

export function getMcpTools(): ToolDefinition[] {
  return connections.flatMap((c) => c.tools)
}

export function getMcpTool(toolName: string): ToolDefinition | undefined {
  return getMcpTools().find((t) => t.name === toolName)
}
