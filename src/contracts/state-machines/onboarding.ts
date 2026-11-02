import { defineMachine } from '../../shared/state-machine.js';

export const ONBOARDING_STEPS = [
  'intro',
  'profile_questions',
  'brand_assets',
  'style_selection',
  'profile_review',
  'channel_connection',
  'channel_test',
  'completed',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const onboardingMachine = defineMachine({
  name: 'onboarding',
  states: ONBOARDING_STEPS,
  events: [
    'INTRO_SENT',
    'PROFILE_FIELDS_COMPLETE',
    'BRAND_ASSETS_DONE',
    'STYLE_CHOSEN',
    'PROFILE_CORRECTED',
    'PROFILE_APPROVED',
    'CHANNEL_CONNECTED',
    'CHANNEL_TEST_FAILED',
    'CHANNEL_TEST_PASSED',
  ],
  initial: 'intro',
  terminal: ['completed'],
  transitions: {
    intro: { INTRO_SENT: 'profile_questions' },
    profile_questions: { PROFILE_FIELDS_COMPLETE: 'brand_assets' },
    brand_assets: { BRAND_ASSETS_DONE: 'style_selection' },
    style_selection: { STYLE_CHOSEN: 'profile_review' },
    profile_review: { PROFILE_CORRECTED: 'profile_review', PROFILE_APPROVED: 'channel_connection' },
    channel_connection: { CHANNEL_CONNECTED: 'channel_test' },
    channel_test: { CHANNEL_TEST_FAILED: 'channel_connection', CHANNEL_TEST_PASSED: 'completed' },
  },
});
