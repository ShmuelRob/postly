import { and, eq, isNull } from 'drizzle-orm';
import type { BusinessRole, Database, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { MACHINE_STORES, type MachineName } from './machines.js';

/**
 * Where an event came from. Inbound events on the owner-facing machines (those the workflow role
 * updates) are not applied while a person handles the conversation.
 */
export type EventSource = 'inbound' | 'system' | 'console';

/**
 * A guard from state-machines.md, owned by the module that raises the event. It runs inside the
 * transaction after the row is locked, and returns null to allow the transition or a reason to block it.
 */
export type Guard = (tx: Tx, current: { from: string; to: string }) => Promise<string | null>;

export interface EventRequest {
  machine: MachineName;
  /** Row id; the business id for business, onboarding, and conversation. */
  id: string;
  event: string;
  source: EventSource;
  guard?: Guard;
  /**
   * The role the transaction runs as, when not the machine's default: one that may update the status
   * column and whose guard writes its own rows (the approval role for `APPROVED`, publishing for
   * `SCHEDULED`). The handoff check runs only as the workflow role.
   */
  role?: BusinessRole;
  /** Who raised the event, for the audit trail; defaults to `owner` for inbound, else the source. */
  actor?: string;
  /** Ties the audit row to its cause, for example the inbound message id. */
  correlationId?: string;
}

export type RejectionReason = 'not_found' | 'invalid_transition' | 'guard_failed' | 'handoff';

export type EventResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: RejectionReason; from?: string; detail?: string };

/** A rejected event, written to the structured log. */
export interface RejectionLog {
  businessId: string;
  machine: MachineName;
  id: string;
  event: string;
  source: EventSource;
  reason: RejectionReason;
  from?: string;
  detail?: string;
}

export interface WorkflowLogger {
  rejected(entry: RejectionLog): void;
}

export const consoleLogger: WorkflowLogger = {
  rejected: (entry) => console.warn(JSON.stringify({ level: 'warn', msg: 'workflow event rejected', ...entry })),
};

export interface Workflow {
  /**
   * Applies one event in one withBusiness() transaction, as the role that owns the machine's table:
   * lock, check, guard, save. All or nothing.
   */
  apply(businessId: string, request: EventRequest): Promise<EventResult>;
  /** Marks the conversation as handled by a person and opens a `handoff` console item. */
  startHandoff(businessId: string, details?: Record<string, unknown>): Promise<void>;
  /** Clears the flag and resolves the console item, as the console; the current step resumes unchanged. */
  clearHandoff(businessId: string): Promise<void>;
  /** False while a person handles the conversation: send no automatic replies. */
  mayAutoReply(businessId: string): Promise<boolean>;
  /** Sets or clears the global publishing pause (`system_control`), a console action. */
  setGlobalPause(paused: boolean, by: string, reason?: string): Promise<void>;
}

export function createWorkflow(db: Database, logger: WorkflowLogger = consoleLogger): Workflow {
  const handoffAt = async (tx: Tx, businessId: string) => {
    const [row] = await tx
      .select({ at: schema.conversationState.handoffAt })
      .from(schema.conversationState)
      .where(eq(schema.conversationState.businessId, businessId));
    return row?.at ?? null;
  };

  return {
    async apply(businessId, request) {
      const store = MACHINE_STORES[request.machine];
      const transitions = store.machine.transitions as Record<string, Record<string, string> | undefined>;
      const role = request.role ?? store.role;
      const checkHandoff = request.source === 'inbound' && role === 'workflow';
      const result = await db.withBusiness(role, businessId, async (tx): Promise<EventResult> => {
        let guard: 'passed' | 'blocked' | null = null;
        const decide = async (): Promise<EventResult> => {
          if (checkHandoff && (await handoffAt(tx, businessId))) return { ok: false, reason: 'handoff' };
          const from = await store.load(tx, request.id);
          if (from === undefined) return { ok: false, reason: 'not_found' };
          const to = transitions[from]?.[request.event];
          if (to === undefined) return { ok: false, reason: 'invalid_transition', from };
          const blocked = request.guard ? await request.guard(tx, { from, to }) : null;
          if (request.guard) guard = blocked === null ? 'passed' : 'blocked';
          if (blocked !== null) return { ok: false, reason: 'guard_failed', from, detail: blocked };
          await store.save(tx, request.id, to);
          return { ok: true, from, to };
        };
        const outcome = await decide();
        // The audit row (WP-46) commits or rolls back with the transition.
        await tx.insert(schema.workflowEvent).values({
          businessId,
          machine: request.machine,
          rowId: request.id,
          event: request.event,
          source: request.source,
          role,
          actor: request.actor ?? (request.source === 'inbound' ? 'owner' : request.source),
          outcome: outcome.ok ? 'applied' : 'rejected',
          fromState: outcome.from ?? null,
          toState: outcome.ok ? outcome.to : null,
          guard,
          reason: outcome.ok ? null : outcome.reason,
          detail: outcome.ok ? null : (outcome.detail ?? null),
          correlationId: request.correlationId ?? null,
        });
        return outcome;
      });
      if (!result.ok) {
        const { machine, id, event, source } = request;
        const { ok: _, ...rejection } = result;
        logger.rejected({ businessId, machine, id, event, source, ...rejection });
      }
      return result;
    },

    async startHandoff(businessId, details = {}) {
      await db.withBusiness('workflow', businessId, async (tx) => {
        const t = schema.conversationState;
        const [row] = await tx
          .update(t)
          .set({ handoffAt: new Date(), updatedAt: new Date() })
          .where(and(eq(t.businessId, businessId), isNull(t.handoffAt)))
          .returning({ id: t.businessId });
        // Already handed off: the open console item stays the only one.
        if (row) await tx.insert(schema.consoleItem).values({ businessId, kind: 'handoff', referenceId: businessId, details });
      });
    },

    async clearHandoff(businessId) {
      // The team clears a handoff from the console; workflow may not update console items.
      await db.withSystem('console', async (tx) => {
        await tx
          .update(schema.conversationState)
          .set({ handoffAt: null, updatedAt: new Date() })
          .where(eq(schema.conversationState.businessId, businessId));
        const c = schema.consoleItem;
        await tx
          .update(c)
          .set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(c.businessId, businessId), eq(c.kind, 'handoff'), eq(c.status, 'open')));
      });
    },

    async mayAutoReply(businessId) {
      return db.withBusiness('workflow', businessId, async (tx) => (await handoffAt(tx, businessId)) === null);
    },

    async setGlobalPause(paused, by, reason) {
      const now = new Date();
      const values = paused
        ? { publishingPaused: true, pausedReason: reason ?? null, pausedAt: now, pausedBy: by, updatedAt: now }
        : { publishingPaused: false, pausedReason: null, pausedAt: null, pausedBy: null, updatedAt: now };
      await db.withSystem('console', (tx) =>
        tx.insert(schema.systemControl).values({ id: 1, ...values }).onConflictDoUpdate({ target: schema.systemControl.id, set: values }),
      );
    },
  };
}
