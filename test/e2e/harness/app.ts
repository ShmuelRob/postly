import { randomUUID } from 'node:crypto';
import {
  InboundMessage,
  PublishRequest,
  RenderRequest,
  SendButtonsRequest,
  SendTemplateRequest,
  SendTextRequest,
  type ApprovalButtonPayload,
  type MessagingProvider,
  type ModelProvider,
  type PaymentProvider,
  type PublishingProvider,
  type TemplateRenderer,
} from '../../../src/contracts/providers/index.js';
import type { Network } from '../../../src/contracts/common.js';
import type { BusinessRenderContext } from '../../../src/modules/design/index.js';
import { modelTasks, type ModelTaskName } from '../../../src/contracts/model-tasks.js';
import type {
  ConsoleEntry,
  E2eRecord,
  ModelCallEntry, ImageAttachment, PublishingEntry, RenderedImage, TranscriptEntry } from './record.js';

/** Every external service the app talks to. Tests pass simulators (WP-03) or in-test fakes. */
export interface Providers {
  messaging: MessagingProvider;
  publishing: PublishingProvider;
  model: ModelProvider;
  payment: PaymentProvider;
  renderer: TemplateRenderer;
  /** The design module's per-business renderer factory, when the app renders through `forBusiness`. */
  design?: { forBusiness(business: BusinessRenderContext): TemplateRenderer };
}

/** Reads a stored file by storage path or URL so the report can show it. */
export type MediaReader = (ref: string) => Promise<{ mimeType: string; data: Uint8Array } | undefined>;

/**
 * The app as the harness drives it. Until the real composition root exists (WP-22, WP-23), a test
 * supplies its own factory; afterwards the harness's default factory will build the real app.
 */
export interface AppUnderTest {
  /** Hands an inbound WhatsApp message to the app, as the messaging webhook would. */
  deliverInbound(message: InboundMessage): Promise<void>;
  close?(): Promise<void>;
}

export type AppFactory = (providers: Providers) => AppUnderTest | Promise<AppUnderTest>;

export interface StartOptions {
  providers: Providers;
  app: AppFactory;
  /** The owner's (approver's) WhatsApp number. */
  ownerPhone: string;
  /** Postly's WhatsApp number for this business. */
  businessPhone: string;
  readMedia?: MediaReader;
  now?: () => Date;
}

export interface Owner {
  readonly phone: string;
  sendsText(text: string): Promise<void>;
  sendsVoice(providerMediaId: string): Promise<void>;
  sendsImage(providerMediaId: string, caption?: string): Promise<void>;
  /**
   * Taps a button by its title on the latest message that shows it, the way the owner would.
   * Fails if no message sent to the owner shows that button.
   */
  tapsButton(title: string, payload: ApprovalButtonPayload): Promise<void>;
  /** Messages Postly sent to the owner, oldest first. */
  received(): TranscriptEntry[];
  /** The provider delivers this number's last inbound message again, as vendors do on a retry. */
  redeliversLast(): Promise<void>;
}

export interface E2eRun {
  owner: Owner;
  /** Someone writing from another number, such as one no business is registered with. */
  sender(phone: string): Owner;
  /** What reached the publishing provider, oldest first. */
  networkPosts(network?: Network): PublishingEntry[];
  /** Files the renderer produced, oldest first. */
  renders(): RenderedImage[];
  /** Calls that reached the model provider, oldest first. */
  modelCalls(): ModelCallEntry[];
  /** Adds items the team console holds to the report; the test reads them from where the app stored them. */
  recordConsoleItems(items: Omit<ConsoleEntry, 'at'>[]): void;
  close(): Promise<void>;
}

/**
 * Builds the app in-process with recording wrappers around every provider, so the test and the
 * report see exactly what the owner and the networks would see.
 */
