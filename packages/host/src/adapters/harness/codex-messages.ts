import type { HarnessEvent } from "@kouro/core";

/** Keep native message identities and distinguish exposed reasoning from summaries. */
export class CodexMessages {
  private text = new Map<string, string>();
  lastAssistantText = "";
  constructor(private readonly emit: (event: HarnessEvent) => void) {}

  consume(method: string | undefined, params: Record<string, unknown>): boolean {
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.publish(String(params.itemId), params.delta, false);
      return true;
    }
    if (
      (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") &&
      typeof params.delta === "string"
    ) {
      const kind = method === "item/reasoning/textDelta" ? "content" : "summary";
      const index = kind === "content" ? params.contentIndex : params.summaryIndex;
      this.publish(
        `${String(params.itemId)}:${kind}:${String(index ?? 0)}`,
        params.delta,
        false,
        kind,
      );
      return true;
    }
    if (method !== "item/started" && method !== "item/completed") return false;
    const item = params.item as Record<string, unknown> | undefined;
    if (!item || (item.type !== "agentMessage" && item.type !== "reasoning")) return false;
    if (item.type === "agentMessage") {
      if (method === "item/started") {
        this.emit({ type: "log", at: new Date().toISOString(), data: { status: "Writing reply" } });
      } else if (typeof item.text === "string") {
        this.publish(String(item.id), item.text, true);
      }
    } else if (method === "item/completed") {
      for (const kind of ["content", "summary"] as const) {
        const parts = item[kind];
        if (Array.isArray(parts))
          parts.forEach((part, index) => {
            if (typeof part === "string")
              this.publish(`${String(item.id)}:${kind}:${index}`, part, true, kind);
          });
      }
    }
    return true;
  }

  private publish(
    id: string,
    text: string,
    snapshot: boolean,
    thinkingKind?: "content" | "summary",
  ) {
    if (!text) return;
    const previous = this.text.get(id) ?? "";
    const next = snapshot ? text : previous + text;
    if (snapshot && next === previous) return;
    this.text.set(id, next);
    if (!thinkingKind) this.lastAssistantText = next;
    this.emit({
      type: thinkingKind ? "log" : "text",
      at: new Date().toISOString(),
      data: {
        id,
        text,
        ...(snapshot ? { mode: "snapshot" } : {}),
        ...(thinkingKind ? { channel: "thinking", thinkingKind, status: "Thinking" } : {}),
      },
    });
  }
}
