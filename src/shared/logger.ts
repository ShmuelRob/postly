import { AsyncLocalStorage } from 'node:async_hooks';
import { context as otelContext, trace as otelTrace } from '@opentelemetry/api';

// The one logger (docs/observability.md, Logging): JSON lines on stdout in Cloud Logging's structured
// format, correlation ids from an AsyncLocalStorage context, and no customer content or secrets.
// WP-48: every ERROR line is a Cloud Error Reporting event, and a line inside a span carries its trace.

export type LogValue = string | number | boolean | null | undefined | Error;
export type LogFields = Record<string, LogValue>;

export interface LogContext {
  requestId?: string | undefined;
  businessId?: string | undefined;
  messageId?: string | undefined;
  jobId?: string | undefined;
  jobName?: string | undefined;
  /** The inbound message a chain of work started from (docs/observability.md, "Following one message"). */
  correlationId?: string | undefined;
  agentTurnId?: string | undefined;
  /** `projects/<project>/traces/<id>`, see traceFromHeaders. */
  trace?: string | undefined;
}

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const storage = new AsyncLocalStorage<LogContext>();
const LABEL_KEYS = ['requestId', 'businessId', 'messageId', 'correlationId', 'agentTurnId', 'jobId', 'jobName'] as const;
const MAX_STRING = 500;
const REDACTED = '[redacted]';

let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);
let baseLabels: Record<string, string> = {};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Severity, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3 };
const LEVEL_SEVERITY: Record<LogLevel, Severity> = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };
let minimum = LEVELS.INFO;

/** The lowest severity written (LOG_LEVEL, docs/observability.md); undefined restores `info`. */
export function setLogLevel(level: LogLevel | undefined): void {
  minimum = LEVELS[LEVEL_SEVERITY[level ?? 'info']];
}

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

/**
 * Adds ids to the current scope, for an id known only part way through it (an agent turn's id once
 * its row exists). Only inside a withLogContext scope; outside one it does nothing. It mutates the
 * scope's store in place, so it reaches every later line of that scope, including code that runs
 * concurrently in it; open a scope of your own (withLogContext({}, fn)) so an id never leaks to the
 * caller's later lines, as the agent runtime does per turn.
 */
export function addLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
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

const REPORTED_ERROR = 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

/**
 * `Name: scrubbed message` and the stack frames (paths and line numbers only), for Error Reporting,
 * then each cause as `Caused by: Name: scrubbed message` with its frames.
 */
function stackTrace(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    const e = asError(current);
    const frames = (e.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)).slice(0, depth === 0 ? 30 : 10);
    parts.push(`${depth === 0 ? '' : 'Caused by: '}${e.name}: ${scrub(safeMessage(e))}`, ...frames);
    current = e.cause;
  }
  return parts.join('\n');
}

/**
 * An error's message without the values it may quote (review of PR #136). A Drizzle query error reads
 * "Failed query: <sql>\nparams: <params>", and the params are what the query wrote (a message body,
 * a caption): only the SQL and the parameter count are kept. A Postgres message quotes a bad value
 * after a colon (`invalid input value for enum x: "<value>"`); the value is redacted, the names it
 * quotes elsewhere (`column "x"`) are kept.
 */
function safeMessage(error: Error): string {
  let message = error.message;
  if (message.startsWith('Failed query: ')) {
    const cut = message.indexOf('\nparams:');
    const params = (error as { params?: unknown }).params;
    const sqlText = cut === -1 ? message : message.slice(0, cut);
    message = Array.isArray(params) ? `${sqlText} (${params.length} params)` : sqlText;
  }
  return message.replace(/: "(?:[^"\\]|\\.)*"/g, ': "[redacted]"');
}

/**
 * Anything thrown, as text to store (a console item's details, `last_error`, `model_run.error`, a
 * refusal's detail): the safe message, never a query's parameters, cut at 500 characters. Log fields
 * take the error itself (`{ error }` or `asError(error)`), never this text (docs/observability.md, Errors).
 */
export function errorText(value: unknown, max = 500): string {
  return safeMessage(asError(value)).slice(0, max);
}

/**
 * `Name: safe message`, cut at 500 characters: the text the console items that once stored
 * `String(error)` keep (draft_failed, extraction_failed, payment_link_failed, the agent's error hand-off),
 * so their details read as before, without a query's parameters.
 */
export function errorDetail(value: unknown, max = 500): string {
  const error = asError(value);
  return `${error.name}: ${safeMessage(error)}`.slice(0, max);
}

type ErrorLike = { message: string; name?: unknown; stack?: unknown; code?: unknown; cause?: unknown };