export async function startE2eRun(record: E2eRecord, options: StartOptions): Promise<E2eRun> {
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const readMedia = options.readMedia ?? (async () => undefined);
  const attach = async (ref: string): Promise<ImageAttachment> => {
    const media = await readMedia(ref).catch(() => undefined);
    if (!media) return { ref, mimeType: 'unknown' };
    return { ref, mimeType: media.mimeType, src: `data:${media.mimeType};base64,${Buffer.from(media.data).toString('base64')}` };
  };

  const providers: Providers = {
    messaging: recordMessaging(options.providers.messaging, record, now, attach),
    publishing: recordPublishing(options.providers.publishing, record, now, attach),
    model: recordModel(options.providers.model, record, now),
    payment: options.providers.payment,
    renderer: recordRenderer(options.providers.renderer, record, now, attach),
  };
  const design = options.providers.design;
  if (design) providers.design = { forBusiness: (business) => recordRenderer(design.forBusiness(business), record, now, attach) };
  const app = await options.app(providers);

  const makeSender = (phone: string): Owner => {
    let last: InboundMessage | undefined;
    const deliver = async (content: InboundMessage['content'], entry: Omit<TranscriptEntry, 'at' | 'direction' | 'phone'>) => {
      // Unique per run: provider message ids are unique across the whole message table.
      const message = InboundMessage.parse({
        provider: 'e2e-harness',
        providerMessageId: `e2e-in-${randomUUID()}`,
        from: phone,
        to: options.businessPhone,
        receivedAt: now(),
        content,
      });
      last = message;
      record.transcript.push({ at: message.receivedAt, direction: 'from_owner', phone, ...entry });
      await app.deliverInbound(message);
    };
    const sender: Owner = {
      phone,
      sendsText: (text) => deliver({ kind: 'text', text }, { kind: 'text', text }),
      sendsVoice: (providerMediaId) => deliver({ kind: 'voice', providerMediaId }, { kind: 'voice' }),
      sendsImage: async (providerMediaId, caption) => {
        const image = await attach(providerMediaId);
        await deliver(
          caption === undefined ? { kind: 'image', providerMediaId } : { kind: 'image', providerMediaId, caption },
          caption === undefined ? { kind: 'image', image } : { kind: 'image', image, text: caption },
        );
      },
      tapsButton: async (title, payload) => {
        const shown = sender
          .received()
          .flatMap((m) => m.buttons ?? [])
          .reverse()
          .find((b) => b.title === title);
        if (!shown) throw new Error(`${phone} has no button titled "${title}" to tap`);
        await deliver({ kind: 'button_reply', buttonId: shown.id, payload }, { kind: 'button_reply', text: title });
      },
      received: () => record.transcript.filter((m) => m.direction === 'to_owner' && m.phone === phone),
      redeliversLast: async () => {
        if (!last) throw new Error(`${phone} has sent nothing to redeliver`);
        await app.deliverInbound(last);
      },
    };
    return sender;
  };
  const owner = makeSender(options.ownerPhone);

  return {
    owner,
    sender: makeSender,
    networkPosts: (network) => record.publishing.filter((p) => network === undefined || p.network === network),
    renders: () => [...record.renders],
    modelCalls: () => [...(record.modelCalls ?? [])],
    recordConsoleItems: (items) => {
      record.consoleItems ??= [];
      record.consoleItems.push(...items.map((item) => ({ at: now(), ...item })));
    },
    close: async () => {
      await app.close?.();
    },
  };
}

type Attach = (ref: string) => Promise<ImageAttachment>;

