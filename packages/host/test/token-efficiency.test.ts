import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createContextManifest, type AgentNode, type AttemptState } from "@kouro/core";
import { renderHarnessPrompt } from "../src/adapters/harness/prompt";
import { continuationContext } from "../src/coordinator/continuation-context";
import { fusionInputSegment } from "../src/coordinator/fusion-notes";

const segment = (name: string, content: string, source = "artifact-input") => ({
  id: `volatile-attempt:input:${name}`,
  source,
  content,
  supplied: true,
  reason: "accounting",
  bytes: content.length,
  tokenCount: null,
  tokenQuality: "unavailable" as const,
});

test("native prompt contains each instruction once and retains named inputs without accounting or duplicate tool schemas", async () => {
  const role = "Inspect the supplied evidence and cite sources.";
  const context = await createContextManifest({
    attemptId: "volatile-attempt",
    hiddenNativeContext: "unavailable",
    segments: [
      segment("role", role, "role-prompt"),
      segment("task", '"proposal"'),
      { ...segment("private", "not supplied"), supplied: false },
    ],
    tools: [
      {
        name: "subagent",
        description: "native tool",
        inputSchema: { type: "object" },
        enabled: true,
      },
    ],
  });
  const prompt = renderHarnessPrompt(role, context);
  expect(prompt.split(role)).toHaveLength(2);
  expect(prompt).toContain('"id":"task"');
  expect(prompt).toContain("proposal");
  for (const internal of [
    "volatile-attempt",
    "tokenQuality",
    "inputSchema",
    "not supplied",
    context.digest,
  ])
    expect(prompt).not.toContain(internal);
  expect(context.segments).toHaveLength(3);
  expect(renderHarnessPrompt(role)).toBe(role);
});

test("native continuation omits unchanged task and own output but preserves changed task and peer notes", async () => {
  const base = { attemptId: "attempt", tools: [], hiddenNativeContext: "unavailable" as const };
  const before = await createContextManifest({
    ...base,
    segments: [segment("task", '"proposal"')],
  });
  const own = { summary: "own findings" };
  const next = await createContextManifest({
    ...base,
    segments: [
      segment("task", '"proposal"'),
      segment("own", JSON.stringify(own)),
      segment("peer2", '{"summary":"peer findings"}'),
    ],
  });
  const retained = await continuationContext(
    next,
    { contextManifest: before } as unknown as AttemptState,
    own,
  );
  expect(retained.segments.map((item) => item.supplied)).toEqual([false, false, true]);
  expect(renderHarnessPrompt("Review", retained)).not.toContain("own findings");
  expect(renderHarnessPrompt("Review", retained)).toContain("peer findings");
  const later = await continuationContext(next, {
    contextManifest: retained,
  } as unknown as AttemptState);
  expect(later.segments.every((item) => !item.supplied)).toBe(true);
  const changed = await continuationContext(
    await createContextManifest({ ...base, segments: [segment("task", '"changed scope"')] }),
    { contextManifest: before } as unknown as AttemptState,
  );
  expect(changed.segments[0]!.supplied).toBe(true);
});

test("ordinary large scout reports and diffs use immutable files while task instructions stay inline", () => {
  const directory = mkdtempSync("/tmp/kouro-input-files-");
  const node = {
    id: "change",
    kind: "agent",
    prompt: "Change",
    role: "worker",
    inputPorts: [],
    outputPorts: [],
    bindings: [],
  } as AgentNode;
  const value = { summary: "evidence", findings: ["evidence ".repeat(1000)] };
  try {
    const report = fusionInputSegment({
      node,
      name: "repositoryReports",
      value,
      attemptId: "attempt",
      directory,
    });
    expect(report.source).toBe("artifact-input-file");
    const file = JSON.parse(report.content);
    expect(JSON.parse(readFileSync(file.path, "utf8"))).toEqual(value);
    expect(report.bytes).toBeLessThan(1500);
    expect(
      fusionInputSegment({ node, name: "task", value, attemptId: "attempt", directory }).source,
    ).toBe("artifact-input");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
