import { describe, expect, it } from 'vitest';
import { listTransitions, type Machine } from '../../shared/state-machine.js';
import {
  CONVERSATION_STEP_VALUES,
  businessMachine,
  channelConnectionMachine,
  conversationMachine,
  onboardingMachine,
  postMachine,
  publicationMachine,
  subscriptionMachine,
  weeklyUpdateMachine,
} from './index.js';

// Each table below is copied from state-machines.md. A machine must contain
// exactly these transitions: nothing missing, nothing extra.
type Row = readonly [from: string, event: string, to: string];

function expand(froms: readonly string[], event: string, to: string): Row[] {
  return froms.map((from) => [from, event, to] as const);
}

const sorted = (rows: readonly Row[]) => [...rows].map((r) => r.join(' ')).sort();

const cases: Array<{
  machine: Machine<string, string>;
  initial: string;
  terminal: string[];
  rows: Row[];
}> = [
  {
    machine: businessMachine,
    initial: 'onboarding',
    terminal: ['cancelled'],
    rows: [
      ['onboarding', 'ONBOARDING_COMPLETED', 'active'],
      ['active', 'PAUSE', 'paused'],
      ['paused', 'RESUME', 'active'],
      ...expand(['onboarding', 'active', 'paused'], 'CANCEL', 'cancelled'),
    ],
  },
  {
    machine: onboardingMachine,
    initial: 'intro',
    terminal: ['completed'],
    rows: [
      ['intro', 'INTRO_SENT', 'profile_questions'],
      ['profile_questions', 'PROFILE_FIELDS_COMPLETE', 'brand_assets'],
      ['brand_assets', 'BRAND_ASSETS_DONE', 'style_selection'],
      ['style_selection', 'STYLE_CHOSEN', 'profile_review'],
      ['profile_review', 'PROFILE_CORRECTED', 'profile_review'],
      ['profile_review', 'PROFILE_APPROVED', 'channel_connection'],
      ['channel_connection', 'CHANNEL_CONNECTED', 'channel_test'],
      ['channel_test', 'CHANNEL_TEST_FAILED', 'channel_connection'],
      ['channel_test', 'CHANNEL_TEST_PASSED', 'completed'],
    ],
  },
  {
    machine: conversationMachine,
    initial: 'idle',
    terminal: [],
    rows: [
      ['idle', 'UPDATE_RECEIVED', 'processing_update'],
      ['processing_update', 'QUESTION_ASKED', 'awaiting_answer'],
      ['awaiting_answer', 'ANSWER_RECEIVED', 'processing_update'],
      ['processing_update', 'DRAFTS_SENT', 'reviewing_drafts'],
      ['reviewing_drafts', 'CHANGE_REQUESTED', 'processing_update'],
      ['reviewing_drafts', 'ALL_DRAFTS_RESOLVED', 'confirming_schedule'],
      ['confirming_schedule', 'SCHEDULE_CHANGE_REQUESTED', 'confirming_schedule'],
      ['confirming_schedule', 'SCHEDULE_CONFIRMED', 'idle'],
      ['confirming_schedule', 'CHANGE_REQUESTED', 'processing_update'],
    ],
  },
  {
    machine: weeklyUpdateMachine,
    initial: 'awaiting',
    terminal: ['planned', 'skipped'],
    rows: [
      ['awaiting', 'REMINDER_SENT', 'reminded'],
      ['awaiting', 'UPDATE_RECEIVED', 'received'],
      ['reminded', 'UPDATE_RECEIVED', 'received'],
      ['awaiting', 'WEEK_ENDED', 'skipped'],
      ['reminded', 'WEEK_ENDED', 'skipped'],
      ['received', 'FACTS_EXTRACTED', 'planned'],
      ['received', 'EXTRACTION_FAILED', 'needs_review'],
      ['needs_review', 'FACTS_EXTRACTED', 'planned'],
    ],
  },
  {
    machine: postMachine,
    initial: 'planned',
    terminal: ['published', 'cancelled'],
    rows: [
      ['planned', 'DRAFT_STARTED', 'drafting'],
      ['drafting', 'DETAIL_MISSING', 'awaiting_clarification'],
      ['awaiting_clarification', 'DETAIL_PROVIDED', 'drafting'],
      ['drafting', 'DRAFT_READY', 'awaiting_approval'],
      ['drafting', 'DRAFT_FAILED', 'needs_review'],
      ['needs_review', 'DRAFT_STARTED', 'drafting'],
      ['awaiting_approval', 'APPROVED', 'approved'],
      ['awaiting_approval', 'CHANGE_REQUESTED', 'drafting'],
      ['approved', 'CHANGE_REQUESTED', 'drafting'],
      ['approved', 'SCHEDULED', 'scheduled'],
      ['scheduled', 'CHANGE_REQUESTED', 'drafting'],
      ['scheduled', 'PUBLISHING_STARTED', 'publishing'],
      ['publishing', 'ALL_PUBLISHED', 'published'],
      ['publishing', 'PARTIALLY_PUBLISHED', 'partially_published'],
      ['publishing', 'ALL_FAILED', 'failed'],
      ['partially_published', 'ALL_PUBLISHED', 'published'],
      ['failed', 'PUBLISHING_STARTED', 'publishing'],
      ...expand(
        [
          'planned',
          'drafting',
          'awaiting_clarification',
          'awaiting_approval',
          'approved',
          'scheduled',
          'needs_review',
        ],
        'CANCELLED',
        'cancelled',
      ),
    ],
  },
  {
    machine: publicationMachine,
    initial: 'scheduled',
    terminal: ['published', 'cancelled'],
    rows: [
      ['scheduled', 'STARTED', 'in_progress'],
      ['in_progress', 'SUCCEEDED', 'published'],
      ['in_progress', 'ATTEMPT_FAILED', 'retry_pending'],
      ['in_progress', 'ATTEMPTS_EXHAUSTED', 'failed'],
      ['retry_pending', 'STARTED', 'in_progress'],
      ['failed', 'RETRY_REQUESTED', 'retry_pending'],
      ['scheduled', 'CANCELLED', 'cancelled'],
      ['retry_pending', 'CANCELLED', 'cancelled'],
    ],
  },
  {
    machine: channelConnectionMachine,
    initial: 'pending',
    terminal: ['revoked'],
    rows: [
      ['pending', 'CONNECTED', 'connected'],
      ['connected', 'TEST_PASSED', 'verified'],
      ['connected', 'TEST_FAILED', 'pending'],
      ['verified', 'HEALTH_CHECK_FAILED', 'disconnected'],
      ['disconnected', 'RECONNECT_REQUESTED', 'pending'],
      ...expand(['pending', 'connected', 'verified', 'disconnected'], 'REVOKED', 'revoked'),
    ],
  },
  {
    machine: subscriptionMachine,
    initial: 'pending',
    terminal: ['cancelled'],
    rows: [
      ['pending', 'PAYMENT_SUCCEEDED', 'active'],
      ['active', 'PAYMENT_FAILED', 'past_due'],
      ['past_due', 'PAYMENT_SUCCEEDED', 'active'],
      ...expand(['pending', 'active', 'past_due'], 'CANCELLED', 'cancelled'),
    ],
  },
];

