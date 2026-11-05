import { AsyncLocalStorage } from 'node:async_hooks';

// The one logger (docs/observability.md, Logging): JSON lines on stdout in Cloud Logging's structured
// format, correlation ids from an AsyncLocalStorage context, and no customer content or secrets.

export type LogValue = string | number | boolean | null | undefined | Error;
export type LogFields = Record<string, LogValue>;

export interface LogContext {
  requestId?: string | undefined;
  businessId?: string | undefined;
  messageId?: string | undefined;
  jobId?: string | undefined;
  jobName?: string | undefined;
  /** `projects/<project>/traces/<id>`, see traceFromHeaders. */
  trace?: string | undefined;
}

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const storage = new AsyncLocalStorage<LogContext>();
const LABEL_KEYS = ['requestId', 'businessId', 'messageId', 'jobId', 'jobName'] as const;
const MAX_STRING = 500;
const REDACTED = '[redacted]';

let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);
let baseLabels: Record<string, string> = {};

/** Replaces where lines go (tests); undefined restores stdout. */
export function setLogSink(next: ((line: string) => void) | undefined): void {
  sink = next ?? ((line) => process.stdout.write(`${line}\n`));
}

/** Labels on every line of this process, such as `{ process: 'web' }`. */
export function setLogLabels(labels: Record<string, string>): void {
  baseLabels = { ...labels };
}

/** Runs `fn` with these ids added to the current context. */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

export function currentLogContext(): LogContext {
  return { ...storage.getStore() };
}

/** The Cloud Logging trace name from `X-Cloud-Trace-Context` or `traceparent`, when the project is known. */
export function traceFromHeaders(headers: Record<string, string | string[] | undefined>, project: string | undefined): string | undefined {
  if (!project) return undefined;
  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const cloud = header('x-cloud-trace-context')?.match(/^([0-9a-f]{32})/i)?.[1];
  const w3c = header('traceparent')?.match(/^[0-9a-f]{2}-([0-9a-f]{32})-/i)?.[1];
  const id = cloud ?? w3c;
  return id ? `projects/${project}/traces/${id.toLowerCase()}` : undefined;
}

const SENSITIVE_KEY = /text|body|caption|content|^message$|phone|^from$|^to$|token|secret|passw|key|authorization|cookie|url|dsn|credential/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sensitiveKey = (key: string) => !/Id$/.test(key) && SENSITIVE_KEY.test(key);

/** Removes phone numbers, URL credentials, bearer tokens and key-like strings from free text. */
export function scrub(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S*/gi, REDACTED)
    .replace(/\bBearer\s+\S+/gi, REDACTED)
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => (UUID.test(run) || !/\d/.test(run) ? run : REDACTED))
    .replace(/\+?\d[\d\s-]{6,}\d/g, (run) => (run.replace(/\D/g, '').length >= 9 ? REDACTED : run))
    .slice(0, MAX_STRING);
}

function clean(key: string, value: unknown): string | number | boolean | null | undefined {
  if (value === undefined || value === null) return value;
  if (sensitiveKey(key)) return REDACTED;
  if (value instanceof Error) return scrub(value.message);
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined; // objects and arrays are never logged
}

function write(severity: Severity, message: string, fields: LogFields = {}): void {
  const context = storage.getStore() ?? {};
  const merged: Record<string, unknown> = { ...context, ...fields };
  const entry: Record<string, unknown> = { severity, message: scrub(message), time: new Date().toISOString() };
  const labels: Record<string, string> = { ...baseLabels };
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'trace') continue;
    const cleaned = clean(key, value);
    if (cleaned === undefined) continue;
    if ((LABEL_KEYS as readonly string[]).includes(key)) labels[key] = String(cleaned);
    else if (!(key in context)) entry[key] = cleaned;
    else if (key in fields) entry[key] = cleaned;
  }
  for (const key of LABEL_KEYS) if (key in fields && labels[key] !== undefined) entry[key] = labels[key];
  if (context.trace) entry['logging.googleapis.com/trace'] = context.trace;
  if (Object.keys(labels).length > 0) entry['logging.googleapis.com/labels'] = labels;
  try {
    sink(JSON.stringify(entry));
  } catch {
    // A log line never breaks the caller.
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => write('DEBUG', message, fields),
  info: (message: string, fields?: LogFields) => write('INFO', message, fields),
  warn: (message: string, fields?: LogFields) => write('WARNING', message, fields),
  error: (message: string, fields?: LogFields) => write('ERROR', message, fields),
};
