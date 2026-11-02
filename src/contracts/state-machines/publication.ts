import { defineMachine } from '../../shared/state-machine.js';

export const PUBLICATION_STATES = [
  'scheduled',
  'in_progress',
  'retry_pending',
  'published',
  'failed',
  'cancelled',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const publicationMachine = defineMachine({
  name: 'publication',
  states: PUBLICATION_STATES,
  events: ['STARTED', 'SUCCEEDED', 'ATTEMPT_FAILED', 'ATTEMPTS_EXHAUSTED', 'RETRY_REQUESTED', 'CANCELLED'],
  initial: 'scheduled',
  terminal: ['published', 'cancelled'],
  transitions: {
    scheduled: { STARTED: 'in_progress', CANCELLED: 'cancelled' },
    in_progress: { SUCCEEDED: 'published', ATTEMPT_FAILED: 'retry_pending', ATTEMPTS_EXHAUSTED: 'failed' },
    retry_pending: { STARTED: 'in_progress', CANCELLED: 'cancelled' },
    failed: { RETRY_REQUESTED: 'retry_pending' },
  },
});
