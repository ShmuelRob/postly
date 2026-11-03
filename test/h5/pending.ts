/**
 * The H5 switch. `true` means the package's implementation has not landed, so its human-owned
 * cases run as `it.fails`. WP-33 flips `approval` and WP-34 flips `publishing` in the pull request
 * that makes them pass; `meta.test.ts` refuses a package marked `review` or `done` in
 * docs/implementation-plan.md while its switch is still on. Nothing else here may change.
 */
export const H5_PENDING = {
  approval: true,
  publishing: true,
} as const;

export type H5Package = keyof typeof H5_PENDING;

/** The package that owns each switch. */
export const H5_PACKAGES: Record<H5Package, string> = { approval: 'WP-33', publishing: 'WP-34' };
