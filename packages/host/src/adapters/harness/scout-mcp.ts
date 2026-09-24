import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Stdio MCP endpoint spawned by Codex, forwarding only bounded subagent calls. */
export async function serveScoutMcp(): Promise<void> {
  const endpoint = process.env.KOURO_SCOUT_ENDPOINT;
  const token = process.env.KOURO_SCOUT_TOKEN;
  if (!endpoint || !token) throw new Error("Kouro subagent bridge is unavailable");
  let inputSchema: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(process.env.KOURO_SCOUT_SCHEMA ?? "{}");
    inputSchema =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    inputSchema = {};
  }
  const server = new Server(
    { name: "kouro-scout", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "subagent",
        description: `Run a declared, bounded Kouro subagent and await its typed result. Authorized schemas: ${process.env.KOURO_SCOUT_SCHEMA ?? "{}"}`,
        inputSchema,
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "subagent")
      return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request.params.arguments),
    });
    const result = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !response.ok || result.state !== "succeeded",
    };
  });
  await server.connect(new StdioServerTransport());
}
