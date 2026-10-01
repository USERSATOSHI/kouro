import type { JsonValue } from "@kouro/core";

/** Normalize common model formatting around JSON before schema validation. */
export function parseStructuredOutput(text: string): JsonValue {
  const trimmed = text.trim();
  const candidates = [
    trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim(),
    trimmed,
    firstJsonObject(trimmed),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JsonValue;
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed) as JsonValue;
        } catch {
          return parsed;
        }
      }
      return parsed;
    } catch {
      // Try the next common JSON response shape.
    }
  }
  return text;
}

function firstJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const char = value[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return undefined;
}
