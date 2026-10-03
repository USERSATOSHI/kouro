import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentNode } from "@kouro/core";
import { fusionInputSegment, FUSION_INLINE_MAX_BYTES } from "../src/coordinator/fusion-notes";

test("large fusion notes become readable, integrity-checked files without expanding the task into a file", () => {
  const directory = mkdtempSync("/tmp/kouro-fusion-notes-");
  const node: AgentNode = {
    id: "review",
    kind: "agent",
    role: "researcher",
    prompt: "Review",
    inputPorts: [],
    outputPorts: [],
    bindings: [],
    fusion: { groupId: "research", memberId: "a", stage: "review", round: 1 },
  };
  const value = {
    summary: "Evidence index",
    findings: ["Large evidence ".repeat(FUSION_INLINE_MAX_BYTES)],
    sources: ["https://example.test/source"],
  };
  try {
    const input = { node, name: "peer2", value, attemptId: "attempt", directory };
    const segment = fusionInputSegment(input);
    expect(segment.source).toBe("artifact-input-file");
    expect(segment.bytes).toBeLessThan(1500);
    const file = JSON.parse(segment.content);
    expect(file.summary).toBe(value.summary);
    const stored = readFileSync(file.path, "utf8");
    expect(JSON.parse(stored)).toEqual(value);
    expect(stored).toContain('\n  "sources":');
    expect(Buffer.byteLength(stored)).toBe(file.bytes);
    expect(fusionInputSegment(input).content).toBe(segment.content);
    expect(fusionInputSegment({ ...input, name: "task" }).source).toBe("artifact-input");
    expect(fusionInputSegment({ ...input, value: { summary: "small" } }).source).toBe(
      "artifact-input",
    );
    expect(
      fusionInputSegment({
        ...input,
        node: { ...node, fusion: { ...node.fusion!, notesTransport: "inline" } },
      }).source,
    ).toBe("artifact-input");
    expect(
      fusionInputSegment({
        ...input,
        value: { summary: "small" },
        node: { ...node, fusion: { ...node.fusion!, notesTransport: "files" } },
      }).source,
    ).toBe("artifact-input-file");
    chmodSync(file.path, 0o600);
    writeFileSync(file.path, "modified report");
    expect(() => fusionInputSegment(input)).toThrow("integrity validation");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
