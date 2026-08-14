import type { TokenUsage } from '@kouro/domain';

export type TranscriptEntryKind =
  | 'user'
  | 'agent'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'subagent';

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly text: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly subagentId?: string;
  readonly harnessId?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly task?: string;
  readonly childTranscript?: string;
  readonly usage?: TokenUsage;
}

export interface TranscriptGroup {
  readonly primary: TranscriptEntry;
  readonly results: readonly TranscriptEntry[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringAt(value: Readonly<Record<string, unknown>>, ...keys: readonly string[]) {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return undefined;
}

function tokenUsageAt(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { inputTokens, outputTokens } = value;
  const required = [inputTokens, outputTokens];
  const optional = [value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens];
  if (
    !required.every(
      (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    ) ||
    !optional.every(
      (count) =>
        count === undefined ||
        (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0),
    )
  ) {
    return undefined;
  }
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof value.cacheReadTokens === 'number'
      ? { cacheReadTokens: value.cacheReadTokens }
      : {}),
    ...(typeof value.cacheWriteTokens === 'number'
      ? { cacheWriteTokens: value.cacheWriteTokens }
      : {}),
    ...(typeof value.reasoningTokens === 'number'
      ? { reasoningTokens: value.reasoningTokens }
      : {}),
  };
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Value could not be displayed';
  }
}

function normalizedMessage(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function contentText(content: unknown, kind: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return '';
  const accepted = kind === 'reasoning' ? new Set(['thinking', 'reasoning']) : new Set(['text']);
  return content
    .filter(isRecord)
    .filter((block) => accepted.has(String(block.type)))
    .map((block) => stringAt(block, 'text', 'thinking') ?? '')
    .filter(Boolean)
    .join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return display(content);
  return content
    .map((block) =>
      isRecord(block) ? (stringAt(block, 'text') ?? display(block)) : display(block),
    )
    .filter(Boolean)
    .join('\n');
}

function addToolCall(
  entries: TranscriptEntry[],
  calls: Set<string>,
  id: string,
  callId: string,
  toolName: string,
  input: unknown,
): void {
  if (calls.has(callId)) return;
  calls.add(callId);
  entries.push({
    id,
    kind: 'tool_call',
    callId,
    toolName,
    text: display(input) || 'No input',
  });
}

function parseMessageBlocks(
  message: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): void {
  const role = message.role === 'user' ? 'user' : 'agent';
  const reasoning = contentText(message.content, 'reasoning');
  const text = contentText(message.content, 'text');
  if (reasoning) entries.push({ id: `${id}:reasoning`, kind: 'reasoning', text: reasoning });
  if (text) entries.push({ id: `${id}:text`, kind: role, text });
  if (!Array.isArray(message.content)) return;
  for (const [index, block] of message.content.entries()) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_result') {
      entries.push({
        id: `${id}:result:${index}`,
        kind: 'tool_result',
        callId: stringAt(block, 'tool_use_id', 'toolCallId', 'id') ?? `${id}:tool:${index}`,
        status: block.is_error === true ? 'failed' : 'completed',
        text: toolResultText(block.content) || 'No output',
      });
      continue;
    }
    if (!['toolCall', 'tool_use'].includes(String(block.type))) continue;
    const callId = stringAt(block, 'id', 'toolCallId', 'tool_use_id') ?? `${id}:tool:${index}`;
    addToolCall(
      entries,
      calls,
      `${id}:tool:${index}`,
      callId,
      stringAt(block, 'name', 'toolName') ?? 'tool',
      block.arguments ?? block.input,
    );
  }
}

