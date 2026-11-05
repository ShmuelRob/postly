import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestIap, TEST_IAP_AUDIENCE } from '../../../test/e2e/harness/iap.js';
import { createIapVerifier, IapAssertionError, IAP_ISSUER } from './iap.js';

// The console checks IAP's signed header itself (docs/security.md, "Console exposure"): signature,
// issuer, audience, expiry and an email. Anything else is refused.

const iap = createTestIap();
const verifierFor = (keys = iap.keys, now?: () => number) =>
  createIapVerifier({ audience: TEST_IAP_AUDIENCE, fetchKeys: async () => keys, ...(now ? { now } : {}) });

async function refusal(verify: Promise<unknown>): Promise<string> {
  const error = await verify.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IapAssertionError);
  return (error as IapAssertionError).reason;
}

describe('IAP assertion', () => {
  it('accepts a token IAP signed for this backend and returns the email', async () => {
    expect(IAP_ISSUER).toBe('https://cloud.google.com/iap');
    const identity = await verifierFor().verify(iap.assertion('dana@postly.test'));
    expect(identity.email).toBe('dana@postly.test');
    expect(identity.subject).toMatch(/^accounts\.google\.com:/);
  });

  it('refuses another audience (a token IAP issued for a different backend)', async () => {
    const token = iap.assertion(undefined, { claims: { aud: '/projects/1/global/backendServices/2' } });
    expect(await refusal(verifierFor().verify(token))).toBe('audience');
  });

  it('refuses another issuer', async () => {
    const token = iap.assertion(undefined, { claims: { iss: 'https://accounts.google.com' } });
    expect(await refusal(verifierFor().verify(token))).toBe('issuer');
  });

  it('refuses an expired token, and allows 30 seconds of clock skew', async () => {
    const issued = 1_800_000_000;
    const token = iap.assertion(undefined, { now: issued });
    const at = (seconds: number) => () => seconds * 1000;
    expect((await verifierFor(iap.keys, at(issued + 600 + 29)).verify(token)).email).toBe('team@postly.test');
    expect(await refusal(verifierFor(iap.keys, at(issued + 600 + 31)).verify(token))).toBe('expired');
  });

  it('refuses a token issued in the future', async () => {
    const issued = 1_800_000_000;
    const token = iap.assertion(undefined, { now: issued + 120 });
    expect(await refusal(verifierFor(iap.keys, () => issued * 1000).verify(token))).toBe('issued_in_future');
  });

  it('refuses a token signed by another key under the published key id (forged)', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(await refusal(verifierFor().verify(iap.assertion(undefined, { key: privateKey })))).toBe('signature');
  });

  it('refuses a token whose claims were changed after signing', async () => {
    const [header, , signature] = iap.assertion('dana@postly.test').split('.');
    const claims = JSON.parse(Buffer.from(iap.assertion('dana@postly.test').split('.')[1]!, 'base64url').toString());
    const tampered = Buffer.from(JSON.stringify({ ...claims, email: 'mallory@evil.example' })).toString('base64url');
    expect(await refusal(verifierFor().verify(`${header}.${tampered}.${signature}`))).toBe('signature');
  });

  it('refuses any algorithm but ES256, including none', async () => {
    expect(await refusal(verifierFor().verify(iap.assertion(undefined, { header: { alg: 'HS256' } })))).toBe('algorithm');
    const [, claims] = iap.assertion().split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: iap.kid })).toString('base64url')}.${claims}.`;
    expect(await refusal(verifierFor().verify(none))).toBe('algorithm');
  });

  it('refuses a token with no email', async () => {
    expect(await refusal(verifierFor().verify(iap.assertion(undefined, { claims: { email: undefined } })))).toBe('email');
  });

  it('refuses malformed tokens', async () => {
    for (const token of ['', 'abc', 'a.b', 'a.b.c', `${'x'.repeat(10)}.${'y'.repeat(10)}.z`]) {
      expect(await refusal(verifierFor().verify(token)), token).toBe('malformed');
    }
  });

  it('refuses an unknown key id', async () => {
    expect(await refusal(verifierFor().verify(iap.assertion(undefined, { header: { kid: 'other' } })))).toBe('unknown_key');
  });

  it('fetches the keys once, and again for an unknown key id at most once a minute (key rotation)', async () => {
    const rotated = createTestIap('rotated-key');
    let published = iap.keys;
    const fetchKeys = vi.fn(async () => published);
    let now = 1_800_000_000_000;
    const verifier = createIapVerifier({ audience: TEST_IAP_AUDIENCE, fetchKeys, now: () => now });
    const nowSeconds = () => Math.floor(now / 1000);

    await verifier.verify(iap.assertion(undefined, { now: nowSeconds() }));
    await verifier.verify(iap.assertion(undefined, { now: nowSeconds() }));
    expect(fetchKeys).toHaveBeenCalledTimes(1);

    // Google rotates: the new key is not in the cache yet, so it fetches again.
    published = [...iap.keys, ...rotated.keys];
    now += 61_000;
    expect((await verifier.verify(rotated.assertion('new@postly.test', { now: nowSeconds() }))).email).toBe('new@postly.test');
    expect(fetchKeys).toHaveBeenCalledTimes(2);

    // A flood of unknown key ids does not hammer Google's endpoint.
    now += 1_000;
    for (let i = 0; i < 3; i++) {
      expect(await refusal(verifier.verify(iap.assertion(undefined, { header: { kid: `junk-${i}` }, now: nowSeconds() })))).toBe('unknown_key');
    }
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('refetches the keys after an hour', async () => {
    const fetchKeys = vi.fn(async () => iap.keys);
    let now = 1_800_000_000_000;
    const verifier = createIapVerifier({ audience: TEST_IAP_AUDIENCE, fetchKeys, now: () => now });
    await verifier.verify(iap.assertion(undefined, { now: now / 1000 }));
    now += 3_601_000;
    await verifier.verify(iap.assertion(undefined, { now: now / 1000 }));
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('refuses an audience that is not a backend service path', () => {
    expect(() => createIapVerifier({ audience: 'postly-console', fetchKeys: async () => [] })).toThrow(/audience/);
  });
});
