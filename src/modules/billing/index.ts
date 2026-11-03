// Billing: payment links, subscription status, and the placeholder provider.
// Public surface of the module: other code imports only from this file (see ../README.md).

export {
  BILLING_COPY,
  createBilling,
  DEFAULT_PLAN,
  eventFor,
  type Billing,
  type BillingOptions,
  type WebhookOutcome,
} from './billing.js';
export { PAYMENT_WEBHOOK_PATH, registerBillingRoutes, type BillingRouteOptions } from './routes.js';
