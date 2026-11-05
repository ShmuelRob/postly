/**
 * Fastify's trustProxy for a fixed number of proxy hops in front of the process (docs/security.md, D8).
 * A plain number is refused by this Fastify version (it fails closed), so the hops are a function:
 * the socket peer and the next `hops - 1` X-Forwarded-For entries are trusted, nothing to their left.
 * The resulting IP is for logs and limits only, never for authentication.
 */
export function trustHops(hops: number | undefined): { trustProxy?: (address: string, hop: number) => boolean } {
  if (!hops) return {};
  return { trustProxy: (_address, hop) => hop < hops };
}
