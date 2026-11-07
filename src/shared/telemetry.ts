import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Counter, type Histogram, type Meter, type MeterProvider, type TracerProvider } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { ApprovalRefusal } from '../contracts/approval.js';
import { NETWORKS } from '../contracts/common.js';
import { MODEL_TASK_NAMES } from '../contracts/model-tasks.js';
import { errorText, scrub } from './logger.js';

// Metrics and spans (docs/observability.md, Metrics and Tracing, WP-48). Code records only through
// `metrics` and `withSpan`; only the OpenTelemetry API is used here, so nothing is exported until a
// provider is set (telemetry-gcp.ts deployed, telemetry-memory.ts in tests).
//
// No customer content: every label value comes from a fixed list or a code-constant pattern, and
// span attributes are limited to ids and code words.

/** A code constant such as a job or queue name: never free text. */
const CODE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

type Allowed = readonly string[] | RegExp;
interface MetricSpec {
  kind: 'counter' | 'histogram' | 'gauge';
  unit?: string;
  description: string;
  labels: Record<string, Allowed>;
}

const OUTCOME_LIST = (...values: string[]) => values;

/** The catalogue; docs/observability.md has the same table (telemetry.test.ts compares them). */
export const METRICS = {
  'postly.messages.count': {
    kind: 'counter',
    description: 'WhatsApp messages in and out',
    labels: {
      direction: ['in', 'out'],
      kind: ['text', 'voice', 'image', 'button_reply', 'buttons', 'template'],
      outcome: ['accepted', 'duplicate', 'unknown_number', 'sent', 'failed'],
    },
  },
  'postly.drafts.count': { kind: 'counter', description: 'Draft runs of one post, by outcome', labels: { outcome: OUTCOME_LIST('sent', 'asked', 'failed') } },
  'postly.approvals.count': {
    kind: 'counter',
    description: 'Approval taps decided',
    labels: { outcome: ['approved', 'refused'], reason: ['none', ...ApprovalRefusal.options] },
  },
  'postly.publications.count': {
    kind: 'counter',
    description: 'Publication runs, by outcome and network',
    labels: { outcome: ['published', 'already_published', 'retry_pending', 'failed', 'refused', 'deferred'], network: [...NETWORKS, 'none'] },
  },
  'postly.model.calls.count': { kind: 'counter', description: 'Model attempts, by task and outcome', labels: { task: MODEL_TASK_NAMES, outcome: ['valid', 'invalid', 'provider_error'] } },
  'postly.model.cost_usd': { kind: 'counter', unit: 'USD', description: 'Model cost, by task', labels: { task: MODEL_TASK_NAMES } },
  'postly.model.latency': { kind: 'histogram', unit: 'ms', description: 'Model attempt latency', labels: { task: MODEL_TASK_NAMES, outcome: ['valid', 'invalid', 'provider_error'] } },
  'postly.jobs.duration': { kind: 'histogram', unit: 'ms', description: 'Job run duration', labels: { job: CODE_NAME, outcome: ['ok', 'failed'] } },
  'postly.jobs.failures.count': { kind: 'counter', description: 'Job runs that threw', labels: { job: CODE_NAME } },
  'postly.queue.depth': { kind: 'gauge', description: 'pg-boss jobs waiting or running', labels: { queue: CODE_NAME, state: ['queued', 'active'] } },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof METRICS;
type LabelsOf<N extends MetricName> = { [K in keyof (typeof METRICS)[N]['labels']]: (typeof METRICS)[N]['labels'][K] extends readonly (infer V)[] ? V : string };
type CounterName = { [N in MetricName]: (typeof METRICS)[N]['kind'] extends 'counter' ? N : never }[MetricName];
type HistogramName = { [N in MetricName]: (typeof METRICS)[N]['kind'] extends 'histogram' ? N : never }[MetricName];

let meterProvider: MeterProvider | undefined;
let meter: Meter | undefined;
const instruments = new Map<string, Counter | Histogram>();

/** Sets where metrics go (telemetry-gcp.ts, telemetry-memory.ts); undefined turns them off. */
export function setMeterProvider(provider: MeterProvider | undefined): void {
  meterProvider = provider;
  meter = provider?.getMeter('postly');
  instruments.clear();
}

/** The current meter, for observable gauges (the queue depth). */
export function currentMeter(): Meter | undefined {
  return meter;
}

/** Keeps declared labels only, and replaces a value outside the declared list with `other`. */
export function cleanLabels(name: MetricName, labels: Record<string, string>): Record<string, string> {
  const declared = METRICS[name].labels as Record<string, Allowed>;
  const out: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(declared)) {
    const value = labels[key];
    if (value === undefined) continue;
    out[key] = (Array.isArray(allowed) ? allowed.includes(value) : (allowed as RegExp).test(value)) ? value : 'other';
  }
  return out;
}

