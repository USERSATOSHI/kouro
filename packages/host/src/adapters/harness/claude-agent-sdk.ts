import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  unavailableUsage,
  validateJsonSchema,
  validateReasoningEffort,
  reasoningEffortsForHarness,
  type HarnessDescriptor,
  type HarnessEvent,
  type JsonValue,
} from "@kouro/core";
import type { HarnessAdapter } from "../../types.ts";
import { parseStructuredOutput } from "./structured-output.ts";
import { ClaudeMessages } from "./claude-messages.ts";
import { claudeDisallowedTools, nativeToolPolicy } from "./tool-policy.ts";

export const claudeSdkDescriptor: HarnessDescriptor = {
  id: "claude",
  adapterVersion: "agent-sdk",
  version: "Claude Agent SDK",
  availability: "available",
  capabilities: {
    "structured-output": { state: "supported" },
    cancel: { state: "supported" },
    resume: { state: "unsupported" },
    reattach: { state: "unsupported" },
    tools: {
      state: "conditional",
      constraints: [
        "native tools follow workflow grants; delegation uses declared Kouro subagents",
      ],
    },
    usage: { state: "supported" },
    "cost-cap": { state: "unsupported" },
    "awaited-subagent-tool": { state: "supported" },
    "child-read-only-envelope": { state: "supported" },
  },
  nativeConfigSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      model: { type: "string" },
      permissionMode: { type: "string" },
      effort: { type: "string", enum: [...reasoningEffortsForHarness("claude")] },
    },
  },
};

export class ClaudeAgentSdkHarnessAdapter implements HarnessAdapter {
  readonly id = "claude";
  readonly adapterVersion = claudeSdkDescriptor.adapterVersion;

  constructor(private readonly queryProvider: typeof query = query) {}

  capabilities(): Record<string, "supported" | "unsupported" | "conditional"> {
    return Object.fromEntries(
      Object.entries(claudeSdkDescriptor.capabilities).map(([name, value]) => [name, value.state]),
    );
  }

