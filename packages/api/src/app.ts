import type { ApiErrorResponse, EventStreamMessage } from '@kouro/api-contracts';
import { Elysia, t } from 'elysia';

import { ApiErrorKind, type ApiError } from './errors.ts';
import {
  annotateEvaluation,
  evaluateStoredRun,
  getEvaluationExperiment,
  listEvaluationDatasets,
  listStoredRunEvaluations,
  preferEvaluation,
} from './evaluation-use-cases.ts';
import {
  controlInvocation,
  controlRun,
  createRun,
  deleteRun,
  decideApproval,
  deliverExternalEvent,
  getArtifact,
  getInvocationActivity,
  getRepository,
  getRun,
  getRunTrace,
  getWorkflow,
  listApprovals,
  listArtifacts,
  listEvents,
  listRepositories,
  listRuns,
  listWorkflows,
  publishRun,
  type ApiServices,
} from './use-cases.ts';
import {
  getTicket,
  listTicketProviderConfigurations,
  listTicketProjects,
  listTickets,
} from './ticket-use-cases.ts';

function statusFor(error: ApiError): 400 | 404 | 409 | 500 {
  switch (error.kind) {
    case ApiErrorKind.InvalidInput:
      return 400;
    case ApiErrorKind.NotFound:
      return 404;
    case ApiErrorKind.Conflict:
      return 409;
    case ApiErrorKind.Persistence:
    case ApiErrorKind.ArtifactRead:
      return 500;
  }
  throw new Error('Unsupported API error kind');
}

function failure(error: ApiError, set: { status?: number | string }): ApiErrorResponse {
  set.status = statusFor(error);
  return { error: { code: error.code, message: error.message } };
}

function afterSequence(request: Request, queryAfter: string | undefined): number {
  const query = Number(queryAfter ?? 0);
  const header = Number(request.headers.get('last-event-id') ?? 0);
  return Math.max(query, header);
}

function encodeEventStream(messages: readonly EventStreamMessage[]): string {
  return `retry: 1000\n\n${messages
    .map(({ id, event, data }) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')}`;
}

function evaluationUnavailable(set: { status?: number | string }): ApiErrorResponse {
  set.status = 404;
  return {
    error: {
      code: 'evaluation_services_unavailable',
      message: 'Evaluation services are not configured',
    },
  };
}

