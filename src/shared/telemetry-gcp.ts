import { randomUUID } from 'node:crypto';
import { MetricExporter } from '@google-cloud/opentelemetry-cloud-monitoring-exporter';
import { TraceExporter } from '@google-cloud/opentelemetry-cloud-trace-exporter';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { log } from './logger.js';
import { setMeterProvider, setTracerProvider } from './telemetry.js';
import { ensureContextManager } from './telemetry-memory.js';

// Telemetry export for the deployed processes (docs/observability.md, Metrics and Tracing, WP-48).
// The only file that loads the Google Cloud exporters; everything else uses telemetry.ts.

export interface TelemetryOptions {
  /** `web`, `worker` or `console`: the `job` label of the generic_task resource. */
  service: string;
  /** `POSTLY_ENV`. Export is on only in dev, stage and prod. */
  env: string;
  /** `TELEMETRY_EXPORT=log` writes metric points as log lines locally (the playground). */
  exportMode?: string | undefined;
  project?: string | undefined;
  region?: string | undefined;
  /** `TRACE_SAMPLE_RATIO`, default 0.1. */
  sampleRatio?: string | undefined;
}

/** Writes each metric point as a `metric` log line, for local runs (no customer content: labels are clean). */
class LogMetricExporter implements PushMetricExporter {
  export(...[metrics, done]: Parameters<PushMetricExporter['export']>): void {
    for (const scope of metrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          const value = typeof point.value === 'number' ? point.value : (point.value as { count: number }).count;
          const labels = Object.fromEntries(Object.entries(point.attributes).map(([k, v]) => [`label_${k}`, String(v)]));
          log.info('metric', { metric: metric.descriptor.name, value, ...labels });
        }
      }
    }
    done({ code: ExportResultCode.SUCCESS });
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** Starts export when deployed (or with `TELEMETRY_EXPORT=log`); returns a stop that flushes. */
export function startTelemetry(options: TelemetryOptions): () => Promise<void> {
  const deployed = ['dev', 'stage', 'prod'].includes(options.env);
  const toLog = options.exportMode === 'log';
  if (!deployed && !toLog) return async () => {};
  ensureContextManager();
  const resource = resourceFromAttributes({
    'service.name': options.service,
    'service.namespace': options.env,
    'service.instance.id': `${process.env.K_REVISION ?? options.service}-${randomUUID().slice(0, 8)}`,
    'cloud.region': options.region ?? 'me-west1',
  });
  const exporter: PushMetricExporter = toLog ? new LogMetricExporter() : new MetricExporter(options.project ? { projectId: options.project } : {});
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: toLog ? 10_000 : 60_000 })],
  });
  setMeterProvider(meterProvider);

  let tracerProvider: BasicTracerProvider | undefined;
  if (deployed) {
    const ratio = Number(options.sampleRatio ?? '0.1');
    tracerProvider = new BasicTracerProvider({
      resource,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 0.1) }),
      spanProcessors: [new BatchSpanProcessor(new TraceExporter(options.project ? { projectId: options.project } : {}))],
    });
    setTracerProvider(tracerProvider);
  }
  return async () => {
    setMeterProvider(undefined);
    setTracerProvider(undefined);
    await Promise.allSettled([meterProvider.shutdown(), tracerProvider?.shutdown()]);
  };
}
