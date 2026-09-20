import type { JsonValue } from "./contracts";

/**
 * Canonical JSON used for bundle identity. Object keys are sorted recursively,
 * arrays retain author order, and values outside JSON are rejected. This is
 * deliberately small: no host-specific serialization or ambient time enters
 * executable bytes.
 */
export function canonicalize(value: unknown): string {
  return canonicalValue(value, "$", new WeakSet<object>());
}

function canonicalValue(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`Non-JSON value at ${path}`);
  if (seen.has(value)) throw new Error(`Cyclic value at ${path}`);
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    result = `{${keys
      .map((key) => {
        if (record[key] === undefined) throw new Error(`Undefined value at ${path}.${key}`);
        return `${JSON.stringify(key)}:${canonicalValue(record[key], `${path}.${key}`, seen)}`;
      })
      .join(",")}}`;
  }
  seen.delete(value);
  return result;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto subtle.digest is unavailable");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalize(value);
    return true;
  } catch {
    return false;
  }
}
