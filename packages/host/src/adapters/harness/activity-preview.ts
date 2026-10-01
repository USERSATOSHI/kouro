import type { JsonValue } from "@kouro/core";

/** Preserve field structure while bounding the journal's inline output preview. */
export function activityPreview(value: JsonValue): JsonValue {
  let remaining = 32000;
  const visit = (item: JsonValue, depth: number): JsonValue => {
    if (remaining <= 0 || depth > 5) return "… full output available in the artifact";
    if (typeof item === "string") {
      const limit = Math.min(remaining, 20000);
      remaining -= Math.min(item.length, limit);
      return item.length > limit ? `${item.slice(0, limit)}\n… preview truncated` : item;
    }
    if (item === null || typeof item !== "object") {
      remaining -= 16;
      return item;
    }
    if (Array.isArray(item)) {
      const result: JsonValue[] = [];
      for (const child of item.slice(0, 50)) {
        if (remaining <= 0) break;
        result.push(visit(child, depth + 1));
      }
      if (result.length < item.length) result.push("… additional items in the full output");
      return result;
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(item).slice(0, 40)) {
      if (remaining <= 0) break;
      const label = key.length > 512 ? `${key.slice(0, 512)}…` : key;
      remaining -= label.length;
      result[label] = visit(child, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
