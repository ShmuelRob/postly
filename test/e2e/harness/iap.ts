import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { IapPublicKey } from '../../../src/modules/console/index.js';

/**
 * A stand-in for Google's IAP signing keys, for unit and end-to-end tests of the console sign-in
 * (docs/security.md, "Console exposure"). It signs `x-goog-iap-jwt-assertion` values the way IAP
 * does (ES256, a `kid` header) with a key pair made per test run.
 */

export const TEST_IAP_AUDIENCE = '/projects/123456789012/global/backendServices/4567890123456789';
export const TEST_IAP_ISSUER = 'https://cloud.google.com/iap';

export interface AssertionOptions {
  /** Claims to set or override; `undefined` removes a claim. */
  claims?: Record<string, unknown>;
  /** Header overrides, for example another `kid` or `alg`. */
  header?: Record<string, unknown>;
  /** Sign with this key instead of the published one (a forged token). */
  key?: KeyObject;
  /** Seconds since the epoch used for `iat` and `exp`; defaults to now. */
  now?: number;
}

export interface TestIap {
  kid: string;
  /** The published keys, as Google's JWK endpoint returns them. */
  keys: IapPublicKey[];
  assertion(email?: string, options?: AssertionOptions): string;
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export function createTestIap(kid = 'test-iap-key'): TestIap {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk: IapPublicKey = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
  return {
    kid,
    keys: [jwk],
    assertion(email = 'team@postly.test', options = {}) {
      const now = options.now ?? Math.floor(Date.now() / 1000);
      const header = { alg: 'ES256', typ: 'JWT', kid, ...options.header };
      const claims: Record<string, unknown> = {
        iss: TEST_IAP_ISSUER,
        aud: TEST_IAP_AUDIENCE,
        iat: now,
        exp: now + 600,
        sub: `accounts.google.com:${Buffer.from(email).toString('hex').slice(0, 16)}`,
        email,
        ...options.claims,
      };
      for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
      const signature = sign('sha256', Buffer.from(input), { key: options.key ?? privateKey, dsaEncoding: 'ieee-p1363' });
      return `${input}.${b64url(signature)}`;
    },
  };
}