function recordModel(inner: ModelProvider, record: E2eRecord, now: () => string): ModelProvider {
  const log = (entry: ModelCallEntry) => (record.modelCalls ??= []).push(entry);
  const structured =
    (method: 'generateStructured' | 'analyzeImage') =>
    async (request: { task: ModelTaskName }) => {
      try {
        const result = await (inner[method] as (r: unknown) => ReturnType<ModelProvider['generateStructured']>)(request);
        const check = modelTasks[request.task].output.safeParse(result.output);
        log({ at: now(), method, task: request.task, output: result.output, valid: check.success, ...(check.success ? {} : { error: check.error.issues.map((i) => i.message).join('; ') }) });
        return result;
      } catch (error) {
        log({ at: now(), method, task: request.task, valid: false, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  return {
    name: inner.name,
    generateStructured: structured('generateStructured'),
    analyzeImage: structured('analyzeImage'),
    async transcribeAudio(request) {
      const result = await inner.transcribeAudio(request);
      log({ at: now(), method: 'transcribeAudio', task: 'transcription', output: result, valid: true });
      return result;
    },
  };
}

function recordMessaging(inner: MessagingProvider, record: E2eRecord, now: () => string, attach: Attach): MessagingProvider {
  return {
    name: inner.name,
    async sendText(request) {
      const req = SendTextRequest.parse(request);
      const result = await inner.sendText(req);
      const entry: TranscriptEntry = { at: now(), direction: 'to_owner', phone: req.to, kind: 'text', text: req.text };
      if (req.mediaUrl) entry.image = await attach(req.mediaUrl);
      record.transcript.push(entry);
      return result;
    },
    async sendTemplate(request) {
      const req = SendTemplateRequest.parse(request);
      const result = await inner.sendTemplate(req);
      const template = { name: req.templateName, language: req.language, variables: req.variables };
      record.transcript.push({ at: now(), direction: 'to_owner', phone: req.to, kind: 'template', template });
      return result;
    },
    async sendButtons(request) {
      const req = SendButtonsRequest.parse(request);
      const result = await inner.sendButtons(req);
      const entry: TranscriptEntry = {
        at: now(),
        direction: 'to_owner',
        phone: req.to,
        kind: 'buttons',
        text: req.text,
        buttons: req.buttons.map((b) => ({ id: b.id, title: b.title })),
      };
      if (req.mediaUrl) entry.image = await attach(req.mediaUrl);
      record.transcript.push(entry);
      return result;
    },
    getMedia: (id) => inner.getMedia(id),
    verifyWebhook: (request) => inner.verifyWebhook(request),
  };
}

function recordPublishing(
  inner: PublishingProvider,
  record: E2eRecord,
  now: () => string,
  attach: Attach,
): PublishingProvider {
  return {
    name: inner.name,
    createConnectionLink: (request) => inner.createConnectionLink(request),
    getConnectionStatus: (request) => inner.getConnectionStatus(request),
    testSchedule: (request) => inner.testSchedule(request),
    async publish(request) {
      const req = PublishRequest.parse(request);
      const entry: PublishingEntry = {
        at: now(),
        network: req.network,
        providerAccountId: req.providerAccountId,
        idempotencyKey: req.idempotencyKey,
        format: req.format,
        scheduledFor: req.scheduledFor,
        caption: req.caption,
        media: await Promise.all(req.mediaUrls.map(attach)),
        outcome: { ok: false, error: 'not finished' },
      };
      record.publishing.push(entry);
      try {
        const result = await inner.publish(req);
        entry.outcome = { ok: true, providerPostId: result.providerPostId };
        return result;
      } catch (error) {
        entry.outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    },
    getPublicationStatus: (id) => inner.getPublicationStatus(id),
    getMetrics: (request) => inner.getMetrics(request),
    disconnectAccount: (request) => inner.disconnectAccount(request),
    // The H5 world connects channels on the simulator itself (test/h5/subject.ts).
    ...('connect' in inner ? { connect: (inner as unknown as { connect: (...args: unknown[]) => unknown }).connect.bind(inner) } : {}),
  };
}

function recordRenderer(inner: TemplateRenderer, record: E2eRecord, now: () => string, attach: Attach): TemplateRenderer {
  return {
    async render(request) {
      const req = RenderRequest.parse(request);
      const result = await inner.render(req);
      for (const network of req.networks) {
        for (const file of result[network] ?? []) {
          record.renders.push({
            at: now(),
            network,
            style: req.style,
            width: file.width,
            height: file.height,
            image: await attach(file.storagePath),
          });
        }
      }
      return result;
    },
  };
}
