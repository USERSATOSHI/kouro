import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentNode, ContextSegment, JsonValue } from "@kouro/core";

export const FUSION_INLINE_MAX_BYTES = 16 * 1024;
export const INPUT_INLINE_MAX_BYTES = 4 * 1024;

/** The journal keeps canonical reports; these immutable copies are native-tool inputs. */
export function fusionInputSegment(input: {
  node: AgentNode;
  name: string;
  value: JsonValue;
  attemptId: string;
  directory: string;
}): ContextSegment {
  let content = JSON.stringify(input.value);
  const bytes = Buffer.byteLength(content);
  const transport = input.node.fusion?.notesTransport ?? "auto";
  const report = /^(own|previous|peer\d+|review\d+|member\d+)$/.test(input.name);
  const useFile =
    input.node.fusion && report
      ? transport === "files" || (transport === "auto" && bytes > FUSION_INLINE_MAX_BYTES)
      : input.name !== "task" && bytes > INPUT_INLINE_MAX_BYTES;
  if (useFile) {
    const fileContent = JSON.stringify(input.value, null, 2);
    mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(fileContent).digest("hex");
    const path = join(input.directory, `${digest}.json`);
    try {
      writeFileSync(path, fileContent, { flag: "wx", mode: 0o400 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (readFileSync(path, "utf8") !== fileContent)
        throw new Error(`Fusion notes file failed integrity validation: ${path}`);
    }
    const summary =
      input.value && typeof input.value === "object" && !Array.isArray(input.value)
        ? input.value.summary
        : undefined;
    content = JSON.stringify({
      kind: "kouro-artifact-file",
      path,
      mediaType: "application/json",
      digest: `sha256:${digest}`,
      bytes: Buffer.byteLength(fileContent),
      ...(typeof summary === "string" ? { summary: summary.slice(0, 1000) } : {}),
      instructions:
        "This file contains the full bound report. Use native read/search tools to inspect relevant sections before reviewing it. Preserve source citations; the summary is only an index.",
    });
  }
  return {
    id: `${input.attemptId}:input:${input.name}`,
    source: useFile ? "artifact-input-file" : "artifact-input",
    content,
    supplied: true,
    reason: `resolved workflow input binding ${input.name}${useFile ? ` (${bytes} bytes in file)` : ""}`,
    bytes: Buffer.byteLength(content),
    tokenCount: null,
    tokenQuality: "unavailable",
  };
}
