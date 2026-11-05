// Messaging: receives webhooks, removes duplicates, merges short message bursts, sends messages and templates.
// Public surface of the module: other code imports only from this file (see ../README.md).

export {
  CLAIM_LEASE_MS,
  createMessaging,
  DEFAULT_BURST_QUIET_MS,
  INBOUND_BURST_JOB,
  jobBurstWake,
  WINDOW_MS,
  type BurstWake,
  type InboundBurstJob,
  type InboundBurst,
  type InboundHandler,
  type MediaStorage,
  type Messaging,
  type MessagingOptions,
  type ReceivedMessage,
  type ReceiveOutcome,
  type Timers,
} from './messaging.js';
export { registerMessagingRoutes, WEBHOOK_PATH, type MessagingRouteOptions } from './routes.js';
