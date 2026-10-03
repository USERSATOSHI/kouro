import { renderHarnessPrompt } from "./prompt";
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
import { providerLimit } from "./session.ts";

export const claudeSdkDescriptor: HarnessDescriptor = {
  id: "claude",
  adapterVersion: "agent-sdk",
  version: "Claude Agent SDK",
  availability: "available",
  capabilities: {
    "structured-output": { state: "supported" },
    cancel: { state: "supported" },
    resume: { state: "supported" },
    reattach: { state: "unsupported" },
    tools: {
      state: "conditional",
      constraints: [
        "native tools follow workflow grants; delegation uses declared Kouro subagents",
      ],
    },
    usage: { state: "supported" },
    "cost-cap": { state: "supported" },
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
      maxNativeTurns: { type: "integer", minimum: 1 },
      maxBudgetUsd: { type: "number", exclusiveMinimum: 0 },
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
    const maxTurns = input.nativeConfig?.maxNativeTurns;
    const maxBudgetUsd = input.nativeConfig?.maxBudgetUsd;
    if (
      (maxTurns !== undefined &&
        (typeof maxTurns !== "number" || !Number.isSafeInteger(maxTurns) || maxTurns < 1)) ||
      (maxBudgetUsd !== undefined &&
        (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0))
    )
      return {
        status: "failed",
        error: "Invalid Claude native query budget",
        usage: unavailableUsage() as unknown as JsonValue,
        events: [],
      };
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
    const prompt = renderHarnessPrompt(
      `${input.resumeSession ? "Continue the existing conversation. Preserve completed research and outputs.\n\n" : ""}${input.prompt}`,
      input.context,
    );
    let sessionId = input.resumeSession?.id;
    let usageLimited = false;
    let resumeAfter: string | undefined;
    const session = () => ({
      usageScope: "session" as const,
      ...(sessionId ? { session: { id: sessionId } } : {}),
    });
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
      ...(maxTurns === undefined ? {} : { maxTurns: maxTurns as number }),
      ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd: maxBudgetUsd as number }),
      ...(effort === undefined ? {} : { effort: effort as Options["effort"] }),
      includePartialMessages: true,
      cwd: input.cwd ?? process.cwd(),
      ...(input.contextDirectories?.length
        ? { additionalDirectories: [...input.contextDirectories] }
        : {}),
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
      ...(input.resumeSession ? { resume: input.resumeSession.id } : {}),
      persistSession: true,
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
    const limitReason = (error: string) =>
      usageLimited
        ? ("usage-limit" as const)
        : resultMessage?.subtype === "error_max_turns"
          ? ("turn-limit" as const)
          : resultMessage?.subtype === "error_max_budget_usd"
            ? ("budget-limit" as const)
            : providerLimit(error);
    const events: HarnessEvent[] = [];
    const activity = new ClaudeMessages((event) => {
      events.push(event);
      input.onEvent?.(event);
    });
    try {
      for await (const message of this.queryProvider({ prompt, options })) {
        messages.push(message);
        if (message.type === "assistant" && message.error === "rate_limit") usageLimited = true;
        if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
          usageLimited = true;
          const resetsAt = message.rate_limit_info.resetsAt;
          if (resetsAt && Number.isFinite(resetsAt))
            resumeAfter = new Date(resetsAt * 1000).toISOString();
        }
        if (
          "session_id" in message &&
          typeof message.session_id === "string" &&
          message.session_id
        ) {
          if (input.resumeSession && message.session_id !== input.resumeSession.id)
            throw new Error("Claude resumed a different native session");
          if (sessionId !== message.session_id) {
            sessionId = message.session_id;
            input.onEvent?.({
              type: "log",
              at: new Date().toISOString(),
              data: { status: "Native session", sessionId },
            });
          }
        }
        activity.consume(message);
        if (message.type === "result") resultMessage = message;
      }
    } catch (cause) {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const cancelled = input.signal?.aborted === true;
      const error = cancelled
        ? "cancelled"
        : resultMessage && resultMessage.subtype !== "success"
          ? resultMessage.errors.join("\n") || `Claude SDK ended with ${resultMessage.subtype}`
          : cause instanceof Error
            ? cause.message
            : String(cause);
      return {
        ...session(),
        ...(!cancelled && limitReason(error)
          ? {
              stopReason: limitReason(error),
              ...(resumeAfter ? { resumeAfter } : {}),
            }
          : {}),
        status: cancelled ? "cancelled" : "failed",
        error,
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
        ...session(),
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
      const error =
        errors.join("\n") || `Claude SDK ended with ${resultMessage?.subtype ?? "no result"}`;
      return {
        ...session(),
        ...(limitReason(error)
          ? {
              stopReason: limitReason(error),
              ...(resumeAfter ? { resumeAfter } : {}),
            }
          : {}),
        status: "failed",
        error,
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
          ...session(),
          status: "failed",
          error: `invalid-output: ${validation.error}`,
          stderr,
          rawOutput: JSON.stringify(messages),
          usage: JSON.parse(JSON.stringify(usageFrom(resultMessage))) as JsonValue,
          events,
        };
    }
    return {
      ...session(),
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
    uncachedInputTokens: value(sum((item) => item.inputTokens)),
    cacheReadInputTokens: value(sum((item) => item.cacheReadInputTokens)),
    cacheCreationInputTokens: value(sum((item) => item.cacheCreationInputTokens)),
    outputTokens: value(outputTokens),
    totalTokens: value(inputTokens + outputTokens),
    cost: {
      value: Number.isFinite(cost) ? cost : null,
      quality: Number.isFinite(cost) ? ("estimated" as const) : ("unavailable" as const),
      source: "claude-agent-sdk",
    },
  };
}
