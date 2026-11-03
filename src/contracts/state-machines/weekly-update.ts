import { defineMachine } from '../../shared/state-machine.js';

export const WEEKLY_UPDATE_STATES = ['awaiting', 'reminded', 'received', 'needs_review', 'planned', 'skipped'] as const;
export type WeeklyUpdateState = (typeof WEEKLY_UPDATE_STATES)[number];

export const weeklyUpdateMachine = defineMachine({
  name: 'weekly_update',
  states: WEEKLY_UPDATE_STATES,
  events: ['REMINDER_SENT', 'UPDATE_RECEIVED', 'WEEK_ENDED', 'FACTS_EXTRACTED', 'EXTRACTION_FAILED'],
  initial: 'awaiting',
  terminal: ['planned', 'skipped'],
  transitions: {
    awaiting: { REMINDER_SENT: 'reminded', UPDATE_RECEIVED: 'received', WEEK_ENDED: 'skipped' },
    reminded: { UPDATE_RECEIVED: 'received', WEEK_ENDED: 'skipped' },
    received: { FACTS_EXTRACTED: 'planned', EXTRACTION_FAILED: 'needs_review' },
    needs_review: { FACTS_EXTRACTED: 'planned' },
  },
});