/** Creates an in-process-testable Elysia application around application use cases. */
export function createKouroApp(services: ApiServices) {
  return new Elysia({ name: 'kouro-api' })
    .get('/health', () => ({ status: 'ok' as const }))
    .get('/runs', ({ set }) => {
      const result = listRuns(services);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .post(
      '/runs',
      async ({ body, set }) => {
        const result = await createRun(services, body);
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          adw: t.String({ minLength: 1 }),
          repositoryPath: t.String({ minLength: 1 }),
          task: t.Optional(t.String({ minLength: 1 })),
          ticket: t.Optional(t.String({ minLength: 1 })),
          harnesses: t.Optional(t.Array(t.String({ minLength: 1 }))),
          harnessesByNode: t.Optional(
            t.Record(
              t.String({ minLength: 1 }),
              t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
            ),
          ),
          reasoningEffort: t.Optional(
            t.Union([t.Literal('low'), t.Literal('medium'), t.Literal('high')]),
          ),
          actor: t.String({ minLength: 1 }),
          base: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )
    .get('/runs/:runId', ({ params, set }) => {
      const result = getRun(services, params.runId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/runs/:runId/trace', ({ params, set }) => {
      const result = getRunTrace(services, params.runId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .delete('/runs/:runId', async ({ params, set }) => {
      const result = await deleteRun(services, params.runId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .post(
      '/runs/:runId/publish',
      async ({ params, body, set }) => {
        const result = await publishRun(services, params.runId, body);
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          provider: t.Optional(t.Union([t.Literal('github'), t.Literal('forgejo')])),
          remote: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )
    .get('/runs/:runId/events', ({ params, query, request, set }) => {
      const result = listEvents(services, params.runId, afterSequence(request, query.after));
      if (result.isErr()) return failure(result.error, set);
      return new Response(encodeEventStream(result.value), {
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        },
      });
    })
    .get('/runs/:runId/artifacts', ({ params, set }) => {
      const result = listArtifacts(services, params.runId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/runs/:runId/artifacts/:artifactId', async ({ params, set }) => {
      const result = await getArtifact(services, params.runId, params.artifactId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/runs/:runId/invocations/:invocationSequence/activity', async ({ params, set }) => {
      const result = await getInvocationActivity(
        services,
        params.runId,
        Number(params.invocationSequence),
      );
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .post(
      '/runs/:runId/invocations/:invocationSequence/events/:event',
      ({ params, body, set }) => {
        const result = deliverExternalEvent(
          services,
          params.runId,
          Number(params.invocationSequence),
          params.event,
          body,
        );
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          payload: t.Any(),
          actor: t.String({ minLength: 1 }),
          idempotencyKey: t.String({ minLength: 1 }),
          expectedEventSequence: t.Optional(t.Number({ minimum: 1 })),
        }),
      },
    )
    .get('/runs/:runId/approvals', ({ params, set }) => {
      const result = listApprovals(services, params.runId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/runs/:runId/evaluations', ({ params, set }) => {
      if (!services.evaluations) return evaluationUnavailable(set);
      const result = listStoredRunEvaluations(services.evaluations, services.runs, params.runId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .post(
      '/runs/:runId/evaluations',
      async ({ params, body, set }) => {
        if (!services.evaluations) return evaluationUnavailable(set);
        const result = await evaluateStoredRun(
          services.evaluations,
          services.runs,
          params.runId,
          body,
        );
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          datasetId: t.String({ minLength: 1 }),
          caseId: t.String({ minLength: 1 }),
          experimentId: t.String({ minLength: 1 }),
          actor: t.String({ minLength: 1 }),
          idempotencyKey: t.String({ minLength: 1 }),
        }),
      },
    )
    .post(
      '/evaluations/:reportId/annotations',
      ({ params, body, set }) => {
        if (!services.evaluations) return evaluationUnavailable(set);
        const result = annotateEvaluation(services.evaluations, params.reportId, body);
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          verdict: t.Union([t.Literal('pass'), t.Literal('fail'), t.Literal('unsure')]),
          note: t.String({ minLength: 1 }),
          actor: t.String({ minLength: 1 }),
          idempotencyKey: t.String({ minLength: 1 }),
        }),
      },
    )
    .get('/evaluation-experiments/:experimentId', ({ params, set }) => {
      if (!services.evaluations) return evaluationUnavailable(set);
      const result = getEvaluationExperiment(services.evaluations, params.experimentId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .post(
      '/evaluation-experiments/:experimentId/preferences',
      ({ params, body, set }) => {
        if (!services.evaluations) return evaluationUnavailable(set);
        const result = preferEvaluation(services.evaluations, params.experimentId, body);
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          leftReportId: t.String({ minLength: 1 }),
          rightReportId: t.String({ minLength: 1 }),
          preferredReportId: t.Optional(t.String({ minLength: 1 })),
          actor: t.String({ minLength: 1 }),
          reason: t.String({ minLength: 1 }),
          idempotencyKey: t.String({ minLength: 1 }),
        }),
      },
    )
    .post(
      '/runs/:runId/approvals/:invocationSequence',
      ({ params, body, set }) => {
        const result = decideApproval(
          services,
          params.runId,
          Number(params.invocationSequence),
          body,
        );
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        body: t.Object({
          decision: t.Union([
            t.Literal('grant'),
            t.Literal('reject'),
            t.Literal('request_changes'),
          ]),
          actor: t.String({ minLength: 1 }),
          reason: t.String({ minLength: 1 }),
          idempotencyKey: t.String({ minLength: 1 }),
          metadata: t.Optional(
            t.Object({
              commitTitle: t.String({ minLength: 1 }),
              commitBody: t.Optional(t.String()),
              pullRequestTitle: t.String({ minLength: 1 }),
              pullRequestBody: t.Optional(t.String()),
              draft: t.Boolean(),
            }),
          ),
          binding: t.Optional(
            t.Object({
              workflowChecksum: t.String({ minLength: 1 }),
              invocationSequence: t.Number({ minimum: 1 }),
              artifactChecksums: t.Array(t.String({ minLength: 1 })),
              resolvedAction: t.String(),
              repositoryHead: t.String({ minLength: 1 }),
              preparedTree: t.Optional(t.String({ minLength: 1 })),
              proposalChecksum: t.Optional(t.String({ minLength: 1 })),
            }),
          ),
          expectedEventSequence: t.Optional(t.Number({ minimum: 1 })),
        }),
      },
    )
    .post(
      '/runs/:runId/:action',
      ({ params, body, set }) => {
        const result = controlRun(services, params.runId, params.action, body);
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        params: t.Object({
          runId: t.String(),
          action: t.Union([t.Literal('pause'), t.Literal('resume'), t.Literal('cancel')]),
        }),
        body: t.Object({
          actor: t.String({ minLength: 1 }),
          reason: t.Optional(t.String()),
          idempotencyKey: t.String({ minLength: 1 }),
        }),
      },
    )
    .post(
      '/runs/:runId/invocations/:invocationSequence/:action',
      ({ params, body, set }) => {
        const result = controlInvocation(
          services,
          params.runId,
          Number(params.invocationSequence),
          params.action,
          body,
        );
        return result.isErr() ? failure(result.error, set) : result.value;
      },
      {
        params: t.Object({
          runId: t.String(),
          invocationSequence: t.String(),
          action: t.Union([
            t.Literal('interrupt'),
            t.Literal('retry'),
            t.Literal('skip'),
            t.Literal('steer'),
          ]),
        }),
        body: t.Object({
          actor: t.String({ minLength: 1 }),
          reason: t.Optional(t.String({ minLength: 1 })),
          message: t.Optional(t.String({ minLength: 1 })),
          idempotencyKey: t.String({ minLength: 1 }),
        }),
      },
    )
    .get('/workflows', ({ set }) => {
      const result = listWorkflows(services);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/workflows/:checksum', ({ params, set }) => {
      const result = getWorkflow(services, params.checksum);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/repositories', () => listRepositories(services))
    .get('/repositories/:repositoryId', async ({ params, set }) => {
      const result = await getRepository(services, params.repositoryId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/repositories/:repositoryId/evaluation-datasets', async ({ params, set }) => {
      if (!services.evaluations) return evaluationUnavailable(set);
      const result = await listEvaluationDatasets(
        services.evaluations,
        services.repositories,
        params.repositoryId,
      );
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/tickets', ({ query, set }) => {
      if (!services.tickets) return [];
      const result = listTickets(services.tickets, query.projectId ?? '');
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/ticket-projects', ({ set }) => {
      if (!services.tickets) return [];
      const result = listTicketProjects(services.tickets);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/tickets/:ticketId', ({ params, set }) => {
      if (!services.tickets) {
        set.status = 404;
        return {
          error: {
            code: 'ticket_services_unavailable',
            message: 'Ticket services are not configured',
          },
        };
      }
      const result = getTicket(services.tickets, params.ticketId);
      return result.isErr() ? failure(result.error, set) : result.value;
    })
    .get('/ticket-providers', () => {
      return listTicketProviderConfigurations(services.ticketProviders);
    });
}

export type KouroApp = ReturnType<typeof createKouroApp>;
