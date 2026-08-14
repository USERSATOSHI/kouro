import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { ok, type Result } from '@usersatoshi/results';

import {
  AgentExecutor,
  type AgentHarness,
  type HarnessError,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type InvocationActivitySession,
  type InvocationActivitySink,
  type SubagentInvocationResult,
} from '@kouro/executors';
import { HarnessRegistry, LocalArtifactWriter } from '@kouro/harnesses';

class DelegatingParentHarness implements AgentHarness {
  readonly id = 'parent';
  results: readonly SubagentInvocationResult[] = [];

  async execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    if (!request.subagents) throw new Error('Expected declared subagents');
    expect(request.subagents.definitions).toEqual([
      { id: 'architecture', role: 'architecture-scout' },
      { id: 'tests', role: 'test-scout' },
    ]);
    const [architectureOne, architectureTwo, testsOne, testsTwo] = await Promise.all([
      request.subagents.invoke('architecture', 'Map the domain boundary'),
      request.subagents.invoke('architecture', 'Map the executor boundary'),
      request.subagents.invoke('tests', 'Find the lowest useful tests'),
      request.subagents.invoke('tests', 'Find more tests'),
    ]);
    this.results = [
      architectureOne,
      architectureTwo,
      testsOne,
      testsTwo,
      await request.subagents.invoke('architecture', 'Exceed the total limit'),
      await request.subagents.invoke('unknown', 'Try an unauthorized role'),
    ];
    return ok({
      output: { planned: true },
      transcript: '{"type":"parent"}',
      resumeToken: 'parent-session',
    });
  }

  resume(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.execute(request);
  }
}

class StreamingChildHarness implements AgentHarness {
  readonly id = 'scout';
  readonly calls: { readonly request: HarnessExecutionRequest }[] = [];

  async execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    this.calls.push({ request });
    const transcript = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Inspecting as ${request.role}` }],
      },
    });
    await request.onTranscriptChunk?.(`${transcript}\n`);
    return ok({
      output: request.role === 'test-scout' ? { files: ['test.ts'] } : { scope: request.role },
      transcript,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
  }

  resume(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.execute(request);
  }
}

class RecordingActivitySink implements InvocationActivitySink {
  readonly chunks: string[] = [];
  starts = 0;
  finishes = 0;

  start(_session: InvocationActivitySession): Promise<void> {
    this.starts += 1;
    return Promise.resolve();
  }

  append(_session: InvocationActivitySession, chunk: string): Promise<void> {
    this.chunks.push(chunk);
    return Promise.resolve();
  }

  finish(_session: InvocationActivitySession): Promise<void> {
    this.finishes += 1;
    return Promise.resolve();
  }
}

describe('bounded workflow subagents', () => {
  test('runs multiple definitions, enforces limits, and records nested transcripts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'kouro-subagents-'));
    try {
      const parent = new DelegatingParentHarness();
      const child = new StreamingChildHarness();
      const activity = new RecordingActivitySink();
      const executor = new AgentExecutor(
        new HarnessRegistry([parent, child]),
        new LocalArtifactWriter(directory),
        activity,
      );

      const executed = await executor.execute({
        runId: 'run-subagents',
        invocationSequence: 1,
        attemptNumber: 1,
        harnessId: parent.id,
        workingDirectory: directory,
        role: 'planner',
        prompt: 'Create a plan.',
        reasoningEffort: 'high',
        capabilities: ['repository.read'],
        subagentDefinitions: [
          {
            id: 'architecture',
            role: 'architecture-scout',
            prompt: 'Inspect architecture.',
            harness: child.id,
            reasoningEffort: 'low',
            capabilities: ['repository.read'],
            maxInvocations: 2,
            maxConcurrent: 2,
          },
          {
            id: 'tests',
            role: 'test-scout',
            prompt: 'Inspect tests.',
            harness: child.id,
            reasoningEffort: 'medium',
            capabilities: ['repository.read'],
            maxInvocations: 2,
            maxConcurrent: 1,
          },
        ],
      });

      expect(executed.isOk()).toBe(true);
      if (executed.isErr()) return;
      expect(executed.unwrap().subagents).toContainEqual(
        expect.objectContaining({
          callId: 'architecture:1',
          state: 'succeeded',
          output: { scope: 'architecture-scout' },
          usage: { inputTokens: 120, outputTokens: 30 },
        }),
      );
      expect(parent.results.slice(0, 3).every(({ success }) => success)).toBe(true);
      expect(parent.results[3]).toMatchObject({
        callId: 'tests:4',
        success: false,
        error: 'Subagent concurrency limit reached: 1',
      });
      expect(parent.results[4]).toMatchObject({
        callId: 'architecture:5',
        success: false,
        error: 'Subagent invocation limit reached: 2',
      });
      expect(parent.results[5]).toMatchObject({
        callId: 'unknown:6',
        success: false,
        error: 'Subagent is not authorized: unknown',
      });
      expect(child.calls).toHaveLength(3);
      expect(child.calls.map(({ request }) => request.prompt)).toEqual([
        'Inspect architecture.\n\nDelegated task:\nMap the domain boundary',
        'Inspect architecture.\n\nDelegated task:\nMap the executor boundary',
        'Inspect tests.\n\nDelegated task:\nFind the lowest useful tests',
      ]);
      expect(child.calls.every(({ request }) => request.subagents === undefined)).toBe(true);
      expect(child.calls.map(({ request }) => request.reasoningEffort)).toEqual([
        'low',
        'low',
        'medium',
      ]);
      expect(activity.starts).toBe(1);
      expect(activity.finishes).toBe(1);
      const liveTranscript = activity.chunks.join('');
      expect(liveTranscript).toContain('"type":"kouro.subagent.started"');
      expect(liveTranscript).toContain('"type":"kouro.subagent.chunk"');
      expect(liveTranscript).toContain('"type":"kouro.subagent.finished"');
      expect(liveTranscript).toContain('"callId":"architecture:1"');
      expect(liveTranscript).toContain('"callId":"tests:3"');
      expect(liveTranscript).toContain('"usage":{"inputTokens":120,"outputTokens":30}');

      const runDirectory = createHash('sha256').update('run-subagents').digest('hex');
      const transcript = await readFile(
        resolve(directory, runDirectory, '1', '1', 'harness_transcript.ndjson'),
        'utf8',
      );
      expect(transcript).toContain('"type":"kouro.subagent"');
      expect(transcript).toContain('"callId":"architecture:1"');
      expect(transcript).toContain('"callId":"tests:4"');
      expect(transcript).toContain('"task":"Find the lowest useful tests"');
      expect(transcript).toContain('"reasoningEffort":"medium"');
      expect(transcript).toContain('"usage":{"inputTokens":120,"outputTokens":30}');
      expect(transcript).toContain('Subagent is not authorized: unknown');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
