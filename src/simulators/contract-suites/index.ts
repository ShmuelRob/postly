// Shared provider contract suites. Each takes a factory so the same tests run
// against a simulator (src/simulators/*.test.ts) and later a real adapter (WP-41).
export * from './messaging.js';
export * from './model.js';
export * from './payment.js';
export * from './publishing.js';
