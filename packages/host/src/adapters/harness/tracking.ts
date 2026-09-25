import type { HarnessEvent, JsonValue } from "@kouro/core";
import type { HarnessAdapter } from "../../types.ts";

/** Cross-cutting observation for a single harness invocation. */
export class TrackingHarnessDecorator implements HarnessAdapter {
  readonly id: string;
  readonly adapterVersion: string;
  readonly steer?: HarnessAdapter["steer"];

  constructor(
    private readonly inner: HarnessAdapter,
    private readonly track: (event: HarnessEvent) => void,
  ) {
    this.id = inner.id;
    this.adapterVersion = inner.adapterVersion;
    if (inner.steer) this.steer = (input) => inner.steer!(input);
  }

  capabilities() {
    return this.inner.capabilities();
  }

  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    const startedAt = performance.now();
    const seen = new Set<string>();
    const trackedEvents: HarnessEvent[] = [];
    let streamedAny = false;
    let pendingText = "";
    let textTimer: ReturnType<typeof setTimeout> | undefined;
    const emit = (event: HarnessEvent) => {
      const key = JSON.stringify(event);
      if (seen.has(key)) return;
      seen.add(key);
      trackedEvents.push(event);
      input.onEvent?.(event);
      this.track(event);
    };
    const flushText = () => {
      if (textTimer) clearTimeout(textTimer);
      textTimer = undefined;
      if (!pendingText) return;
      const data = pendingText;
      pendingText = "";
      emit({ type: "text", at: new Date().toISOString(), data });
    };

    emit({ type: "log", at: new Date().toISOString(), data: { status: "Starting" } });
    try {
      const result = await this.inner.run({
        ...input,
        onEvent: (event) => {
          streamedAny = true;
          if (event.type === "text") {
            pendingText += String(event.data);
            if (!textTimer) textTimer = setTimeout(flushText, 100);
          } else {
            flushText();
            emit(event);
          }
        },
      });
      flushText();
      if (!streamedAny)
        for (const value of result.events) {
          const event = harnessEvent(value);
          if (event) emit(event);
        }
      emit({
        type: "usage",
        at: new Date().toISOString(),
        data: result.usage,
      });
      emit({
        type: "log",
        at: new Date().toISOString(),
        data: {
          status: result.status === "succeeded" ? "Turn completed" : "Turn ended",
          durationMs: Math.round(performance.now() - startedAt),
          ...(result.error ? { detail: result.error } : {}),
        } as JsonValue,
      });
      return { ...result, events: trackedEvents as JsonValue[] };
    } catch (cause) {
      flushText();
      emit({
        type: "log",
        at: new Date().toISOString(),
        data: {
          status: "Turn failed",
          durationMs: Math.round(performance.now() - startedAt),
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      });
      throw cause;
    } finally {
      if (textTimer) clearTimeout(textTimer);
    }
  }
}

function harnessEvent(value: JsonValue): HarnessEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, JsonValue>;
  if (
    (event.type !== "text" &&
      event.type !== "log" &&
      event.type !== "tool" &&
      event.type !== "usage") ||
    typeof event.at !== "string" ||
    event.data === undefined
  )
    return undefined;
  return event as unknown as HarnessEvent;
}
