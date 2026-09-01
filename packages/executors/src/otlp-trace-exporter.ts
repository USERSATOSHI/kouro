import { err, ok, type Result } from '@usersatoshi/results';

import type { RunTrace, TraceSpan } from '@kouro/domain';
import { CommandRunnerErrorKind, type CommandRunnerError, type TraceExporter } from './ports.ts';

export interface OtlpTraceExporterOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly serviceName?: string;
  readonly onError?: (error: CommandRunnerError) => void;
}

function unixNanos(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined;
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? undefined : String(BigInt(milliseconds) * 1_000_000n);
}

function attributes(span: TraceSpan): readonly unknown[] {
  return Object.entries(span.attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : typeof value === 'number'
            ? { doubleValue: value }
            : { stringValue: JSON.stringify(value) },
  }));
}

/** Best-effort OTLP/HTTP JSON adapter; callers decide how export errors are observed. */
export class OtlpTraceExporter implements TraceExporter {
  constructor(private readonly options: OtlpTraceExporterOptions) {}

  observeFailure(error: CommandRunnerError): void {
    if (this.options.onError) {
      this.options.onError(error);
      return;
    }
    process.stderr.write(`[kouro] trace export failed: ${error.message}\n`);
  }

  async export(trace: RunTrace): Promise<Result<void, CommandRunnerError>> {
    try {
      const response = await fetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: 'service.name',
                    value: { stringValue: this.options.serviceName ?? 'kouro' },
                  },
                ],
              },
              scopeSpans: [
                {
                  scope: { name: 'kouro' },
                  spans: trace.spans.map((span) => ({
                    traceId: span.traceId,
                    spanId: span.spanId,
                    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                    name: span.name,
                    ...(unixNanos(span.startedAt)
                      ? { startTimeUnixNano: unixNanos(span.startedAt) }
                      : {}),
                    ...(unixNanos(span.finishedAt)
                      ? { endTimeUnixNano: unixNanos(span.finishedAt) }
                      : {}),
                    attributes: attributes(span),
                    status: {
                      code: span.status === 'ok' ? 1 : span.status === 'error' ? 2 : 0,
                    },
                  })),
                },
              ],
            },
          ],
        }),
      });
      if (response.ok) return ok(undefined);
      const failure: CommandRunnerError = {
        kind: CommandRunnerErrorKind.ProcessFailure,
        message: `OTLP exporter returned HTTP ${response.status}`,
      };
      return err(failure);
    } catch (cause) {
      const failure: CommandRunnerError = {
        kind: CommandRunnerErrorKind.ProcessFailure,
        message: cause instanceof Error ? cause.message : 'OTLP export failed',
      };
      return err(failure);
    }
  }
}
