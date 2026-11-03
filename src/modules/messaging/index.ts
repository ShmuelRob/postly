// Messaging: receives webhooks, removes duplicates, merges short message bursts, sends messages and templates.
// Public surface of the module: other code imports only from this file (see ../README.md).

export {
  createMessaging,
  DEFAULT_BURST_QUIET_MS,
  WINDOW_MS,
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
