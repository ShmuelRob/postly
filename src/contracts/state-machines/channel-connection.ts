import { defineMachine } from '../../shared/state-machine.js';

export const CHANNEL_CONNECTION_STATES = ['pending', 'connected', 'verified', 'disconnected', 'revoked'] as const;
export type ChannelConnectionState = (typeof CHANNEL_CONNECTION_STATES)[number];

export const channelConnectionMachine = defineMachine({
  name: 'channel_connection',
  states: CHANNEL_CONNECTION_STATES,
  events: ['CONNECTED', 'TEST_PASSED', 'TEST_FAILED', 'HEALTH_CHECK_FAILED', 'RECONNECT_REQUESTED', 'REVOKED'],
  initial: 'pending',
  terminal: ['revoked'],
  transitions: {
    pending: { CONNECTED: 'connected', REVOKED: 'revoked' },
    connected: { TEST_PASSED: 'verified', TEST_FAILED: 'pending', REVOKED: 'revoked' },
    verified: { HEALTH_CHECK_FAILED: 'disconnected', REVOKED: 'revoked' },
    disconnected: { RECONNECT_REQUESTED: 'pending', REVOKED: 'revoked' },
  },
});