function instrument(name: MetricName): Counter | Histogram | undefined {
  if (!meter) return undefined;
  let found = instruments.get(name);
  if (!found) {
    const spec: MetricSpec = METRICS[name];
    const options = { description: spec.description, ...(spec.unit ? { unit: spec.unit } : {}) };
    found = spec.kind === 'histogram' ? meter.createHistogram(name, options) : meter.createCounter(name, options);
    instruments.set(name, found);
  }
  return found;
}

export const metrics = {
  count<N extends CounterName>(name: N, labels: LabelsOf<N>, value = 1): void {
    try {
      if (!(name in METRICS) || !Number.isFinite(value) || value < 0) return;
      (instrument(name) as Counter | undefined)?.add(value, cleanLabels(name, labels as Record<string, string>));
    } catch {
      // A metric never breaks the caller.
    }
  },
  record<N extends HistogramName>(name: N, value: number, labels: LabelsOf<N>): void {
    try {
      if (!(name in METRICS) || !Number.isFinite(value)) return;
      (instrument(name) as Histogram | undefined)?.record(value, cleanLabels(name, labels as Record<string, string>));
    } catch {
      // A metric never breaks the caller.
    }
  },
};

/** The only span attribute keys (docs/observability.md, Tracing). */
const SPAN_KEYS = new Set(['businessId', 'postId', 'publicationId', 'messageId', 'jobId', 'job', 'task', 'attempt', 'network', 'outcome', 'http.method', 'http.route', 'http.status_code']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_WORD = /^[A-Za-z0-9_./:-]{1,64}$/;

export type SpanAttributes = Partial<Record<'businessId' | 'postId' | 'publicationId' | 'messageId' | 'jobId' | 'job' | 'task' | 'network' | 'outcome' | 'http.method' | 'http.route', string | undefined> & Record<'attempt' | 'http.status_code', number | undefined>>;

/** Keeps allowed keys whose value is a number, a UUID or a short code word. */
export function cleanAttributes(attributes: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!SPAN_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && (UUID.test(value) || (CODE_WORD.test(value) && !/\d{7,}/.test(value)))) out[key] = value;
  }
  return out;
}

let tracerProvider: TracerProvider | undefined;

/** Sets where spans go; undefined turns them off. */
export function setTracerProvider(provider: TracerProvider | undefined): void {
  tracerProvider = provider;
}

/** A live span handle, for adding attributes once they are known (the outcome). */
export interface SpanHandle {
  set(attributes: SpanAttributes): void;
}

/**
 * Runs `fn` in a span. A throw sets status ERROR with the scrubbed error text (no exception event)
 * and is rethrown. Without a tracer provider it just runs `fn`.
 */
export async function withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
  if (!tracerProvider) return fn({ set: () => {} });
  const tracer = tracerProvider.getTracer('postly');
  return tracer.startActiveSpan(name, { attributes: cleanAttributes(attributes) }, async (span) => {
    try {
      const result = await fn({ set: (more) => span.setAttributes(cleanAttributes(more)) });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: scrub(errorText(error)) });
      throw error;
    } finally {
      span.end();
    }
  });
}

const propagator = new W3CTraceContextPropagator();

/** One request's span: `run` the rest of the request in it, `end` it with the route pattern and status. */
export interface HttpSpan {
  run<T>(fn: () => T): T;
  end(route: string | undefined, statusCode: number): void;
}

/**
 * Opens `http <method> <route>` as a child of the request's `traceparent` (Cloud Run's span). Only the
 * route pattern is recorded, never the URL.
 */
export function startHttpSpan(headers: Record<string, string | string[] | undefined>, method: string): HttpSpan {
  if (!tracerProvider) return { run: (fn) => fn(), end: () => {} };
  const parent = propagator.extract(context.active(), headers, {
    get: (carrier, key) => carrier[key],
    keys: (carrier) => Object.keys(carrier),
  });
  const span = tracerProvider.getTracer('postly').startSpan(`http ${method}`, { kind: SpanKind.SERVER, attributes: cleanAttributes({ 'http.method': method }) }, parent);
  const active = trace.setSpan(parent, span);
  return {
    run: (fn) => context.with(active, fn),
    end(route, statusCode) {
      if (route) span.updateName(`http ${method} ${route}`);
      span.setAttributes(cleanAttributes({ 'http.route': route, 'http.status_code': statusCode }));
      span.setStatus({ code: statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end();
    },
  };
}
