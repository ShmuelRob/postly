import { and, eq, isNull } from 'drizzle-orm';
import { WindowClosedError } from '../../contracts/providers/messaging.js';
import * as schema from '../../db/schema.js';
import { asError, log } from '../../shared/logger.js';
import { handOffLine } from './copy.js';
import type { AgentDeps } from './types.js';

/**
 * Hands the conversation to a person (agent.md, Limits): sets the handoff flag, opens one console
 * item with the turn id (`handoff` for the agent's own call, `agent_limit` at a limit), and sends the
 * owner the fixed line. A closed window skips the line; the console item still opens.
 */
export async function handOff(
  deps: Pick<AgentDeps, 'db' | 'messaging'>,
  input: {
    businessId: string;
    turnId: string;
    kind: 'handoff' | 'agent_limit';
    details: Record<string, unknown>;
    approverPhone: string;
    personaName: string;
    /** The business's first language: the line goes out in it. */
    language: Parameters<typeof handOffLine>[1];
    now: Date;
  },
): Promise<void> {
  const { businessId } = input;
  await deps.db.withBusiness('workflow', businessId, async (tx) => {
    const t = schema.conversationState;
    await tx
      .update(t)
      .set({ handoffAt: input.now, updatedAt: input.now })
      .where(and(eq(t.businessId, businessId), isNull(t.handoffAt)));
    await tx.insert(schema.consoleItem).values({ businessId, kind: input.kind, referenceId: input.turnId, details: { ...input.details, agentTurnId: input.turnId } });
  });
  // docs/observability.md, "Following one message": a person takes over. Only code words: the agent's
  // own reason for a hand-off may be free text, and is then left out. A hand-off after an error is ERROR.
  const code = (value: unknown) => (typeof value === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(value) ? value : undefined);
  const reason = code(input.details.reason);
  (reason === 'error' ? log.error : log.warn)('agent hand-off', {
    businessId,
    agentTurnId: input.turnId,
    kind: input.kind,
    ...(reason ? { reason } : {}),
    ...(code(input.details.agent) ? { agent: code(input.details.agent) } : {}),
  });
  // A turn that failed before its context was read has no number yet: the approver's, from the business.
  const to =
    input.approverPhone ||
    (await deps.db.withBusiness('workflow', businessId, async (tx) => {
      const [row] = await tx.select({ phone: schema.business.approverPhone }).from(schema.business).where(eq(schema.business.id, businessId));
      return row?.phone ?? '';
    }));
  try {
    await deps.messaging.sendText(businessId, { to, text: handOffLine(input.personaName, input.language) });
  } catch (error) {
    if (!(error instanceof WindowClosedError)) log.error('agent hand-off line not sent', { businessId, error: asError(error) });
  }
}
