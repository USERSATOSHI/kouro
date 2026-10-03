import type { ContextManifest } from "@kouro/core";

/** Accounting stays in the journal. Native tool schemas are installed by each adapter. */
export function renderHarnessPrompt(prompt: string, context?: ContextManifest): string {
  const segments = context?.segments
    .filter((segment) => segment.supplied && segment.source !== "role-prompt")
    .map((segment) => ({
      id: segment.id.includes(":input:")
        ? segment.id.split(":input:").slice(1).join(":input:")
        : segment.id.split(":").at(-1)!,
      source: segment.source,
      content: segment.content,
    }));
  if (!segments?.length) return prompt;
  return `${prompt}\n\n[KOURO_CONTEXT_BEGIN]\n${JSON.stringify({ segments })}\n[KOURO_CONTEXT_END]`;
}
