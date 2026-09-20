import { describe, expect, test } from "bun:test";
import type { RunView } from "@kouro/core/contracts";
import { viewFromCore } from "../types";

const base = (): RunView => ({
  projectionVersion: 1,
  runId: "run-m2",
  revision: 1,
  eventCursor: 1,
  bundle: {
    formatVersion: 1,
    semanticVersions: { compiler: "1", expressions: "1", schemas: "1" },
    rootDefinitionId: "tiny",
    definitions: {},
    schemas: {},
    limits: {
      maxScopes: 1,
      maxInvocations: 1,
      maxAttempts: 1,
      maxTurns: 1,
      maxMessages: 1,
      maxConcurrentEffects: 1,
      maxRunDurationMs: 1000,
    },
    sourceMap: {},
    boundSummary: { scopes: 1, invocations: 1, attempts: 1, saturated: false },
    digest: "d",
    canonicalJson: "{}",
  },
  state: {
    runId: "run-m2",
    revision: 1,
    eventCursor: 1,
    status: "running",
    rootScopeId: "s",
    startedAt: null,
    finishedAt: null,
    scopes: {},
    invocations: {},
    attempts: {},
    counters: {},
    approvals: {},
    recovery: null,
  },
  serverClock: "2026-09-18T00:00:00.000Z",
});

describe("M2 web projection", () => {
  test("keeps declared context availability and telemetry without inventing provider data", () => {
    const source = base() as unknown as Record<string, unknown>;
    source.m2 = {
      context: [
        {
          id: "c1",
          source: "prompt",
          availability: "summarized",
          reason: "budget",
          tokenEstimate: 42,
        },
      ],
      usage: [{ completeness: "partial", inputTokens: 10, estimated: true }],
      capabilities: { cancel: true },
    };
    const projected = viewFromCore(source as unknown as RunView);
    expect(projected.context[0]).toMatchObject({ availability: "summarized", tokenEstimate: 42 });
    expect(projected.usage[0].completeness).toBe("partial");
    expect(projected.usage[0].cost).toBeUndefined();
    expect(projected.capabilities).toEqual({ cancel: true });
  });

  test("does not fabricate context, usage, tools, or controls when host omits M2 data", () => {
    const projected = viewFromCore(base());
    expect(projected.context).toEqual([]);
    expect(projected.usage).toEqual([]);
    expect(projected.tools).toEqual([]);
    expect(projected.capabilities).toEqual({});
  });

  test("maps authoritative per-attempt manifest, harness events, usage, and capabilities", () => {
    const source = base() as unknown as Record<string, any>;
    source.state.attempts = {
      a1: {
        id: "a1",
        invocationId: "i1",
        ordinal: 1,
        status: "succeeded",
        startedAt: null,
        finishedAt: null,
        output: [],
        evidence: [],
        artifacts: [],
        workspace: null,
        contextManifest: {
          segments: [
            { id: "prompt", source: "prompt", availability: "supplied", tokenEstimate: 12 },
          ],
        },
        harnessEvents: [
          {
            id: "t1",
            type: "tool_call",
            name: "read_file",
            status: "completed",
            capability: "workspace.read",
          },
          { id: "l1", type: "log", level: "warn", message: "provider note" },
        ],
        usage: { inputTokens: 10, outputTokens: 2, completeness: "partial", cost: null },
        diagnostics: [{ id: "d1", severity: "warning", message: "truncated" }],
        capabilities: { cancel: "supported", retry: false },
      },
    };
    const projected = viewFromCore(source as unknown as RunView);
    expect(projected.context).toMatchObject([
      { attemptId: "a1", availability: "supplied", tokenEstimate: 12 },
    ]);
    expect(projected.tools).toMatchObject([{ attemptId: "a1", name: "read_file" }]);
    expect(projected.logs).toMatchObject([{ attemptId: "a1", level: "warn" }]);
    expect(projected.usage).toMatchObject([{ attemptId: "a1", completeness: "partial" }]);
    expect(projected.usage[0].cost).toBeUndefined();
    expect(projected.diagnostics).toMatchObject([{ attemptId: "a1", severity: "warning" }]);
    expect(projected.capabilities).toEqual({ cancel: true });
  });
});
