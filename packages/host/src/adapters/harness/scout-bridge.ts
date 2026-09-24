import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { CollaborationTools } from "../../types.ts";

/** One parent turn owns this loopback bridge; no child process may reuse it. */
export async function startScoutBridge(subagent: NonNullable<CollaborationTools["subagent"]>) {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const valid =
      supplied.length === token.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (!valid || request.method !== "POST" || request.url !== "/subagent") {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 64 * 1024) throw new Error("subagent request too large");
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (
        typeof parsed.requestId !== "string" ||
        typeof parsed.subagentId !== "string" ||
        !parsed.input ||
        typeof parsed.input !== "object" ||
        Array.isArray(parsed.input)
      )
        throw new Error("invalid subagent request");
      const result = await subagent({
        requestId: parsed.requestId,
        subagentId: parsed.subagentId,
        input: parsed.input as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (cause) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scout bridge address unavailable");
  return {
    endpoint: `http://127.0.0.1:${address.port}/subagent`,
    token,
    close: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
  };
}
