// A self-contained test fixture for the design engine: placeholder photos and logos
// drawn as SVG in code, so no third-party images enter the repository.
// It is not the example set (WP-10); it only exercises the renderer.

import type { AssetLoader, FileStore } from '../engine.js';

const FIXTURE_ORIGIN = 'https://fixtures.postly.test';

function photo(width: number, height: number, from: string, to: string, shapes: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
}

/** Fixture assets keyed by URL. Landscape, portrait, and square photos exercise the cover crop. */
export const fixtureAssets: Record<string, string> = {
  [`${FIXTURE_ORIGIN}/photo-landscape.svg`]: photo(
    1600,
    1200,
    '#F7B2C4',
    '#7A3E9D',
    `<circle cx="800" cy="600" r="260" fill="#FFE3EC" opacity="0.85"/>
     <circle cx="1240" cy="320" r="120" fill="#FFD166"/>
     <rect x="160" y="820" width="380" height="240" rx="40" fill="#3D2C5E" opacity="0.6"/>`,
  ),
  [`${FIXTURE_ORIGIN}/photo-portrait.svg`]: photo(
    1200,
    1600,
    '#FCE7C8',
    '#C96F3B',
    `<rect x="300" y="420" width="600" height="760" rx="300" fill="#FFF6EA" opacity="0.8"/>
     <circle cx="600" cy="800" r="150" fill="#8C4A2F"/>`,
  ),
  [`${FIXTURE_ORIGIN}/photo-square.svg`]: photo(
    1500,
    1500,
    '#B8E1DD',
    '#2E6F6A',
    `<polygon points="750,240 1200,1180 300,1180" fill="#E9F7F5" opacity="0.8"/>
     <circle cx="750" cy="900" r="120" fill="#F28F3B"/>`,
  ),
  [`${FIXTURE_ORIGIN}/logo.svg`]: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
    <circle cx="200" cy="200" r="190" fill="#1F3A5F"/>
    <path d="M200 90 C260 150 260 250 200 310 C140 250 140 150 200 90 Z" fill="#F4D35E"/></svg>`,
  [`${FIXTURE_ORIGIN}/logo-small.svg`]: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60">
    <rect width="100" height="60" rx="12" fill="#1F3A5F"/></svg>`,
};

export const fixtureUrls = {
  landscape: `${FIXTURE_ORIGIN}/photo-landscape.svg`,
  portrait: `${FIXTURE_ORIGIN}/photo-portrait.svg`,
  square: `${FIXTURE_ORIGIN}/photo-square.svg`,
  logo: `${FIXTURE_ORIGIN}/logo.svg`,
  logoSmall: `${FIXTURE_ORIGIN}/logo-small.svg`,
};

/** The fixture business: a fictional Hebrew florist. */
export const fixtureBusiness = {
  businessName: 'פרחי הגן',
  languages: ['he' as const],
  storagePrefix: 'test/renders',
};

/** 35 characters, two lines in every style. */
export const fixtureOverlayText = 'מבצע סוף שבוע: 20% הנחה על כל הזרים';

export function fixtureAssetLoader(): AssetLoader {
  return {
    async load(url) {
      const svg = fixtureAssets[url];
      if (svg === undefined) throw new Error(`No fixture asset at ${url}`);
      return new TextEncoder().encode(svg);
    },
  };
}

export function memoryFileStore(): FileStore & { files: Map<string, { bytes: Uint8Array; mimeType: string }> } {
  const files = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  return {
    files,
    async put(path, bytes, mimeType) {
      files.set(path, { bytes, mimeType });
    },
  };
}