function parseCodexItem(
  eventType: string,
  item: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): boolean {
  const itemType = stringAt(item, 'type') ?? '';
  const callId = stringAt(item, 'id', 'call_id') ?? id;
  if (itemType === 'agent_message') {
    const text = stringAt(item, 'text');
    if (text) entries.push({ id, kind: 'agent', text });
    return true;
  }
  if (itemType === 'reasoning') {
    const text = stringAt(item, 'text') ?? display(item.summary);
    if (text) entries.push({ id, kind: 'reasoning', text });
    return true;
  }
  if (itemType === 'command_execution') {
    addToolCall(entries, calls, `${id}:call`, callId, 'shell', item.command);
    if (eventType === 'item.completed') {
      entries.push({
        id: `${id}:result`,
        kind: 'tool_result',
        callId,
        toolName: 'shell',
        status: stringAt(item, 'status') ?? display(item.exit_code),
        text: stringAt(item, 'aggregated_output', 'output') ?? 'No output',
      });
    }
    return true;
  }
  if (itemType === 'mcp_tool_call') {
    const toolName = [stringAt(item, 'server'), stringAt(item, 'tool', 'name')]
      .filter(Boolean)
      .join('.');
    addToolCall(entries, calls, `${id}:call`, callId, toolName || 'MCP tool', item.arguments);
    if (eventType === 'item.completed') {
      entries.push({
        id: `${id}:result`,
        kind: 'tool_result',
        callId,
        toolName: toolName || 'MCP tool',
        status: stringAt(item, 'status'),
        text: display(item.result ?? item.error) || 'No output',
      });
    }
    return true;
  }
  if (itemType === 'web_search') {
    addToolCall(entries, calls, `${id}:call`, callId, 'web search', item.query);
    if (eventType === 'item.completed') {
      entries.push({
        id: `${id}:result`,
        kind: 'tool_result',
        callId,
        toolName: 'web search',
        status: stringAt(item, 'status'),
        text: display(item.result) || 'Search completed',
      });
    }
    return true;
  }
  return false;
}

function parseToolEvent(
  event: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): boolean {
  const eventType = stringAt(event, 'type') ?? '';
  if (eventType === 'tool_execution_start') {
    const callId = stringAt(event, 'toolCallId', 'callID', 'id') ?? id;
    addToolCall(
      entries,
      calls,
      id,
      callId,
      stringAt(event, 'toolName', 'tool') ?? 'tool',
      event.args ?? event.input,
    );
    return true;
  }
  if (eventType === 'tool_execution_end' || eventType === 'tool_result') {
    entries.push({
      id,
      kind: 'tool_result',
      callId: stringAt(event, 'toolCallId', 'callID', 'tool_use_id', 'id') ?? id,
      toolName: stringAt(event, 'toolName', 'tool'),
      status: event.isError === true ? 'failed' : (stringAt(event, 'status') ?? 'completed'),
      text: display(event.result ?? event.output ?? event.content) || 'No output',
    });
    return true;
  }
  return false;
}

function parseOpenCodePart(
  part: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): boolean {
  const partType = stringAt(part, 'type') ?? '';
  if (partType === 'text' && typeof part.text === 'string') {
    entries.push({ id, kind: 'agent', text: part.text });
    return true;
  }
  if (partType === 'reasoning' && typeof part.text === 'string') {
    entries.push({ id, kind: 'reasoning', text: part.text });
    return true;
  }
  if (partType !== 'tool' || !isRecord(part.state)) return false;
  const callId = stringAt(part, 'callID', 'callId', 'id') ?? id;
  const toolName = stringAt(part, 'tool', 'name') ?? 'tool';
  addToolCall(entries, calls, `${id}:call`, callId, toolName, part.state.input);
  if (['completed', 'error'].includes(String(part.state.status))) {
    entries.push({
      id: `${id}:result`,
      kind: 'tool_result',
      callId,
      toolName,
      status: String(part.state.status),
      text: display(part.state.output ?? part.state.error) || 'No output',
    });
  }
  return true;
}

function liveSubagentEntry(
  event: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
): TranscriptEntry {
  const callId = stringAt(event, 'callId') ?? id;
  const reasoningEffort = stringAt(event, 'reasoningEffort');
  const existing = entries.find((entry) => entry.kind === 'subagent' && entry.callId === callId);
  if (existing) return existing;
  const entry: TranscriptEntry = {
    id,
    kind: 'subagent',
    callId,
    subagentId: stringAt(event, 'subagentId') ?? 'subagent',
    harnessId: stringAt(event, 'harnessId'),
    model: stringAt(event, 'model'),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    task: stringAt(event, 'task'),
    status: 'running',
    text: 'Subagent is running',
  };
  entries.push(entry);
  return entry;
}

