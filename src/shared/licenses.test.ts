import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// technical-design.md, Dependency licences: no GPL, LGPL or AGPL package in the lockfile.

const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { license?: string; link?: boolean }>;
};

/**
 * The one exception (technical-design.md): sharp's prebuilt libvips binaries, LGPL-3.0, loaded
 * unmodified as a separate shared library, which LGPL allows.
 */
const ALLOWED = /^node_modules\/@img\/sharp-(libvips-|wasm32)/;

/** A GPL-family licence with no permissive alternative offered by `OR`. */
const copyleftOnly = (license: string) =>
  /\b(A|L)?GPL\b/i.test(license) && !(/\bOR\b/i.test(license) && /\b(MIT|ISC|BSD|Apache)/i.test(license));

describe('dependency licences', () => {
  it('has no copyleft (GPL, LGPL, AGPL) package', () => {
    const copyleft = Object.entries(lock.packages)
      .filter(([path, p]) => path !== '' && !p.link && !ALLOWED.test(path) && copyleftOnly(p.license ?? ''))
      .map(([path, p]) => `${path} (${p.license})`);
    expect(copyleft).toEqual([]);
  });
});
