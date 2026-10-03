import { canonicalize, createContextManifest } from "@kouro/core";
import type { AttemptState, ContextManifest, JsonValue } from "@kouro/core";

/** Only omit inputs when their exact contents already exist in this native conversation. */
export async function continuationContext(
  context: ContextManifest,
  previous: AttemptState,
  previousReport?: JsonValue,
): Promise<ContextManifest> {
  const prior = previous.contextManifest as unknown as ContextManifest | undefined;
  const supplied = new Set(prior?.segments?.map((segment) => segment.content) ?? []);
  const ownReport = previousReport === undefined ? undefined : canonicalize(previousReport);
  return createContextManifest({
    ...context,
    segments: context.segments.map((segment) => {
      const name = segment.id.split(":").at(-1);
      let own = false;
      if ((name === "own" || name === "previous") && ownReport !== undefined) {
        try {
          own = canonicalize(JSON.parse(segment.content) as JsonValue) === ownReport;
        } catch {
          /* A file reference remains available for selective re-reading. */
        }
      }
      return segment.source === "artifact-input" && (supplied.has(segment.content) || own)
        ? {
            ...segment,
            supplied: false,
            reason: "Already present in the resumed native conversation",
          }
        : segment;
    }),
  });
}