describe.each(cases)('$machine.name machine', ({ machine, initial, terminal, rows }) => {
  it('has exactly the documented transitions', () => {
    expect(sorted(listTransitions(machine))).toEqual(sorted(rows));
  });

  it('has the documented initial and terminal states', () => {
    expect(machine.initial).toBe(initial);
    expect([...machine.terminal].sort()).toEqual([...terminal].sort());
  });

  it('has no unreachable states', () => {
    const reachable = new Set([machine.initial, ...rows.map(([, , to]) => to)]);
    expect([...machine.states].filter((s) => !reachable.has(s))).toEqual([]);
  });
});

describe('approval invariant in the post machine', () => {
  it('only reaches approved from awaiting_approval', () => {
    const intoApproved = listTransitions(postMachine).filter(([, , to]) => to === 'approved');
    expect(intoApproved).toEqual([['awaiting_approval', 'APPROVED', 'approved']]);
  });

  it('only reaches publishing from scheduled or a failed retry', () => {
    const intoPublishing = listTransitions(postMachine)
      .filter(([, , to]) => to === 'publishing')
      .map(([from]) => from)
      .sort();
    expect(intoPublishing).toEqual(['failed', 'scheduled']);
  });

  it('sends every change request back to drafting', () => {
    const changes = listTransitions(postMachine).filter(([, event]) => event === 'CHANGE_REQUESTED');
    expect(changes.map(([, , to]) => to)).toEqual(changes.map(() => 'drafting'));
  });
});

describe('conversation_step enum', () => {
  it('lists onboarding steps followed by conversation steps, without duplicates', () => {
    expect(CONVERSATION_STEP_VALUES).toEqual([...onboardingMachine.states, ...conversationMachine.states]);
    expect(new Set(CONVERSATION_STEP_VALUES).size).toBe(CONVERSATION_STEP_VALUES.length);
  });
});
