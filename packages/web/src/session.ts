export interface SessionObservation {
  attemptId: string;
  cursor?: number;
  event: Record<string, unknown>;
}

export type SessionEntry =
  | {
      kind: "message";
      id: string;
      text: string;
      scoutId?: string;
      requestId?: string;
      channel?: "thinking" | "operator";
      thinkingKind?: "content" | "summary";
      status?: string;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: string;
      input?: unknown;
      output?: unknown;
      outputArtifactId?: string;
      outputBytes?: number;
      error?: string;
      scoutId?: string;
      requestId?: string;
    }
  | { kind: "status"; id: string; message: string; scoutId?: string; requestId?: string };

/** Older Pi adapters persisted bookkeeping as empty Thinking logs. */
export function isEmptyThinkingStatus(event: Record<string, unknown>): boolean {
  const data = record(event.data);
  return (
    event.type === "log" &&
    data?.status === "Thinking" &&
    Object.keys(data).every((key) => ["status", "scoutId", "requestId", "channel"].includes(key))
  );
}

/** Group streamed deltas and tool lifecycle updates into stable readable entries. */
export function projectSession(observations: readonly SessionObservation[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const toolPositions = new Map<string, number>();
  const tools = new Map<string, Extract<SessionEntry, { kind: "tool" }>>();
  const ordered = observations
    .map((observation, index) => ({ observation, index }))
    .sort(
      (left, right) =>
        (left.observation.cursor ?? Number.MAX_SAFE_INTEGER) -
          (right.observation.cursor ?? Number.MAX_SAFE_INTEGER) || left.index - right.index,
    );
  const seen = new Set<string>();
  const fingerprints = new Map<string, number>();
  let messageAttempt: string | undefined;
  let messageRequest: string | undefined;
  const instructions = new Map<string, number>();
  const messages = new Map<string, number>();
  let messageNativeId: string | undefined;
  for (const { observation, index } of ordered) {
    if (isEmptyThinkingStatus(observation.event)) continue;
    const fingerprint = `${observation.attemptId}:${JSON.stringify(observation.event)}`;
    if (observation.cursor !== undefined) {
      const key = `${observation.attemptId}:${observation.cursor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
    } else if ((fingerprints.get(fingerprint) ?? 0) > 0) {
      fingerprints.set(fingerprint, fingerprints.get(fingerprint)! - 1);
      continue;
    }
    const { type, data } = observation.event;
    let payload = record(data);
    // Older child attribution wrapped structured text inside another text field.
    const nestedText = type === "text" ? record(payload?.text) : undefined;
    if (nestedText && typeof nestedText.text === "string")
      payload = { ...payload, text: nestedText.text, id: nestedText.id, mode: nestedText.mode };
    const scoutId = typeof payload?.scoutId === "string" ? payload.scoutId : undefined;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    if (
      type === "log" &&
      typeof payload?.idempotencyKey === "string" &&
      typeof payload?.outcome === "string"
    ) {
      const id = `${observation.attemptId}:instruction:${payload.idempotencyKey}`;
      const position = instructions.get(id);
      if (position !== undefined) {
        const entry = entries[position];
        if (entry.kind === "message") entries[position] = { ...entry, status: payload.outcome };
      } else if (typeof payload.instruction === "string") {
        instructions.set(id, entries.length);
        entries.push({
          kind: "message",
          id,
          text: payload.instruction,
          channel: "operator",
          status: payload.outcome,
        });
      } else
        entries.push({ kind: "status", id, message: String(payload.status ?? payload.outcome) });
      continue;
    }
    const thinking =
      type === "log" && payload?.channel === "thinking" && typeof payload?.text === "string";
    if (type === "text" || thinking) {
      const text =
        typeof data === "string"
          ? data
          : typeof payload?.text === "string"
            ? payload.text
            : (JSON.stringify(data) ?? String(data));
      const previous = entries.at(-1);
      const thinkingKind =
        thinking && (payload?.thinkingKind === "content" || payload?.thinkingKind === "summary")
          ? payload.thinkingKind
          : undefined;
      const nativeId = typeof payload?.id === "string" ? payload.id : undefined;
      const nativeKey = nativeId
        ? JSON.stringify([
            observation.attemptId,
            scoutId,
            requestId,
            thinking ? "thinking" : "agent",
            thinkingKind,
            nativeId,
          ])
        : undefined;
      const position = nativeKey === undefined ? undefined : messages.get(nativeKey);
      if (position !== undefined) {
        const entry = entries[position];
        if (entry.kind === "message")
          entries[position] = {
            ...entry,
            text: payload?.mode === "snapshot" ? text : entry.text + text,
          };
      } else if (
        !nativeId &&
        !messageNativeId &&
        previous?.kind === "message" &&
        previous.scoutId === scoutId &&
        messageAttempt === observation.attemptId &&
        messageRequest === requestId &&
        previous.channel === (thinking ? "thinking" : undefined) &&
        previous.thinkingKind === thinkingKind
      ) {
        entries[entries.length - 1] = { ...previous, text: previous.text + text };
      } else {
        if (nativeKey) messages.set(nativeKey, entries.length);
        entries.push({
          kind: "message",
          id: nativeKey
            ? `${observation.attemptId}:message:${nativeKey}`
            : `${observation.attemptId}:message:${observation.cursor ?? index}`,
          text,
          ...(thinking ? { channel: "thinking" as const } : {}),
          ...(thinkingKind ? { thinkingKind } : {}),
          ...(scoutId ? { scoutId } : {}),
          ...(requestId ? { requestId } : {}),
        });
      }
      messageAttempt = observation.attemptId;
      messageRequest = requestId;
      messageNativeId = nativeId;
      continue;
    }
    if (type === "tool") {
      const id = `${observation.attemptId}:${scoutId ?? "parent"}:${requestId ? `${requestId}:` : ""}${String(payload?.id ?? `tool:${observation.cursor ?? index}`)}`;
      const current = tools.get(id);
      const name = String(payload?.name ?? current?.name ?? "Tool");
      const status = normalizeToolStatus(String(payload?.status ?? "running"));
      const next = {
        kind: "tool" as const,
        id,
        name,
        status,
        ...(typeof payload?.outputArtifactId === "string"
          ? { outputArtifactId: payload.outputArtifactId, outputBytes: Number(payload.outputBytes) }
          : current?.outputArtifactId
            ? { outputArtifactId: current.outputArtifactId, outputBytes: current.outputBytes }
            : {}),
        ...(payload?.input === undefined
          ? current?.input === undefined
            ? {}
            : { input: current.input }
          : { input: payload.input }),
        ...(typeof payload?.outputDelta === "string"
          ? {
              output:
                `${typeof current?.output === "string" ? current.output : ""}${payload.outputDelta}`.slice(
                  -65536,
                ),
            }
          : payload?.output === undefined
            ? current?.output === undefined
              ? {}
              : { output: current.output }
            : { output: payload.output }),
        ...(payload?.error === undefined
          ? current?.error
            ? { error: current.error }
            : {}
          : { error: String(payload.error) }),
        ...((scoutId ?? current?.scoutId) ? { scoutId: scoutId ?? current?.scoutId } : {}),
        ...(requestId ? { requestId } : {}),
      };
      if (current) {
        const position = toolPositions.get(id);
        if (position !== undefined) entries[position] = next;
      } else {
        toolPositions.set(id, entries.length);
        entries.push(next);
      }
      tools.set(id, next);
      continue;
    }
    const message = String(
      payload?.status ?? payload?.message ?? (type === "usage" ? "Usage updated" : "Activity"),
    );
    entries.push({
      kind: "status",
      id: `${observation.attemptId}:status:${observation.cursor ?? index}`,
      message,
      ...(scoutId ? { scoutId } : {}),
      ...(requestId ? { requestId } : {}),
    });
  }
  return entries;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeToolStatus(value: string): string {
  const status = value.toLowerCase().replaceAll("_", " ");
  if (status.includes("fail") || status.includes("error")) return "failed";
  if (status.includes("end") || status.includes("complete") || status.includes("result"))
    return "completed";
  if (status.includes("start") || status.includes("update") || status.includes("running"))
    return "running";
  return value;
}
