import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/**
 * Verifies the signed header Identity-Aware Proxy adds to every request it lets through to the
 * console (docs/security.md, "Console exposure"). The console checks it itself even though only the
 * load balancer can reach the service: a mistake in ingress or IAM must not open the console, and
 * the email in it is the actor of every console action (D4).
 */

export const IAP_HEADER = 'x-goog-iap-jwt-assertion';
export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
/** `/projects/<project number>/global/backendServices/<backend service id>`. */
export const IAP_AUDIENCE_PATTERN = /^\/projects\/\d+\/global\/backendServices\/\d+$/;

const CLOCK_SKEW_SECONDS = 30;
const KEYS_MAX_AGE_MS = 60 * 60_000;
const UNKNOWN_KEY_REFETCH_MS = 60_000;

/** One of Google's published IAP keys (a JWK with its key id). */
export type IapPublicKey = JsonWebKey & { kid?: string; alg?: string; use?: string };

export interface IapIdentity {
  email: string;
  /** IAP's stable user id, `accounts.google.com:<id>`. */
  subject: string;
}

export interface IapVerifier {
  /** The identity in a valid assertion; throws `IapAssertionError` for anything else. */
  verify(assertion: string): Promise<IapIdentity>;
}

export type IapRefusal = 'malformed' | 'algorithm' | 'unknown_key' | 'signature' | 'issuer' | 'audience' | 'expired' | 'issued_in_future' | 'email';

export class IapAssertionError extends Error {
  constructor(readonly reason: IapRefusal) {
    super(`IAP assertion refused: ${reason}`);
    this.name = 'IapAssertionError';
  }
}

export interface IapVerifierOptions {
  audience: string;
  /** Google's published keys; defaults to fetching `IAP_KEYS_URL`. */
  fetchKeys?: () => Promise<IapPublicKey[]>;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

const Header = z.object({ alg: z.string(), kid: z.string().min(1) });
const Claims = z.object({
  iss: z.string(),
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
  sub: z.string().min(1),
  email: z.string().min(3).optional(),
});
const Jwks = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }).loose()) });

export async function fetchIapKeys(): Promise<IapPublicKey[]> {
  const res = await fetch(IAP_KEYS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`IAP keys: HTTP ${res.status}`);
  return Jwks.parse(await res.json()).keys as IapPublicKey[];
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createIapVerifier(options: IapVerifierOptions): IapVerifier {
  if (!IAP_AUDIENCE_PATTERN.test(options.audience)) {
    throw new Error(`IAP audience must be /projects/<number>/global/backendServices/<id>, got ${JSON.stringify(options.audience)}`);
  }
  const fetchKeys = options.fetchKeys ?? fetchIapKeys;
  const now = options.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | undefined;

  const refresh = () =>
    (inflight ??= (async () => {
      try {
        const published = await fetchKeys();
        const next = new Map<string, KeyObject>();
        for (const jwk of published) {
          if (typeof jwk.kid === 'string') next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        }
        keys = next;
        fetchedAt = now();
      } finally {
        inflight = undefined;
      }
    })());

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (now() - fetchedAt > KEYS_MAX_AGE_MS) await refresh();
    if (!keys.has(kid) && now() - fetchedAt > UNKNOWN_KEY_REFETCH_MS) await refresh();
    return keys.get(kid);
  }

  return {
    async verify(assertion) {
      const parts = assertion.split('.');
      if (parts.length !== 3 || !parts[0] || !parts[1]) throw new IapAssertionError('malformed');
      const [rawHeader, rawClaims, rawSignature] = parts as [string, string, string];
      const header = Header.safeParse(decodeJson(rawHeader));
      const claims = Claims.safeParse(decodeJson(rawClaims));
      if (!header.success || !claims.success) throw new IapAssertionError('malformed');
      if (header.data.alg !== 'ES256') throw new IapAssertionError('algorithm');

      const key = await keyFor(header.data.kid);
      if (!key) throw new IapAssertionError('unknown_key');
      const signature = Buffer.from(rawSignature, 'base64url');
      const signed = Buffer.from(`${rawHeader}.${rawClaims}`);
      if (signature.length !== 64 || !verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)) {
        throw new IapAssertionError('signature');
      }

      const c = claims.data;
      const seconds = now() / 1000;
      if (c.iss !== IAP_ISSUER) throw new IapAssertionError('issuer');
      if (c.aud !== options.audience) throw new IapAssertionError('audience');
      if (c.exp + CLOCK_SKEW_SECONDS < seconds) throw new IapAssertionError('expired');
      if (c.iat - CLOCK_SKEW_SECONDS > seconds) throw new IapAssertionError('issued_in_future');
      if (!c.email) throw new IapAssertionError('email');
      return { email: c.email, subject: c.sub };
    },
  };
}
