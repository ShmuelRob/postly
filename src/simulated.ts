import { createApp, type App, type AppOptions } from './app.js';
import type { ModelProvider } from './contracts/providers/model.js';
import { createDatabase, type DatabaseUrls } from './db/index.js';
import { PAYMENT_WEBHOOK_PATH } from './modules/billing/index.js';
import { createDesignRenderer } from './modules/design/index.js';
import { WEBHOOK_PATH } from './modules/messaging/index.js';
import { buildServer } from './server.js';
import { conversationalModelSimulator } from './simulators/conversational/index.js';
import { MessagingSimulator, PaymentSimulator, PersistentSimulator, PublishingSimulator, type SimulatorStore } from './simulators/index.js';
import { placeholderPng } from './simulators/png.js';

// Simulated mode (WP-51, docs/deployment.md "Simulated mode"): the providers of one process (web or
// worker) on the simulators, with their state and the media in a SimulatorStore shared by every process.

export interface SimulatedWorldOptions {
  store: SimulatorStore;
  /** Separates worlds sharing one store (tests); empty in dev. */
  namespace?: string;
  /** Signs and verifies the messaging and payment simulators' webhooks (Secret Manager in dev). */
  webhookSecret: string;
  /** The web service's public URL: webhooks are signed over it, media URLs are built from it. */
  publicBaseUrl: string;
  businessNumber: string;
  /** The sandbox, where payment links point (its checkout page). */
  sandboxUrl?: string;
  now?: () => Date;
}

/** The simulator state names in the store; the sandbox reads the same ones. */
export const simulatorNames = (namespace = '') => ({
  messaging: `${namespace}messaging`,
  publishing: `${namespace}publishing`,
  payment: `${namespace}payment`,
  sandbox: `${namespace}sandbox`,
  media: `${namespace}media/`,
});

export const SAMPLE_PHOTO_PATH = 'bundled/sample.png';

/** One process's view of the simulated outside world. */
export function simulatedWorld(options: SimulatedWorldOptions) {
  const names = simulatorNames(options.namespace ? `${options.namespace}:` : '');
  const now = options.now ?? (() => new Date());
  const base = options.publicBaseUrl.replace(/\/$/, '');
  const messaging = new PersistentSimulator(
    names.messaging,
    new MessagingSimulator({ businessNumber: options.businessNumber, webhookSecret: options.webhookSecret, webhookUrl: `${base}${WEBHOOK_PATH}`, now }),
    options.store,
  );
  const publishing = new PersistentSimulator(names.publishing, new PublishingSimulator({ now }), options.store);
  const payment = new PersistentSimulator(
    names.payment,
    new PaymentSimulator({
      now,
      webhookSecret: options.webhookSecret,
      webhookUrl: `${base}${PAYMENT_WEBHOOK_PATH}`,
      ...(options.sandboxUrl ? { checkoutBaseUrl: options.sandboxUrl } : {}),
    }),
    options.store,
  );
  return { names, messaging, publishing, payment, media: storeMedia(options.store, base, names.media) };
}

export type SimulatedWorld = ReturnType<typeof simulatedWorld>;

/** File storage on the store, standing in for Cloud Storage in dev; URLs are `<public base>/media/<path>`. */
export function storeMedia(store: SimulatorStore, publicBaseUrl: string, prefix: string) {
  const base = `${publicBaseUrl}/media/`;
  const pathOf = (ref: string) => (ref.startsWith(base) ? ref.slice(base.length) : ref);
  return {
    async put(path: string, bytes: Uint8Array, mimeType: string) {
      await store.putFile(prefix + path, bytes, mimeType);
    },
    urlFor: (path: string) => base + path,
    /** By storage path or by URL. */
    async read(ref: string) {
      return store.getFile(prefix + pathOf(ref));
    },
    async removePrefix(path: string) {
      await store.removeFiles({ prefix: prefix + path });
    },
    async remove(paths: string[]) {
      await store.removeFiles({ paths: paths.map((p) => prefix + p) });
    },
  };
}

export interface SimulatedAppOptions extends SimulatedWorldOptions {
  databaseUrls: DatabaseUrls;
  /** Defaults to the conversational model simulator (POSTLY_MODELS=simulator). */
  models?: Record<string, ModelProvider>;
  burstQuietMs?: number;
  /** The durable burst wake (T2): pg-boss in web and worker; tests may leave it out. */
  burstWake?: AppOptions['burstWake'];
  logger?: AppOptions['logger'];
}

/** The app on the simulated world: what main.ts runs as web or worker in simulated mode. */
export async function createSimulatedApp(options: SimulatedAppOptions) {
  const world = simulatedWorld(options);
  const db = createDatabase(options.databaseUrls);
  if (!(await world.media.read(SAMPLE_PHOTO_PATH))) {
    await world.media.put(SAMPLE_PHOTO_PATH, placeholderPng(1080, 1080, [246, 232, 210], [150, 82, 40]), 'image/png');
  }
  const design = createDesignRenderer({
    assets: {
      load: async (url) => {
        const file = await world.media.read(url);
        if (!file) throw new Error(`no stored file at ${url}`);
        return file.data;
      },
    },
    store: { put: (path, bytes, mimeType) => world.media.put(path, bytes, mimeType) },
  });
  const app = createApp({
    db,
    providers: {
      messaging: world.messaging.provider,
      publishing: world.publishing.provider,
      models: options.models ?? { google: conversationalModelSimulator() },
      payment: world.payment.provider,
    },
    design,
    media: world.media,
    businessNumber: options.businessNumber,
    samplePhotoUrl: world.media.urlFor(SAMPLE_PHOTO_PATH),
    ...(options.burstQuietMs === undefined ? {} : { burstQuietMs: options.burstQuietMs }),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.burstWake ? { burstWake: options.burstWake } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    app,
    world,
    db,
    close: async () => {
      await design.close();
      await db.close();
    },
  };
}

export interface SimulatedProcessOptions extends SimulatedAppOptions {
  role: 'web' | 'worker';
  /** Web only: the port to listen on (0 picks one). */
  port?: number;
  /** Web only: sweep unprocessed inbound messages (default true; off when tests share the database). */
  sweep?: boolean;
}

export interface SimulatedProcess {
  app: App;
  world: SimulatedWorld;
  /** Web only: where the server listens. */
  url?: string;
  close(): Promise<void>;
}

/**
 * A web or worker process in simulated mode, in-process, for the end-to-end test: web serves the real
 * webhook routes over HTTP; the worker's jobs are called by the test (pg-boss schedules them in dev).
 */
export async function startSimulatedProcess(options: SimulatedProcessOptions): Promise<SimulatedProcess> {
  const composed = await createSimulatedApp(options);
  if (options.role === 'worker') return { app: composed.app, world: composed.world, close: composed.close };
  const { app } = composed;
  const server = buildServer({ messaging: app.messaging, ...(app.billing ? { billing: app.billing } : {}), publicBaseUrl: options.publicBaseUrl });
  const stopSweep = options.sweep === false ? () => {} : app.start();
  await server.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('web did not start');
  return {
    app,
    world: composed.world,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      stopSweep();
      await server.close();
      await composed.close();
    },
  };
}