  async run(
    input: Parameters<HarnessAdapter["run"]>[0],
  ): Promise<Awaited<ReturnType<HarnessAdapter["run"]>>> {
    const effort = input.nativeConfig?.effort;
    const effortError = validateReasoningEffort(effort, "claude");
    if (effortError)
      return {
        status: "failed",
        error: effortError,
        usage: JSON.parse(JSON.stringify(unavailableUsage())),
        events: [],
      };
    const abortController = new AbortController();
    const abort = () => abortController.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : undefined;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => abortController.abort(new Error(`Claude SDK timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
    let stderr = "";
    const messages: SDKMessage[] = [];
    const context = input.context
      ? `\n\n[KOURO_CONTEXT]\n${JSON.stringify(input.context)}\n[/KOURO_CONTEXT]`
      : "";
    const prompt = `${input.prompt}${context}`;
    const policy = nativeToolPolicy(input.nativeConfig);
    const disallowedTools = claudeDisallowedTools(policy);
    const scoutTool = input.context?.tools.find((candidate) => candidate.name === "subagent");
    const subagent = input.collaboration?.subagent;
    const allowedSubagentIds =
      scoutTool?.inputSchema &&
      typeof scoutTool.inputSchema === "object" &&
      !Array.isArray(scoutTool.inputSchema) &&
      "properties" in scoutTool.inputSchema &&
      scoutTool.inputSchema.properties &&
      typeof scoutTool.inputSchema.properties === "object" &&
      !Array.isArray(scoutTool.inputSchema.properties) &&
      "subagentId" in scoutTool.inputSchema.properties &&
      scoutTool.inputSchema.properties.subagentId &&
      typeof scoutTool.inputSchema.properties.subagentId === "object" &&
      !Array.isArray(scoutTool.inputSchema.properties.subagentId) &&
      "enum" in scoutTool.inputSchema.properties.subagentId &&
      Array.isArray(scoutTool.inputSchema.properties.subagentId.enum)
        ? scoutTool.inputSchema.properties.subagentId.enum.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined;
    const mcpServers =
      scoutTool && subagent
        ? {
            kouro: createSdkMcpServer({
              name: "kouro",
              version: "1.0.0",
              tools: [
                tool(
                  "subagent",
                  `${scoutTool.description} Authorized subagents and their input schemas: ${JSON.stringify(scoutTool.inputSchema)}`,
                  {
                    subagentId: allowedSubagentIds?.length
                      ? z.enum(allowedSubagentIds as [string, ...string[]])
                      : z.string(),
                    requestId: z.string(),
                    input: z.record(z.string(), z.unknown()),
                  },
                  async (args) => {
                    const result = await subagent(args);
                    return {
                      content: [{ type: "text" as const, text: JSON.stringify(result) }],
                      isError: result.state !== "succeeded",
                    };
                  },
                ),
              ],
              ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
            }),
          }
        : undefined;
    const options: Options = {
      ...(effort === undefined ? {} : { effort: effort as Options["effort"] }),
      includePartialMessages: true,
      cwd: input.cwd ?? process.cwd(),
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(typeof input.nativeConfig?.model === "string" ? { model: input.nativeConfig.model } : {}),
      abortController,
      permissionMode: "default",
      tools: { type: "preset", preset: "claude_code" },
      ...(mcpServers ? { mcpServers } : {}),
      allowedTools: ["Read", "Glob", "Grep", ...(mcpServers ? ["mcp__kouro__subagent"] : [])],
      disallowedTools,
      canUseTool: async (name, args) =>
        disallowedTools.includes(name)
          ? { behavior: "deny", message: "This tool is outside the workflow's declared grants." }
          : { behavior: "allow", updatedInput: args },
      settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
      settingSources: [],
      maxTurns: 30,
      stderr: (data) => {
        stderr += data;
      },
      ...(input.outputSchema
        ? {
            outputFormat: {
              type: "json_schema" as const,
              schema: input.outputSchema as Record<string, unknown>,
            },
          }
        : {}),
    };
    let resultMessage: SDKResultMessage | undefined;
    const events: HarnessEvent[] = [];
    const activity = new ClaudeMessages((event) => {
      events.push(event);
      input.onEvent?.(event);
    });
    try {
      for await (const message of this.queryProvider({ prompt, options })) {
        messages.push(message);
        activity.consume(message);
        if (message.type === "result") resultMessage = message;
      }
    } catch (cause) {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const cancelled = input.signal?.aborted === true;
      return {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "cancelled" : cause instanceof Error ? cause.message : String(cause),
        stderr,
        rawOutput: JSON.stringify(messages),
        usage: JSON.parse(JSON.stringify(usageFrom(resultMessage))) as JsonValue,
        events,
      };
    }
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (abortController.signal.aborted) {
      return {
        status: input.signal?.aborted ? "cancelled" : "failed",
        error: input.signal?.aborted
          ? "cancelled"
          : `Claude SDK timed out after ${timeoutMs ?? "configured"}ms`,
        stderr,
        rawOutput: JSON.stringify(messages),
        usage: JSON.parse(JSON.stringify(usageFrom(resultMessage))) as JsonValue,
        events,
      };
    }
    if (resultMessage?.subtype !== "success") {
      const errors = resultMessage?.errors ?? [];
      return {
        status: "failed",
        error:
          errors.join("\n") || `Claude SDK ended with ${resultMessage?.subtype ?? "no result"}`,
        stderr,
        rawOutput: JSON.stringify(messages),
        usage: JSON.parse(JSON.stringify(usageFrom(resultMessage))) as JsonValue,
        events,
      };
    }
    const structured =
      "structured_output" in resultMessage
        ? (resultMessage.structured_output as JsonValue | undefined)
        : undefined;
    const parsed = structured ?? parseJson(resultMessage.result);
    if (input.outputSchema) {
      const validation = validateJsonSchema(parsed, input.outputSchema);
      if (!validation.valid)
        return {
          status: "failed",
          error: `invalid-output: ${validation.error}`,
          stderr,
          rawOutput: JSON.stringify(messages),
          usage: JSON.parse(JSON.stringify(usageFrom(resultMessage))) as JsonValue,
          events,
        };
    }
    return {
      status: "succeeded",
      output: parsed,
      stderr,
      rawOutput: JSON.stringify(messages),
      usage: JSON.parse(JSON.stringify(usageFrom(resultMessage))) as JsonValue,
      events,
    };
  }
}

function parseJson(text: string): JsonValue | undefined {
  return parseStructuredOutput(text);
}

export function eventsFrom(messages: readonly SDKMessage[]): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  const activity = new ClaudeMessages((event) => events.push(event));
  for (const message of messages) activity.consume(message);
  return events;
}

function usageFrom(message?: SDKResultMessage) {
  if (!message) return unavailableUsage();
  const models = Object.values(message.modelUsage ?? {});
  if (!models.length) return unavailableUsage();
  const sum = (select: (item: (typeof models)[number]) => number) =>
    models.reduce((total, item) => total + select(item), 0);
  const inputTokens = sum(
    (item) => item.inputTokens + item.cacheReadInputTokens + item.cacheCreationInputTokens,
  );
  const outputTokens = sum((item) => item.outputTokens);
  const cost = sum((item) => item.costUSD);
  const value = (number: number) => ({
    value: Number.isFinite(number) ? number : null,
    quality: Number.isFinite(number) ? ("observed" as const) : ("unavailable" as const),
    source: "claude-agent-sdk",
  });
  return {
    inputTokens: value(inputTokens),
    outputTokens: value(outputTokens),
    totalTokens: value(inputTokens + outputTokens),
    cost: {
      value: Number.isFinite(cost) ? cost : null,
      quality: Number.isFinite(cost) ? ("estimated" as const) : ("unavailable" as const),
      source: "claude-agent-sdk",
    },
  };
}
