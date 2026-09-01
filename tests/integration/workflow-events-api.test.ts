import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compileWorkflow } from '@kouro/adw';
import { createKouroApp } from '@kouro/api';
import type { WorkflowSourceBundle } from '@kouro/domain';
import { RunCoordinator, type Clock, type CommandRunner } from '@kouro/executors';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { ok } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  async execute() {
    return ok({ outcome: 'success', output: {} });
  }
}

class ScriptedClock implements Clock {
  constructor(private readonly times: string[]) {}

  now(): string {
    const value = this.times.shift();
    if (!value) throw new Error('No scripted clock value remains');
    return value;
  }
}

describe('workflow trace and targeted event API', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('returns stable traces and commits one validated targeted event', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kouro-event-api-'));
    const source: WorkflowSourceBundle = {
      manifest: { id: 'event-api', version: '1.0.0' },
      semanticVersions: { compiler: '0.5.0', ir: '5', expressions: '1' },
      entryNodeId: 'wait',
      nodes: [
        {
          id: 'wait',
          type: 'wait_for_event',
          event: 'reviewed',
          payloadSchema: 'review',
        },
        { id: 'done', type: 'complete' },
      ],
      transitions: [
        {
          id: 'wait.received.done',
          from: { nodeId: 'wait', outcome: 'received' },
          toNodeId: 'done',
        },
      ],
      counterLimits: {},
      schemas: {
        review: {
          type: 'object',
          required: ['approved'],
          properties: { approved: { type: 'boolean' } },
        },
      },
    };
    const compiled = compileWorkflow(source);
    if (compiled.isErr()) throw new Error(JSON.stringify(compiled.error));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    expect(store.initialize().isOk()).toBe(true);
    const coordinator = new RunCoordinator(
      store,
      new UnusedCommandRunner(),
      undefined,
      directory,
      new ScriptedClock([
        '2026-08-31T00:00:00.000Z',
        '2026-08-31T00:00:01.000Z',
        '2026-08-31T00:00:02.000Z',
      ]),
    );
    coordinator.createRun({
      runId: 'event-run',
      artifact: compiled.value,
      startingCommit: 'head',
      configuration: {},
      idempotencyKey: 'create',
    });
    await coordinator.advance('event-run');
    await coordinator.advance('event-run');
    const app = createKouroApp({ runs: store, coordinator });

    const traceResponse = await app.handle(new Request('http://localhost/runs/event-run/trace'));
    expect(traceResponse.status).toBe(200);
    const firstTrace: unknown = await traceResponse.json();
    const repeatedTrace: unknown = await (
      await app.handle(new Request('http://localhost/runs/event-run/trace'))
    ).json();
    expect(firstTrace).toEqual(repeatedTrace);

    const eventResponse = await app.handle(
      new Request('http://localhost/runs/event-run/invocations/1/events/reviewed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: { approved: true },
          actor: 'reviewer',
          idempotencyKey: 'review-event',
          expectedEventSequence: 4,
        }),
      }),
    );
    expect(eventResponse.status).toBe(200);
    expect(store.loadRun('event-run').unwrap().state.invocations[0]?.outcome).toBe('received');

    const duplicate = await app.handle(
      new Request('http://localhost/runs/event-run/invocations/1/events/reviewed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: { approved: true },
          actor: 'reviewer',
          idempotencyKey: 'review-event',
          expectedEventSequence: 4,
        }),
      }),
    );
    expect(duplicate.status).toBe(200);
    expect(store.loadRun('event-run').unwrap().nextEventSequence).toBe(5);

    const stale = await app.handle(
      new Request('http://localhost/runs/event-run/invocations/1/events/reviewed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: { approved: true },
          actor: 'reviewer',
          idempotencyKey: 'review-event-2',
          expectedEventSequence: 4,
        }),
      }),
    );
    expect(stale.status).toBe(409);
    store.dispose();
  });
});
