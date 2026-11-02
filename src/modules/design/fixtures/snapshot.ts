// Image snapshots for the renderer. Baselines live in ../__snapshots__/ and are
// compared with a pixel tolerance, since glyph anti-aliasing differs slightly
// between operating systems. Every run also writes its output to test-output/design/.
//
// Update the baselines with: UPDATE_DESIGN_SNAPSHOTS=1 npx vitest run src/modules/design

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffImages } from '../adapters/image-diff.js';

const snapshotDir = fileURLToPath(new URL('../__snapshots__/', import.meta.url));
const outputDir = fileURLToPath(new URL('../../../../test-output/design/', import.meta.url));

/** A pixel counts as different when a channel differs by more than this. */
const CHANNEL_TOLERANCE = 48;
/** The share of pixels that may differ before a snapshot fails. */
const MAX_DIFF_RATIO = 0.02;

export type SnapshotResult = { ok: true } | { ok: false; reason: string };

export async function matchImageSnapshot(name: string, jpeg: Uint8Array): Promise<SnapshotResult> {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}${name}.jpg`, jpeg);

  const baseline = `${snapshotDir}${name}.jpg`;
  const update = process.env.UPDATE_DESIGN_SNAPSHOTS === '1';
  if (update || !existsSync(baseline)) {
    if (!update && process.env.CI) return { ok: false, reason: `missing baseline ${name}.jpg` };
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(baseline, jpeg);
    return { ok: true };
  }

  const diff = await diffImages(readFileSync(baseline), jpeg, CHANNEL_TOLERANCE);
  if (diff.sizeMismatch) return { ok: false, reason: `${name}: size changed` };
  if (diff.ratio > MAX_DIFF_RATIO) {
    return { ok: false, reason: `${name}: ${(diff.ratio * 100).toFixed(2)}% of pixels differ` };
  }
  return { ok: true };
}
