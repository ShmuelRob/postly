// The vitest TaskMeta field the e2e harness writes and the e2e reporter reads. Kept apart from
// record.ts, which the dev sandbox image compiles without vitest (the Dockerfile's sandbox target).
import type { E2eRecord } from './record.js';

declare module 'vitest' {
  interface TaskMeta {
    /** Set by the e2e harness; read by the e2e reporter. */
    e2e?: E2eRecord;
  }
}

export {};
