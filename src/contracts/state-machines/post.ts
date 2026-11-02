import { defineMachine } from '../../shared/state-machine.js';

export const POST_STATES = [
  'planned',
  'drafting',
  'awaiting_clarification',
  'awaiting_approval',
  'needs_review',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'cancelled',
] as const;
export type PostState = (typeof POST_STATES)[number];

// APPROVED and PUBLISHING_STARTED are only safe behind the approval and
// publishing guards in state-machines.md; the table alone does not check them.
export const postMachine = defineMachine({
  name: 'post',
  states: POST_STATES,
  events: [
    'DRAFT_STARTED',
    'DETAIL_MISSING',
    'DETAIL_PROVIDED',
    'DRAFT_READY',
    'DRAFT_FAILED',
    'APPROVED',
    'CHANGE_REQUESTED',
    'SCHEDULED',
    'PUBLISHING_STARTED',
    'ALL_PUBLISHED',
    'PARTIALLY_PUBLISHED',
    'ALL_FAILED',
    'CANCELLED',
  ],
  initial: 'planned',
  terminal: ['published', 'cancelled'],
  transitions: {
    planned: { DRAFT_STARTED: 'drafting', CANCELLED: 'cancelled' },
    drafting: {
      DETAIL_MISSING: 'awaiting_clarification',
      DRAFT_READY: 'awaiting_approval',
      DRAFT_FAILED: 'needs_review',
      CANCELLED: 'cancelled',
    },
    awaiting_clarification: { DETAIL_PROVIDED: 'drafting', CANCELLED: 'cancelled' },
    needs_review: { DRAFT_STARTED: 'drafting', CANCELLED: 'cancelled' },
    awaiting_approval: { APPROVED: 'approved', CHANGE_REQUESTED: 'drafting', CANCELLED: 'cancelled' },
    approved: { CHANGE_REQUESTED: 'drafting', SCHEDULED: 'scheduled', CANCELLED: 'cancelled' },
    scheduled: { CHANGE_REQUESTED: 'drafting', PUBLISHING_STARTED: 'publishing', CANCELLED: 'cancelled' },
    publishing: {
      ALL_PUBLISHED: 'published',
      PARTIALLY_PUBLISHED: 'partially_published',
      ALL_FAILED: 'failed',
    },
    partially_published: { ALL_PUBLISHED: 'published' },
    failed: { PUBLISHING_STARTED: 'publishing' },
  },
});
