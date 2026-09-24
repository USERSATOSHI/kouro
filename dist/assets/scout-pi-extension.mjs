// Explicitly loaded only for a Kouro parent turn with declared subagents.
import { Type } from "typebox";

export default function (pi) {
  const schema = process.env.KOURO_SCOUT_SCHEMA ?? "{}";
  const allowedIds = JSON.parse(schema)?.properties?.subagentId?.enum;
  const subagentId =
    Array.isArray(allowedIds) && allowedIds.length > 0
      ? Type.Union(allowedIds.map((id) => Type.Literal(id)))
      : Type.String();
  pi.registerTool({
    name: "subagent",
    label: "Kouro subagent",
    description: `Run one bounded declared Kouro subagent and await its typed result. Authorized schemas: ${schema}`,
    parameters: Type.Object({
      subagentId,
      requestId: Type.String(),
      input: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_toolCallId, params, signal) {
      const response = await fetch(process.env.KOURO_SCOUT_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.KOURO_SCOUT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
        signal,
      });
      const result = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { state: result.state ?? "failed" },
      };
    },
  });
}
