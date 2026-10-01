import type { HarnessEvent, JsonValue } from "@kouro/core";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The same normalizer serves Claude's live stream and retained history. */
export class ClaudeMessages {
  private currentId?: string;
  private sequence = 0;
  private text = new Map<string, string>();
  constructor(private readonly emit: (event: HarnessEvent) => void) {}
  consume(value: unknown) {
    const message = record(value);
    const at = new Date().toISOString();
    if (message.type === "stream_event") {
      const event = record(message.event);
      if (event.type === "message_start")
        this.currentId = String(record(event.message).id ?? `claude-${++this.sequence}`);
      const block = record(event.content_block);
      const delta = record(event.delta);
      if (event.type === "content_block_delta" || event.type === "content_block_start") {
        this.currentId ??= `claude-${++this.sequence}`;
        const content = event.type === "content_block_delta" ? delta : block;
        if (content.type === "text_delta" || content.type === "text")
          this.publish(`${this.currentId}:${String(event.index ?? 0)}:text`, content.text, false);
        else if (content.type === "thinking_delta" || content.type === "thinking")
          this.publish(
            `${this.currentId}:${String(event.index ?? 0)}:thinking`,
            content.thinking,
            false,
            true,
          );
        else if (content.type === "tool_use")
          this.emit({
            type: "tool",
            at,
            data: {
              id: String(content.id ?? "tool"),
              name: String(content.name ?? "Tool"),
              status: "started",
              ...(content.input === undefined ? {} : { input: content.input as JsonValue }),
            },
          });
      }
    } else if (message.type === "assistant") {
      const assistant = record(message.message);
      const id = String(assistant.id ?? this.currentId ?? `claude-${++this.sequence}`);
      const content = Array.isArray(assistant.content) ? assistant.content : [];
      content.forEach((value, index) => {
        const part = record(value);
        if (part.type === "text") this.publish(`${id}:${index}:text`, part.text, true);
        else if (part.type === "thinking")
          this.publish(`${id}:${index}:thinking`, part.thinking, true, true);
        else if (part.type === "tool_use" && typeof part.id === "string")
          this.emit({
            type: "tool",
            at,
            data: {
              id: part.id,
              name: String(part.name ?? "Tool"),
              status: "running",
              ...(part.input === undefined ? {} : { input: part.input as JsonValue }),
            },
          });
      });
      this.currentId = undefined;
      if (message.error)
        this.emit({
          type: "log",
          at,
          data: { status: "Provider error", level: "error", detail: String(message.error) },
        });
    } else if (message.type === "user") {
      const content = record(message.message).content;
      if (Array.isArray(content))
        for (const value of content) {
          const part = record(value);
          if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
          this.emit({
            type: "tool",
            at,
            data: {
              id: part.tool_use_id,
              status: part.is_error ? "failed" : "completed",
              ...(part.is_error
                ? {
                    error:
                      typeof part.content === "string"
                        ? part.content
                        : (JSON.stringify(part.content) ?? "Tool failed"),
                  }
                : { output: part.content as JsonValue }),
            },
          });
        }
    } else if (message.type === "result")
      this.emit({
        type: "log",
        at,
        data: {
          status: message.subtype === "success" ? "Turn completed" : "Provider error",
          ...(message.subtype === "success"
            ? {}
            : {
                level: "error",
                detail: Array.isArray(message.errors)
                  ? message.errors.join("\n")
                  : String(message.subtype),
              }),
        },
      });
  }
  private publish(id: string, value: unknown, snapshot: boolean, thinking = false) {
    if (typeof value !== "string" || !value) return;
    const previous = this.text.get(id) ?? "";
    const next = snapshot ? value : previous + value;
    if (snapshot && next === previous) return;
    this.text.set(id, next);
    this.emit({
      type: thinking ? "log" : "text",
      at: new Date().toISOString(),
      data: {
        id,
        text: value,
        ...(snapshot ? { mode: "snapshot" } : {}),
        ...(thinking ? { channel: "thinking", thinkingKind: "content", status: "Thinking" } : {}),
      },
    });
  }
}
