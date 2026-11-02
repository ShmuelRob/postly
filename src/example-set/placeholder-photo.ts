import { z } from 'zod';
import { HexColor } from '../contracts/common.js';

// Placeholder photos for the provisional example set, drawn in code so no
// third-party image enters the repository. Output is plain SVG; the design
// engine rasterizes it like any other photo.

export const PLACEHOLDER_MOTIFS = ['circles', 'rings', 'petals', 'stripes', 'dots', 'arches'] as const;

export const PlaceholderSpec = z.object({
  width: z.int().min(320).max(4000),
  height: z.int().min(320).max(4000),
  /** Gradient start, gradient end, and shape color. */
  colors: z.tuple([HexColor, HexColor, HexColor]),
  motif: z.enum(PLACEHOLDER_MOTIFS),
  seed: z.int().min(0),
});
export type PlaceholderSpec = z.infer<typeof PlaceholderSpec>;

/** mulberry32: a small seeded PRNG, so the same spec always gives the same file. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (value: number) => String(Math.round(value * 10) / 10);

function shapes(spec: PlaceholderSpec, next: () => number): string[] {
  const { width: w, height: h } = spec;
  const color = spec.colors[2];
  const min = Math.min(w, h);
  const between = (lo: number, hi: number) => lo + (hi - lo) * next();

  switch (spec.motif) {
    case 'circles':
      return Array.from({ length: 3 }, (_, i) => {
        const r = min * (i === 0 ? between(0.25, 0.35) : between(0.08, 0.15));
        return `<circle cx="${n(between(r, w - r))}" cy="${n(between(r, h - r))}" r="${n(r)}" fill="${color}" fill-opacity="${n(i === 0 ? 0.35 : 0.6)}"/>`;
      });
    case 'rings': {
      const cx = between(w * 0.35, w * 0.65);
      const cy = between(h * 0.35, h * 0.65);
      return Array.from({ length: 5 }, (_, i) => {
        const r = min * (0.1 + i * 0.09);
        return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${color}" stroke-width="${n(min * 0.02)}" stroke-opacity="${n(0.8 - i * 0.12)}"/>`;
      });
    }
    case 'petals': {
      const cx = between(w * 0.4, w * 0.6);
      const cy = between(h * 0.4, h * 0.6);
      const count = 6 + Math.floor(next() * 3);
      const length = min * between(0.16, 0.22);
      const turn = between(0, 360 / count);
      const petals = Array.from({ length: count }, (_, i) => {
        const angle = turn + (360 / count) * i;
        return `<ellipse cx="${n(cx)}" cy="${n(cy - length)}" rx="${n(length * 0.45)}" ry="${n(length)}" fill="${color}" fill-opacity="0.7" transform="rotate(${n(angle)} ${n(cx)} ${n(cy)})"/>`;
      });
      return [...petals, `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(length * 0.35)}" fill="${spec.colors[1]}"/>`];
    }
    case 'stripes': {
      const band = min * between(0.06, 0.1);
      const angle = between(-35, -20);
      const diagonal = Math.hypot(w, h);
      return Array.from({ length: 4 }, (_, i) => {
        const y = h * 0.2 + i * band * 2.4;
        return `<rect x="${n(-diagonal / 2)}" y="${n(y)}" width="${n(diagonal * 2)}" height="${n(band)}" fill="${color}" fill-opacity="${n(0.25 + i * 0.12)}" transform="rotate(${n(angle)} ${n(w / 2)} ${n(h / 2)})"/>`;
      });
    }
    case 'dots':
      return Array.from({ length: 14 }, () => {
        const r = min * between(0.02, 0.06);
        return `<circle cx="${n(between(r, w - r))}" cy="${n(between(r, h - r))}" r="${n(r)}" fill="${color}" fill-opacity="${n(between(0.4, 0.85))}"/>`;
      });
    case 'arches':
      return Array.from({ length: 3 }, (_, i) => {
        const r = min * (0.18 + i * 0.12);
        const cx = w / 2 + between(-w * 0.1, w * 0.1);
        const base = h * 0.85;
        return `<path d="M ${n(cx - r)} ${n(base)} A ${n(r)} ${n(r)} 0 0 1 ${n(cx + r)} ${n(base)}" fill="none" stroke="${color}" stroke-width="${n(min * 0.025)}" stroke-opacity="${n(0.85 - i * 0.2)}" stroke-linecap="round"/>`;
      });
  }
}

export function placeholderPhotoSvg(spec: PlaceholderSpec): string {
  const { width: w, height: h } = spec;
  const next = random(spec.seed);
  const angle = next() * Math.PI * 2;
  const x = (Math.cos(angle) + 1) / 2;
  const y = (Math.sin(angle) + 1) / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    '<defs>',
    `<linearGradient id="bg" x1="${n(1 - x)}" y1="${n(1 - y)}" x2="${n(x)}" y2="${n(y)}">`,
    `<stop offset="0" stop-color="${spec.colors[0]}"/>`,
    `<stop offset="1" stop-color="${spec.colors[1]}"/>`,
    '</linearGradient>',
    '</defs>',
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    ...shapes(spec, next),
    '</svg>',
    '',
  ].join('\n');
}