/** An object with a string `message`: pg-boss emits some failures as plain copies of an error. */
function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { message?: unknown }).message === 'string';
}

const scalarCode = (code: unknown): code is string | number => typeof code === 'string' || typeof code === 'number';

/**
 * Anything thrown, as an Error to log: an Error as it is; an error-like object (a string `message`)
 * with its name, code, stack and cause; any other object as `non-error object thrown` with only its
 * code, since its other fields may hold content; a primitive by its text.
 */
export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value !== 'object' || value === null) return new Error(String(value));
  const like = value as Partial<ErrorLike>;
  const error: Error & { code?: string | number } = isErrorLike(value)
    ? new Error(value.message, value.cause === undefined ? undefined : { cause: value.cause })
    : new Error('non-error object thrown');
  if (isErrorLike(value) && typeof like.name === 'string') error.name = like.name;
  // Never this function's own frames: a copied stack, or none.
  error.stack = typeof like.stack === 'string' ? like.stack : `${error.name}: ${error.message}`;
  if (scalarCode(like.code)) error.code = like.code;
  return error;
}

/** An error field `key` as scalar fields: `key` (the message), `keyName`, `keyCode`, `keyCause`, `keyCauseCode`. */
function errorFields(key: string, value: Error | ErrorLike): Record<string, unknown> {
  const error = asError(value);
  const code = (error as { code?: unknown }).code;
  const fields: Record<string, unknown> = { [key]: safeMessage(error), [`${key}Name`]: error.name };
  if (scalarCode(code)) fields[`${key}Code`] = code;
  if (error.cause !== undefined && error.cause !== null) {
    const cause = asError(error.cause);
    fields[`${key}Cause`] = `${cause.name}: ${safeMessage(cause)}`;
    const causeCode = (cause as { code?: unknown }).code;
    if (scalarCode(causeCode)) fields[`${key}CauseCode`] = causeCode;
  }
  return fields;
}

/** The trace and span of the active OpenTelemetry span, when there is one. */
function activeSpan(): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const ctx = otelTrace.getSpan(otelContext.active())?.spanContext();
  if (!ctx || !otelTrace.isSpanContextValid(ctx)) return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId, sampled: (ctx.traceFlags & 1) === 1 };
}

const sensitiveKey = (key: string) => !/Id$/.test(key) && SENSITIVE_KEY.test(key);

/** Removes phone numbers, URL credentials, bearer tokens and key-like strings from free text. */
export function scrub(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S*/gi, REDACTED)
    .replace(/\bBearer\s+\S+/gi, REDACTED)
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => (UUID.test(run) || !/\d/.test(run) ? run : REDACTED))
    // UUIDs are matched first and kept whole: their digit groups (e.g. "1-02987394") can look like a phone.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\+?\d[\d\s-]{6,}\d/gi, (run) =>
      UUID.test(run) || run.replace(/\D/g, '').length < 9 ? run : REDACTED,
    )
    .slice(0, MAX_STRING);
}

function clean(key: string, value: unknown): string | number | boolean | null | undefined {
  if (value === undefined || value === null) return value;
  // A model call's token counts (`inputTokens`, docs/observability.md, Timing lines) are numbers, never a token.
  if (sensitiveKey(key) && !(typeof value === 'number' && /^[a-z]+Tokens$/.test(key))) return REDACTED;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined; // objects and arrays are never logged
}

function write(severity: Severity, message: string, given: LogFields = {}): void {
  if (LEVELS[severity] < minimum) return;
  const context = storage.getStore() ?? {};
  // An Error (or error-like) field becomes its message, name, code and cause as scalar fields.
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value instanceof Error || isErrorLike(value)) Object.assign(fields, errorFields(key, value));
    else fields[key] = value;
  }
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
  const span = activeSpan();
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (span && project) {
    entry['logging.googleapis.com/trace'] = `projects/${project}/traces/${span.traceId}`;
    entry['logging.googleapis.com/spanId'] = span.spanId;
    entry['logging.googleapis.com/trace_sampled'] = span.sampled;
  } else if (context.trace) entry['logging.googleapis.com/trace'] = context.trace;
  if (severity === 'ERROR') {
    entry['@type'] = REPORTED_ERROR;
    entry.serviceContext = { service: baseLabels.process ?? 'postly', version: process.env.K_REVISION ?? 'local' };
  }
  if (severity === 'ERROR' || severity === 'WARNING') {
    const error = Object.values(given).find((value) => value instanceof Error || isErrorLike(value));
    if (error) entry.stack_trace = stackTrace(asError(error));
  }
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