function parseLiveSubagentEvent(
  event: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
): boolean {
  const eventType = stringAt(event, 'type') ?? '';
  if (
    !['kouro.subagent.started', 'kouro.subagent.chunk', 'kouro.subagent.finished'].includes(
      eventType,
    )
  ) {
    return false;
  }
  const current = liveSubagentEntry(event, id, entries);
  const index = entries.indexOf(current);
  if (eventType === 'kouro.subagent.chunk') {
    entries[index] = {
      ...current,
      childTranscript: `${current.childTranscript ?? ''}${stringAt(event, 'chunk') ?? ''}`,
    };
    return true;
  }
  if (eventType === 'kouro.subagent.finished') {
    const success = event.success === true;
    entries[index] = {
      ...current,
      status: success ? 'completed' : 'failed',
      text: success
        ? display(event.output) || 'Completed without structured output'
        : stringAt(event, 'error') || 'Subagent failed',
      ...(tokenUsageAt(event.usage) ? { usage: tokenUsageAt(event.usage) } : {}),
    };
  }
  return true;
}

function parseEvent(
  event: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): void {
  const eventType = stringAt(event, 'type') ?? '';
  if (parseLiveSubagentEvent(event, id, entries)) return;
  if (eventType === 'kouro.subagent') {
    const subagentId = stringAt(event, 'subagentId') ?? 'subagent';
    const success = event.success === true;
    const reasoningEffort = stringAt(event, 'reasoningEffort');
    entries.push({
      id,
      kind: 'subagent',
      callId: stringAt(event, 'callId') ?? id,
      subagentId,
      harnessId: stringAt(event, 'harnessId'),
      model: stringAt(event, 'model'),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      task: stringAt(event, 'task'),
      status: success ? 'completed' : 'failed',
      text: success
        ? display(event.output) || 'Completed without structured output'
        : stringAt(event, 'error') || 'Subagent failed',
      childTranscript: stringAt(event, 'transcript'),
      ...(tokenUsageAt(event.usage) ? { usage: tokenUsageAt(event.usage) } : {}),
    });
    return;
  }
  if (isRecord(event.item) && parseCodexItem(eventType, event.item, id, entries, calls)) return;
  if (parseToolEvent(event, id, entries, calls)) return;
  if (isRecord(event.part) && parseOpenCodePart(event.part, id, entries, calls)) return;
  if (['assistant', 'user', 'message_end'].includes(eventType) && isRecord(event.message)) {
    parseMessageBlocks(event.message, id, entries, calls);
    return;
  }
  if (typeof event.result === 'string') {
    const result = event.result;
    const previousAgent = entries.findLast((entry) => entry.kind === 'agent');
    if (!previousAgent || normalizedMessage(previousAgent.text) !== normalizedMessage(result)) {
      entries.push({ id, kind: 'agent', text: result });
    }
    return;
  }
  if (event.role === 'user' || event.role === 'assistant') {
    const text =
      typeof event.content === 'string' ? event.content : contentText(event.content, 'text');
    if (text) entries.push({ id, kind: event.role === 'user' ? 'user' : 'agent', text });
  }
}

export function parseTranscript(content: string, userPrompt?: string): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const calls = new Set<string>();
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) parseEvent(parsed, `event-${index}`, entries, calls);
    } catch {
      // A partial live JSONL line is rendered after the next polling update.
    }
  }
  if (entries.length === 0 && content.trim()) {
    entries.push({ id: 'plain-transcript', kind: 'agent', text: content.trim() });
  }
  if (
    userPrompt &&
    !entries.some(
      (entry) =>
        entry.kind === 'user' && normalizedMessage(entry.text) === normalizedMessage(userPrompt),
    )
  ) {
    entries.unshift({ id: 'user-prompt', kind: 'user', text: userPrompt });
  }
  return entries;
}

export function groupTranscript(entries: readonly TranscriptEntry[]): readonly TranscriptGroup[] {
  const resultsByCall = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    if (!['tool_result', 'subagent'].includes(entry.kind) || !entry.callId) continue;
    const results = resultsByCall.get(entry.callId) ?? [];
    results.push(entry);
    resultsByCall.set(entry.callId, results);
  }
  const matchedResults = new Set(
    entries
      .filter((entry) => entry.kind === 'tool_call' && entry.callId)
      .flatMap((entry) => resultsByCall.get(entry.callId ?? '') ?? [])
      .map(({ id }) => id),
  );
  return entries
    .filter(
      (entry) => !['tool_result', 'subagent'].includes(entry.kind) || !matchedResults.has(entry.id),
    )
    .map((entry) => ({
      primary: entry,
      results:
        entry.kind === 'tool_call' && entry.callId ? (resultsByCall.get(entry.callId) ?? []) : [],
    }));
}
