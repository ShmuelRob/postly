import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalButtonPayload, ModelProvider } from '../../src/contracts/providers/index.js';
import type { InboundBurst, InboundHandler, Messaging } from '../../src/modules/messaging/index.js';
import type { Workflow } from '../../src/modules/workflow/index.js';

/** Buttons sent to the owner, by button id, so a tap in the UI carries the payload WhatsApp would. */
export type ButtonRegistry = Map<string, { title: string; payload: ApprovalButtonPayload }>;

export interface FlowDeps {
  /** The messaging module; a getter because the module is built with this handler. */
  send: () => Messaging;
  workflow: Workflow;
  model: ModelProvider;
  buttons: ButtonRegistry;
}

/**
 * What the playground hands each inbound burst to. No product flow exists yet, so every burst goes
 * to an echo that shows what reached the workflow. When onboarding (WP-30) and the weekly flows
 * (WP-31 to WP-34) export their handlers, route bursts to them here: the echo stays only for
 * conversation steps no flow handles.
 */
export function createFlows(deps: FlowDeps): InboundHandler {
  return {
    async handleInbound(burst) {
      if (!(await deps.workflow.mayAutoReply(burst.businessId))) return;
      await echo(deps, burst);
    },
  };
}

/** Placeholder copy, not product copy: it only shows the human what the app received. */
async function echo({ send, buttons }: FlowDeps, burst: InboundBurst) {
  const reply = (text: string) => send().sendText(burst.businessId, { to: burst.from, text });
  for (const message of burst.messages) {
    const c = message.content;
    if (c.kind === 'button_reply') await reply(`לחצת: ${buttons.get(c.buttonId)?.title ?? c.buttonId}`);
  }
  if (burst.text.trim() === 'כפתורים') {
    const options = [
      { title: 'אישור', action: 'approve' as const },
      { title: 'שינוי', action: 'change' as const },
    ].map(({ title, action }) => {
      const id = `pg-${randomUUID()}`;
      buttons.set(id, { title, payload: demoPayload(id, action) });
      return { id, title };
    });
    await send().sendButtons(burst.businessId, { to: burst.from, text: 'רוצים לנסות כפתורים?', buttons: options });
  } else if (burst.text) {
    await reply(`קיבלתי: ${burst.text}`);
  }
  if (burst.messages.some((m) => m.content.kind === 'image')) await reply('קיבלתי תמונה');
  if (burst.messages.some((m) => m.content.kind === 'voice')) await reply('קיבלתי הודעה קולית');
}

/** A well-formed approval payload for a playground button. It never reaches the approval path. */
function demoPayload(buttonId: string, action: ApprovalButtonPayload['action']): ApprovalButtonPayload {
  return { action, postId: randomUUID(), versionHash: createHash('sha256').update(buttonId).digest('hex') };
}
