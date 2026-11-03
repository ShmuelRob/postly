import { eq } from 'drizzle-orm';
import {
  businessMachine,
  channelConnectionMachine,
  conversationMachine,
  onboardingMachine,
  postMachine,
  publicationMachine,
  subscriptionMachine,
  weeklyUpdateMachine,
} from '../../contracts/state-machines/index.js';
import type { BusinessRole, Tx } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { Machine } from '../../shared/state-machine.js';

// Where each machine's state lives (state-machines.md, "Stored in ...") and the role that may update
// it (database-schema.md, grant matrix). Onboarding and conversation share conversation_state.step,
// one row per business, so their row key is the business id.

export interface MachineStore {
  readonly machine: Machine<string, string>;
  readonly role: BusinessRole;
  /** Locks the row for this transaction and returns its state, or undefined if RLS hides it or it does not exist. */
  load(tx: Tx, id: string): Promise<string | undefined>;
  save(tx: Tx, id: string, to: string): Promise<void>;
}

type StatusTable =
  | typeof schema.business
  | typeof schema.weeklyUpdate
  | typeof schema.post
  | typeof schema.publication
  | typeof schema.channelConnection
  | typeof schema.subscription;

function statusStore(machine: Machine<string, string>, table: StatusTable, role: BusinessRole): MachineStore {
  return {
    machine,
    role,
    async load(tx, id) {
      const [row] = await tx.select({ state: table.status }).from(table).where(eq(table.id, id)).for('update');
      return row?.state;
    },
    async save(tx, id, to) {
      // The enum type of each table's status column is checked by the machine table, not here.
      await tx.update(table).set({ status: to as never, updatedAt: new Date() }).where(eq(table.id, id));
    },
  };
}

function stepStore(machine: Machine<string, string>): MachineStore {
  const t = schema.conversationState;
  return {
    machine,
    role: 'workflow',
    async load(tx, businessId) {
      const [row] = await tx.select({ step: t.step }).from(t).where(eq(t.businessId, businessId)).for('update');
      // A step of the other machine (onboarding vs conversation) has no transitions here, so it is rejected.
      return row?.step;
    },
    async save(tx, businessId, to) {
      await tx.update(t).set({ step: to as never, updatedAt: new Date() }).where(eq(t.businessId, businessId));
    },
  };
}

export const MACHINE_STORES = {
  business: statusStore(businessMachine, schema.business, 'workflow'),
  onboarding: stepStore(onboardingMachine),
  conversation: stepStore(conversationMachine),
  weekly_update: statusStore(weeklyUpdateMachine, schema.weeklyUpdate, 'workflow'),
  post: statusStore(postMachine, schema.post, 'workflow'),
  publication: statusStore(publicationMachine, schema.publication, 'publishing'),
  channel_connection: statusStore(channelConnectionMachine, schema.channelConnection, 'publishing'),
  subscription: statusStore(subscriptionMachine, schema.subscription, 'billing'),
} satisfies Record<string, MachineStore>;

export type MachineName = keyof typeof MACHINE_STORES;
