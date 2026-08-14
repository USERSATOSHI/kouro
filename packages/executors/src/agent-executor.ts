import type {
  ArtifactReference,
  JsonValue,
  SourceSubagentDefinition,
  SubagentExecutionSummary,
  TokenUsage,
} from '@kouro/domain';
import { err, ok, type Result } from '@usersatoshi/results';

import type {
  AgentHarnessRegistry,
  ArtifactWriter,
  ArtifactWriterError,
  HarnessError,
  HarnessExecutionRequest,
  InvocationActivitySession,
  InvocationActivitySink,
  SubagentExecutionController,
  SubagentInvocationResult,
} from './ports.ts';
import { validateStructuredOutput, type StructuredOutputIssue } from './structured-output.ts';

export const enum AgentExecutorErrorKind {
  Harness = 0,
  StructuredOutput = 1,
  Artifact = 2,
}

export type AgentExecutorError = (
  | {
      readonly kind: AgentExecutorErrorKind.Harness;
      readonly harnessId: string;
      readonly error: HarnessError;
    }
  | {
      readonly kind: AgentExecutorErrorKind.StructuredOutput;
      readonly harnessId: string;
      readonly issue: StructuredOutputIssue;
    }
  | {
      readonly kind: AgentExecutorErrorKind.Artifact;
      readonly error: ArtifactWriterError;
    }
) & { readonly subagents?: readonly SubagentExecutionSummary[] };

export interface AgentAttemptExecution {
  readonly output: JsonValue;
  readonly resumeToken?: string;
  readonly artifacts: readonly ArtifactReference[];
  readonly usage?: TokenUsage;
  readonly subagents: readonly SubagentExecutionSummary[];
}

export interface ExecuteAgentAttemptInput extends HarnessExecutionRequest {
  readonly harnessId: string;
  readonly resumeToken?: string;
  readonly subagentDefinitions?: readonly ResolvedSubagentDefinition[];
}

export interface ResolvedSubagentDefinition extends SourceSubagentDefinition {
  readonly prompt: string;
  readonly outputSchemaValue?: JsonValue;
}

interface SubagentTranscriptRecord {
  readonly sequence: number;
  readonly callId: string;
  readonly subagentId: string;
  readonly task: string;
  readonly harnessId: string;
  readonly model?: string;
  readonly reasoningEffort?: SourceSubagentDefinition['reasoningEffort'];
  readonly success: boolean;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly transcript?: string;
  readonly usage?: TokenUsage;
}

interface SubagentActivityMetadata {
  readonly sequence: number;
  readonly callId: string;
  readonly subagentId: string;
  readonly task: string;
  readonly harnessId: string;
  readonly model?: string;
  readonly reasoningEffort?: SourceSubagentDefinition['reasoningEffort'];
}

type SubagentActivityEvent =
  | (SubagentActivityMetadata & { readonly type: 'kouro.subagent.started' })
  | (SubagentActivityMetadata & {
      readonly type: 'kouro.subagent.chunk';
      readonly chunk: string;
    })
  | (SubagentActivityMetadata & {
      readonly type: 'kouro.subagent.finished';
      readonly success: boolean;
      readonly output?: JsonValue;
      readonly error?: string;
      readonly usage?: TokenUsage;
    });

type SubagentActivityObserver = (event: SubagentActivityEvent) => Promise<void>;

async function reportFailedSubagent(
  records: SubagentTranscriptRecord[],
  activity: SubagentActivityObserver | undefined,
  metadata: SubagentActivityMetadata,
  error: string,
  transcript?: string,
  usage?: TokenUsage,
): Promise<SubagentInvocationResult> {
  records.push({
    ...metadata,
    success: false,
    error,
    ...(transcript ? { transcript } : {}),
    ...(usage ? { usage } : {}),
  });
  await activity?.({
    type: 'kouro.subagent.finished',
    ...metadata,
    success: false,
    error,
    ...(usage ? { usage } : {}),
  });
  return failedSubagent(metadata.callId, error);
}

function serializeJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${serializeJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class AgentExecutor {
  constructor(
    private readonly registry: AgentHarnessRegistry,
    private readonly artifactWriter: ArtifactWriter,
    private readonly activity?: InvocationActivitySink,
  ) {}

  async execute(
    input: ExecuteAgentAttemptInput,
  ): Promise<Result<AgentAttemptExecution, AgentExecutorError>> {
    const resolved = this.registry.get(input.harnessId);
    if (resolved.isErr()) {
      return err({
        kind: AgentExecutorErrorKind.Harness,
        harnessId: input.harnessId,
        error: resolved.error,
      });
    }
    const harness = resolved.unwrap();
    const activitySession: InvocationActivitySession = {
      runId: input.runId,
      invocationSequence: input.invocationSequence,
      attemptNumber: input.attemptNumber,
      harnessId: input.harnessId,
      role: input.role,
      prompt: input.prompt,
    };
    await this.observeActivity(() => this.activity?.start(activitySession));
    let activityWrites = Promise.resolve();
    const appendActivity = (chunk: string): Promise<void> => {
      activityWrites = activityWrites.then(() =>
        this.observeActivity(() => this.activity?.append(activitySession, chunk)),
      );
      return activityWrites;
    };
    const observeSubagent: SubagentActivityObserver | undefined = this.activity
      ? (event) => appendActivity(`${JSON.stringify(event)}\n`)
      : undefined;
    const subagentRecords: SubagentTranscriptRecord[] = [];
    const subagents = this.createSubagentController(input, subagentRecords, observeSubagent);
    const request: HarnessExecutionRequest = {
      runId: input.runId,
      invocationSequence: input.invocationSequence,
      attemptNumber: input.attemptNumber,
      workingDirectory: input.workingDirectory,
      role: input.role,
      prompt: input.prompt,
      capabilities: input.capabilities,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(this.activity
        ? {
            onTranscriptChunk: appendActivity,
          }
        : {}),
      ...(input.onResumeToken ? { onResumeToken: input.onResumeToken } : {}),
      ...(input.controls ? { controls: input.controls } : {}),
      ...(subagents ? { subagents } : {}),
    };
    const execution = await (async () => {
      try {
        return input.resumeToken
          ? await harness.resume(request, input.resumeToken)
          : await harness.execute(request);
      } finally {
        await activityWrites;
        await this.observeActivity(() => this.activity?.finish(activitySession));
      }
    })();
    if (execution.isErr()) {
      return err({
        kind: AgentExecutorErrorKind.Harness,
        harnessId: input.harnessId,
        error: execution.error,
        ...(subagentRecords.length > 0
          ? { subagents: subagentSummaries(subagentRecords, input.subagentDefinitions) }
          : {}),
      });
    }
    const completed = execution.unwrap();
    const validated = validateStructuredOutput(completed.output, input.outputSchema ?? true);
    if (validated.output === undefined || validated.issue) {
      return err({
        kind: AgentExecutorErrorKind.StructuredOutput,
        harnessId: input.harnessId,
        issue: validated.issue ?? { path: '$', message: 'structured output is invalid' },
        ...(subagentRecords.length > 0
          ? { subagents: subagentSummaries(subagentRecords, input.subagentDefinitions) }
          : {}),
      });
    }

    const artifacts: ArtifactReference[] = [];
    for (const artifact of [
      {
        kind: 'harness_transcript' as const,
        mediaType: 'application/x-ndjson',
        content: transcriptWithSubagents(completed.transcript, subagentRecords),
      },
      {
        kind: 'agent_output' as const,
        mediaType: 'application/json',
        content: serializeJson(validated.output),
      },
    ]) {
      const written = await this.artifactWriter.write({
        runId: input.runId,
        invocationSequence: input.invocationSequence,
        attemptNumber: input.attemptNumber,
        ...artifact,
      });
      if (written.isErr()) {
        return err({
          kind: AgentExecutorErrorKind.Artifact,
          error: written.error,
          ...(subagentRecords.length > 0
            ? { subagents: subagentSummaries(subagentRecords, input.subagentDefinitions) }
            : {}),
        });
      }
      artifacts.push(written.unwrap());
    }

    return ok({
      output: validated.output,
      ...(completed.resumeToken ? { resumeToken: completed.resumeToken } : {}),
      ...(completed.usage ? { usage: completed.usage } : {}),
      subagents: subagentSummaries(subagentRecords, input.subagentDefinitions),
      artifacts,
    });
  }

  private createSubagentController(
    input: ExecuteAgentAttemptInput,
    records: SubagentTranscriptRecord[],
    activity?: SubagentActivityObserver,
  ): SubagentExecutionController | undefined {
    if (!input.subagentDefinitions?.length) return undefined;
    const definitions = new Map(
      input.subagentDefinitions.map((definition) => [
        definition.id,
        {
          definition,
          started: 0,
          active: 0,
        },
      ]),
    );
    let sequence = 0;
    return {
      definitions: input.subagentDefinitions.map(({ id, role }) => ({ id, role })),
      invoke: async (subagentId, task, signal) => {
        sequence += 1;
        const callSequence = sequence;
        const callId = `${subagentId}:${callSequence}`;
        const reject = (error: string, harnessId = input.harnessId): SubagentInvocationResult => {
          records.push({
            sequence: callSequence,
            callId,
            subagentId,
            task,
            harnessId,
            success: false,
            error,
          });
          return failedSubagent(callId, error);
        };
        const state = definitions.get(subagentId);
        if (!state) {
          return reject(`Subagent is not authorized: ${subagentId}`);
        }
        if (!task.trim()) {
          return reject('Subagent task must be non-empty', state.definition.harness);
        }
        if (state.started >= state.definition.maxInvocations) {
          return reject(
            `Subagent invocation limit reached: ${state.definition.maxInvocations}`,
            state.definition.harness,
          );
        }
        if (state.active >= state.definition.maxConcurrent) {
          return reject(
            `Subagent concurrency limit reached: ${state.definition.maxConcurrent}`,
            state.definition.harness,
          );
        }

        state.started += 1;
        state.active += 1;
        try {
          return await this.executeSubagent(
            input,
            state.definition,
            callSequence,
            callId,
            task,
            records,
            signal,
            activity,
          );
        } finally {
          state.active -= 1;
        }
      },
    };
  }

  private async executeSubagent(
    parent: ExecuteAgentAttemptInput,
    definition: ResolvedSubagentDefinition,
    sequence: number,
    callId: string,
    task: string,
    records: SubagentTranscriptRecord[],
    signal?: AbortSignal,
    activity?: SubagentActivityObserver,
  ): Promise<SubagentInvocationResult> {
    const harnessId = definition.harness ?? parent.harnessId;
    const model = definition.models?.[harnessId];
    const reasoningEffort = definition.reasoningEffort ?? parent.reasoningEffort;
    const activityMetadata: SubagentActivityMetadata = {
      sequence,
      callId,
      subagentId: definition.id,
      task,
      harnessId,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
    await activity?.({ type: 'kouro.subagent.started', ...activityMetadata });
    const resolved = this.registry.get(harnessId);
    if (resolved.isErr()) {
      const error = harnessErrorText(resolved.error);
      return reportFailedSubagent(records, activity, activityMetadata, error);
    }

    const execution = await resolved.unwrap().execute({
      runId: parent.runId,
      invocationSequence: parent.invocationSequence,
      attemptNumber: parent.attemptNumber,
      workingDirectory: parent.workingDirectory,
      role: definition.role,
      prompt: `${definition.prompt}\n\nDelegated task:\n${task}`,
      capabilities: definition.capabilities,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(definition.outputSchemaValue === undefined
        ? {}
        : { outputSchema: definition.outputSchemaValue }),
      ...(activity
        ? {
            onTranscriptChunk: (chunk: string) =>
              activity({ type: 'kouro.subagent.chunk', ...activityMetadata, chunk }),
          }
        : {}),
      ...(signal ? { controls: signalControl(signal) } : {}),
    });
    if (execution.isErr()) {
      const error = harnessErrorText(execution.error);
      return reportFailedSubagent(records, activity, activityMetadata, error);
    }

    const completed = execution.unwrap();
    const validated = validateStructuredOutput(
      completed.output,
      definition.outputSchemaValue ?? true,
    );
    if (validated.output === undefined || validated.issue) {
      const error = `Subagent output is invalid at ${validated.issue?.path ?? '$'}: ${
        validated.issue?.message ?? 'structured output is invalid'
      }`;
      return reportFailedSubagent(
        records,
        activity,
        activityMetadata,
        error,
        completed.transcript,
        completed.usage,
      );
    }

    records.push({
      ...activityMetadata,
      success: true,
      output: validated.output,
      transcript: completed.transcript,
      ...(completed.usage ? { usage: completed.usage } : {}),
    });
    await activity?.({
      type: 'kouro.subagent.finished',
      ...activityMetadata,
      success: true,
      output: validated.output,
      ...(completed.usage ? { usage: completed.usage } : {}),
    });
    return { callId, success: true, output: validated.output };
  }

  private async observeActivity(operation: () => Promise<void> | undefined): Promise<void> {
    try {
      await operation();
    } catch {
      // Live activity is best-effort and must never change attempt execution.
    }
  }
}

function subagentSummary(record: SubagentTranscriptRecord): SubagentExecutionSummary {
  return {
    sequence: record.sequence,
    callId: record.callId,
    subagentId: record.subagentId,
    task: record.task,
    harnessId: record.harnessId,
    ...(record.model ? { model: record.model } : {}),
    ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
    state: record.success ? 'succeeded' : 'failed',
    ...(record.error ? { error: record.error } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.output === undefined ? {} : { output: record.output }),
  };
}

function subagentSummaries(
  records: readonly SubagentTranscriptRecord[],
  definitions: readonly ResolvedSubagentDefinition[] | undefined,
): readonly SubagentExecutionSummary[] {
  const allowed = new Set((definitions ?? []).map(({ id }) => id));
  return records
    .filter(({ subagentId }) => allowed.has(subagentId))
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((record, index) => ({ ...subagentSummary(record), sequence: index + 1 }));
}

function failedSubagent(callId: string, error: string): SubagentInvocationResult {
  return { callId, success: false, error };
}

function harnessErrorText(error: HarnessError): string {
  if ('message' in error) return error.message;
  return `Harness cannot resume: ${error.harnessId}`;
}

function signalControl(signal: AbortSignal): HarnessExecutionRequest['controls'] {
  return {
    read: () => Promise.resolve({ steering: [], interruptRequested: signal.aborted }),
    steeringApplied: () => Promise.resolve(),
    steeringRejected: () => Promise.resolve(),
  };
}

function transcriptWithSubagents(
  parentTranscript: string,
  records: readonly SubagentTranscriptRecord[],
): string {
  if (records.length === 0) return parentTranscript;
  const nested = records
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((record) => JSON.stringify({ type: 'kouro.subagent', ...record }))
    .join('\n');
  return parentTranscript ? `${parentTranscript}\n${nested}` : nested;
}
