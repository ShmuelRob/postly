import { describe, expect, it } from 'vitest';
import { describeSimulatorStoreContract } from './contract-suites/simulator-store.js';
import { MessagingSimulator } from './messaging.js';
import { PaymentSimulator } from './payment.js';
import { MemorySimulatorStore } from './persistent.js';
import { PublishingSimulator } from './publishing.js';

describeSimulatorStoreContract('memory', () => new MemorySimulatorStore());

describe('simulator state export and import', () => {
  it('round-trips every simulator through JSON, as the Postgres store keeps it', async () => {
    const messaging = new MessagingSimulator();
    await messaging.sendText({ to: '+972501234567', text: 'שלום' });
    const id = messaging.addMedia('audio/ogg', new Uint8Array([1, 2]));
    messaging.inboundText('+972501234567', 'היי');
    const copy = new MessagingSimulator();
    copy.importState(JSON.parse(JSON.stringify(messaging.exportState())));
    expect(copy.sent).toEqual(messaging.sent);
    expect(await copy.getMedia(id)).toEqual({ mimeType: 'audio/ogg', data: new Uint8Array([1, 2]) });

    const publishing = new PublishingSimulator();
    await publishing.createConnectionLink({ businessId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', networks: ['facebook'] });
    const pubCopy = new PublishingSimulator();
    pubCopy.importState(JSON.parse(JSON.stringify(publishing.exportState())));
    expect(pubCopy.connectionLinks).toEqual(publishing.connectionLinks);
    expect(await pubCopy.getConnectionStatus({ businessId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', network: 'facebook' })).toEqual({ status: 'pending' });

    const payment = new PaymentSimulator();
    const link = await payment.createPaymentLink({ businessId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', plan: 'basic', price: { amountAgorot: 30000, currency: 'ILS' } });
    const sub = payment.completePayment(link.providerCustomerId);
    const payCopy = new PaymentSimulator();
    payCopy.importState(JSON.parse(JSON.stringify(payment.exportState())));
    expect(await payCopy.getSubscriptionStatus(sub)).toEqual({ status: 'active' });
    // Ids keep counting from where the other process stopped.
    expect((await payCopy.createPaymentLink({ businessId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', plan: 'basic', price: { amountAgorot: 30000, currency: 'ILS' } })).providerCustomerId).not.toBe(
      link.providerCustomerId,
    );
  });
});
