import { and, eq, isNull } from 'drizzle-orm';
import { WindowClosedError } from '../../contracts/providers/messaging.js';
import * as schema from '../../db/schema.js';
import { log } from '../../shared/logger.js';
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
  try {
    await deps.messaging.sendText(businessId, { to: input.approverPhone, text: handOffLine(input.personaName) });
  } catch (error) {
    if (!(error instanceof WindowClosedError)) log.error('agent hand-off line not sent', { businessId, error: String(error) });
  }
}
