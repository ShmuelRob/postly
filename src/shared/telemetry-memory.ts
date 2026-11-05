import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { AggregationTemporality, DataPointType, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { setMeterProvider, setTracerProvider } from './telemetry.js';

// In-memory telemetry for tests and the e2e report (docs/observability.md, Metrics): points are read
// on demand, spans are kept as they end. Never used by the deployed processes.

export interface MetricPoint {
  labels: Record<string, string>;
  /** Counter and gauge value. */
  value?: number;
  /** Histogram count and sum. */
  count?: number;
  sum?: number;
}

export interface RecordedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  status: 'UNSET' | 'OK' | 'ERROR';
  statusMessage: string | undefined;
  events: string[];
}

export interface MemoryTelemetry {
  points(name: string): Promise<MetricPoint[]>;
  allPoints(): Promise<Record<string, MetricPoint[]>>;
  spans(): RecordedSpan[];
  stop(): void;
}

class ManualReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

let contextManager: AsyncLocalStorageContextManager | undefined;

/** Ensures one AsyncLocalStorage context manager, so spans nest and the logger sees the active span. */
export function ensureContextManager(): void {
  if (contextManager) return;
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
}

const STATUS = ['UNSET', 'OK', 'ERROR'] as const;

export function memoryTelemetry(): MemoryTelemetry {
  ensureContextManager();
  const reader = new ManualReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setMeterProvider(meterProvider);
  setTracerProvider(tracerProvider);

  async function allPoints(): Promise<Record<string, MetricPoint[]>> {
    const { resourceMetrics } = await reader.collect();
    const out: Record<string, MetricPoint[]> = {};
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        out[metric.descriptor.name] = metric.dataPoints.map((point) => {
          const labels = Object.fromEntries(Object.entries(point.attributes).map(([k, v]) => [k, String(v)]));
          if (metric.dataPointType === DataPointType.HISTOGRAM) {
            const h = point.value as { count: number; sum?: number };
            return { labels, count: h.count, sum: h.sum ?? 0 };
          }
          return { labels, value: point.value as number };
        });
      }
    }
    return out;
  }

  return {
    allPoints,
    points: async (name) => (await allPoints())[name] ?? [],
    spans: () =>
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        attributes: { ...span.attributes },
        status: STATUS[span.status.code],
        statusMessage: span.status.message,
        events: span.events.map((e) => e.name),
      })),
    stop() {
      setMeterProvider(undefined);
      setTracerProvider(undefined);
      void meterProvider.shutdown();
      void tracerProvider.shutdown();
    },
  };
}
