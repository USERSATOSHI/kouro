import type { HarnessAdapter, ScriptedAgent } from "../../types.ts";

export class DelayedScriptedAgent implements ScriptedAgent {
  async run(input: {
    runId: string;
    invocationId: string;
    delayMs: number;
    signal?: AbortSignal;
  }): Promise<{ output: Record<string, unknown> }> {
    if (input.signal?.aborted) throw new Error("scripted agent aborted");
    await wait(input.delayMs, input.signal);
    return {
      output: {
        kind: "scripted-agent.output",
        runId: input.runId,
        invocationId: input.invocationId,
        message: "M1 scripted agent completed",
      },
    };
  }
}

export class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly id = "scripted";
  readonly adapterVersion = "1";
  capabilities() {
    return {
      "structured-output": "supported" as const,
      cancel: "supported" as const,
      "awaited-subagent-tool": "supported" as const,
      "child-read-only-envelope": "supported" as const,
      usage: "unsupported" as const,
      "cost-cap": "unsupported" as const,
    };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    if (input.signal?.aborted)
      return {
        status: "cancelled" as const,
        error: "cancelled",
        events: [],
        usage: { quality: "unavailable" },
      };
    await wait(input.delayMs, input.signal);
    let collaboration: Record<string, unknown> | undefined;
    if (input.collaboration) {
      // This is intentionally a tiny fake harness: it exercises the real host
      // gateway rather than pretending that a provider tool call is durable.
      if (!input.collaboration.subagent) {
        const peer = input.role.toLowerCase().includes("receiver") ? "sender" : "receiver";
        const batch = input.collaboration.wait({ maxMessages: 8 });
        if (batch?.visible.length) {
          const first = batch.visible[0];
          input.collaboration.send_message({
            to: first.senderParticipantId,
            body: { kind: "reply", received: first.body },
            replyTo: first.id,
            idempotencyKey: `${input.invocationId}:reply:${first.id}`,
          });
          collaboration = { received: batch.visible.map((message) => message.id) };
        } else if (peer !== input.collaboration.participantId) {
          try {
            const sent = input.collaboration.send_message({
              to: peer,
              body: { kind: "request", from: input.collaboration.participantId },
              idempotencyKey: `${input.invocationId}:request`,
            });
            collaboration = { sent: sent.id };
          } catch {
            // A generic scripted run may not declare sender/receiver roles. It
            // remains a valid harness turn; the host still records the attempt.
          }
        }
        input.collaboration.publish_blackboard({
          type: "finding",
          body: { participant: input.collaboration.participantId, status: "completed" },
          idempotencyKey: `${input.invocationId}:finding`,
        });
      }
      if (input.collaboration.subagent) {
        const taskSegment = input.context?.segments.find(
          (segment) => segment.source === "artifact-input" && segment.id.endsWith(":task"),
        );
        let task = "scripted planner task";
        if (taskSegment) {
          try {
            const parsed = JSON.parse(taskSegment.content) as unknown;
            if (typeof parsed === "string") task = parsed;
          } catch {
            task = taskSegment.content.trim();
          }
        }
        const configuredSubagentIds = input.context?.tools.find(
          (tool) => tool.name === "subagent",
        )?.inputSchema;
        const subagentIds =
          configuredSubagentIds &&
          typeof configuredSubagentIds === "object" &&
          !Array.isArray(configuredSubagentIds) &&
          configuredSubagentIds.properties &&
          typeof configuredSubagentIds.properties === "object" &&
          !Array.isArray(configuredSubagentIds.properties) &&
          configuredSubagentIds.properties.subagentId &&
          typeof configuredSubagentIds.properties.subagentId === "object" &&
          !Array.isArray(configuredSubagentIds.properties.subagentId) &&
          Array.isArray(configuredSubagentIds.properties.subagentId.enum)
            ? configuredSubagentIds.properties.subagentId.enum.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
        const requests = await Promise.all(
          subagentIds.map((subagentId) =>
            input.collaboration!.subagent!({
              requestId: `${input.invocationId}:${subagentId}`,
              subagentId,
              input: subagentInputFromToolSchema(configuredSubagentIds, subagentId, task),
            }),
          ),
        );
        collaboration ??= {};
        collaboration.scouts = requests;
      }
    }
    const scoutReports =
      collaboration && Array.isArray(collaboration.scouts) ? collaboration.scouts : undefined;
    const output = input.outputSchema
      ? scriptedOutput(input.outputSchema, collaboration, scoutReports)
      : {
          summary: "Scripted Kouro harness completed.",
          ...(collaboration ? { collaboration } : {}),
        };
    return {
      status: "succeeded" as const,
      output: output as import("@kouro/core").JsonValue,
      events: [{ type: "text", data: "scripted" }],
      usage: { quality: "unavailable" },
    };
  }
}

function subagentInputFromToolSchema(
  schema: import("@kouro/core").JsonValue | undefined,
  subagentId: string,
  task: string,
): Record<string, import("@kouro/core").JsonValue> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  const branch = branches.find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.properties) &&
      isRecord(candidate.properties.subagentId) &&
      candidate.properties.subagentId.const === subagentId,
  );
  if (!isRecord(branch) || !isRecord(branch.properties) || !isRecord(branch.properties.input))
    return {};
  const inputSchema = branch.properties.input;
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return {};
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.fromEntries(
    Object.entries(inputSchema.properties)
      .filter(([name]) => required.has(name))
      .map(([name, propertySchema]) => [name, scriptedValue(propertySchema, name, task)]),
  );
}

function scriptedOutput(
  schema: import("@kouro/core").JsonValue,
  collaboration: Record<string, unknown> | undefined,
  scoutReports: unknown[] | undefined,
): import("@kouro/core").JsonValue {
  const output = scriptedValue(schema, "output", "scripted task");
  if (!isRecord(output)) return output;
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  if (scoutReports && Object.prototype.hasOwnProperty.call(properties, "scoutReports"))
    output.scoutReports = scoutReports as import("@kouro/core").JsonValue;
  if (collaboration && Object.prototype.hasOwnProperty.call(properties, "collaboration"))
    output.collaboration = collaboration as import("@kouro/core").JsonValue;
  return output;
}

function scriptedValue(
  schema: unknown,
  name: string,
  task: string,
): import("@kouro/core").JsonValue {
  if (!isRecord(schema)) return "Scripted Kouro harness completed.";
  if (schema.const !== undefined && isJsonValue(schema.const)) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && isJsonValue(schema.enum[0]))
    return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
    return scriptedValue(schema.oneOf[0], name, task);
  const type = schema.type;
  if (type === "object" || schema.properties !== undefined) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === "string")
        : Object.keys(properties),
    );
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([property]) => required.has(property))
        .map(([property, propertySchema]) => [
          property,
          scriptedValue(propertySchema, property, task),
        ]),
    );
  }
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "integer" || type === "number")
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (type === "string") {
    if (name === "task") return task;
    const minimum = typeof schema.minLength === "number" ? schema.minLength : 0;
    return "Scripted subagent input".padEnd(minimum, "x");
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is import("@kouro/core").JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("scripted agent aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
