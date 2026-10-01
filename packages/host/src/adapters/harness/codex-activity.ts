import type { HarnessEvent, JsonValue } from "@kouro/core";

/** Normalize the installed App Server's item payloads at the provider boundary. */
export function codexToolEvent(
  item: Record<string, unknown>,
  started: boolean,
  at: string,
): HarnessEvent {
  const failed =
    item.status === "failed" ||
    item.success === false ||
    Boolean(item.error) ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  const output =
    item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.output ?? item.changes;
  const input = item.arguments ?? item.command ?? item.query;
  const error = item.error
    ? typeof item.error === "string"
      ? item.error
      : JSON.stringify(item.error)
    : failed && typeof item.exitCode === "number"
      ? `Command exited with status ${item.exitCode}`
      : undefined;
  return {
    type: "tool",
    at,
    data: JSON.parse(
      JSON.stringify({
        id: item.id,
        name: item.tool ?? item.name ?? item.type,
        status: failed
          ? "failed"
          : item.status === "interrupted"
            ? "cancelled"
            : started
              ? "started"
              : "completed",
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
      }),
    ) as JsonValue,
  };
}
