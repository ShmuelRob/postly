import { defineMachine } from '../../shared/state-machine.js';

export const CONVERSATION_STATES = [
  'idle',
  'processing_update',
  'awaiting_answer',
  'reviewing_drafts',
  'confirming_schedule',
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const conversationMachine = defineMachine({
  name: 'conversation',
  states: CONVERSATION_STATES,
  events: [
    'UPDATE_RECEIVED',
    'QUESTION_ASKED',
    'ANSWER_RECEIVED',
    'DRAFTS_SENT',
    'CHANGE_REQUESTED',
    'ALL_DRAFTS_RESOLVED',
    'SCHEDULE_CHANGE_REQUESTED',
    'SCHEDULE_CONFIRMED',
  ],
  initial: 'idle',
  terminal: [],
  transitions: {
    idle: { UPDATE_RECEIVED: 'processing_update' },
    processing_update: { QUESTION_ASKED: 'awaiting_answer', DRAFTS_SENT: 'reviewing_drafts' },
    awaiting_answer: { ANSWER_RECEIVED: 'processing_update' },
    reviewing_drafts: { CHANGE_REQUESTED: 'processing_update', ALL_DRAFTS_RESOLVED: 'confirming_schedule' },
    confirming_schedule: {
      SCHEDULE_CHANGE_REQUESTED: 'confirming_schedule',
      SCHEDULE_CONFIRMED: 'idle',
      CHANGE_REQUESTED: 'processing_update',
    },
  },
});
